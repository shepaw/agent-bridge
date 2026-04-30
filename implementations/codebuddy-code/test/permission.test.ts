import { describe, expect, it } from 'vitest';

import { ApprovalCache, PendingConfirmations, makeCanUseTool } from 'shepaw-acp-sdk';

/**
 * Blocking permission flow tests.
 *
 * The gateway now holds the SDK turn open: `canUseTool` fires a UI
 * component AND awaits `PendingConfirmations.wait(...)`. The user's
 * reply (simulated here via `resolveAll`) unblocks the Promise and
 * the SDK turn continues.
 */

class FakeCtx {
  readonly sent: Array<{ method: string; args: Record<string, unknown> }> = [];
  readonly taskId = 't-test';
  readonly sessionId = 's-test';

  async sendActionConfirmation(opts: {
    prompt: string;
    actions: Array<{ label: string; value: string }>;
    confirmationId?: string;
  }): Promise<string> {
    const id = opts.confirmationId ?? `confirm_${this.sent.length}`;
    this.sent.push({
      method: 'ui.actionConfirmation',
      args: { prompt: opts.prompt, actions: opts.actions, confirmationId: id },
    });
    return id;
  }

  async sendForm(opts: {
    title: string;
    description?: string;
    fields: Array<Record<string, unknown>>;
    formId?: string;
  }): Promise<string> {
    const id = opts.formId ?? `form_${this.sent.length}`;
    this.sent.push({
      method: 'ui.form',
      args: {
        title: opts.title,
        description: opts.description,
        fields: opts.fields,
        formId: id,
      },
    });
    return id;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any>;

function makeHarness() {
  const ctx = new FakeCtx();
  const cache = new ApprovalCache();
  const pending = new PendingConfirmations();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const can = makeCanUseTool(ctx as any, {
    sessionId: ctx.sessionId,
    cache,
    pending,
  }) as CanUseTool;
  return { ctx, cache, pending, can };
}

describe('makeCanUseTool — blocking ordinary tool approval', () => {
  it('on cache miss, sends ui.actionConfirmation, blocks until resolveAll(allow)', async () => {
    const { ctx, pending, can } = makeHarness();
    const abort = new AbortController();

    const decisionP = can('Bash', { command: 'ls -la' }, { signal: abort.signal });

    // Let the confirmation actually get sent before we resolve.
    await new Promise((r) => setImmediate(r));
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.method).toBe('ui.actionConfirmation');
    const args = ctx.sent[0]!.args as {
      prompt: string;
      actions: Array<{ value: string }>;
    };
    expect(args.prompt).toContain('Bash');
    expect(args.prompt).toContain('ls -la');
    expect(args.actions.map((a) => a.value)).toEqual(['allow', 'deny']);

    // Still waiting.
    expect(pending.size('s-test')).toBe(1);

    // User replies "allow" → resolveAll.
    const resolved = pending.resolveAll('s-test', 'allow');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.toolName).toBe('Bash');

    const decision = await decisionP;
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
    expect(pending.size('s-test')).toBe(0);
  });

  it('on resolveAll(deny), the blocked canUseTool returns deny', async () => {
    const { pending, can } = makeHarness();
    const abort = new AbortController();

    const decisionP = can('Write', { file_path: '/a' }, { signal: abort.signal });
    await new Promise((r) => setImmediate(r));

    pending.resolveAll('s-test', 'deny');
    const decision = await decisionP;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/denied/i);
  });

  it('on cache hit (allow), skips the UI and returns allow immediately', async () => {
    const { ctx, cache, can } = makeHarness();
    cache.set('s-test', 'Bash', { command: 'ls -la' }, 'allow', 'prompt', 'user msg');

    const decision = await can(
      'Bash',
      { command: 'ls -la' },
      { signal: new AbortController().signal },
    );

    expect(ctx.sent).toHaveLength(0);
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
  });

  it('on cache hit (deny), skips the UI and returns deny immediately', async () => {
    const { ctx, cache, can } = makeHarness();
    cache.set('s-test', 'Edit', { file_path: '/a' }, 'deny', 'prompt', 'user msg');

    const decision = await can(
      'Edit',
      { file_path: '/a' },
      { signal: new AbortController().signal },
    );

    expect(ctx.sent).toHaveLength(0);
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/denied/i);
  });

  it('on task cancel (abort signal), the blocked canUseTool returns deny', async () => {
    const { can } = makeHarness();
    const abort = new AbortController();

    const decisionP = can('Bash', { command: 'x' }, { signal: abort.signal });
    await new Promise((r) => setImmediate(r));

    abort.abort();
    const decision = await decisionP;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/cancel/i);
  });
});

describe('makeCanUseTool — blocking AskUserQuestion', () => {
  it('packs all questions into a single ui.form and blocks until resolved', async () => {
    const { ctx, pending, can } = makeHarness();
    const abort = new AbortController();

    const decisionP = can(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which language?',
            header: 'Lang',
            options: [
              { label: 'TypeScript', description: 'TS' },
              { label: 'Python', description: 'PY' },
            ],
            multiSelect: false,
          },
          {
            question: 'Pick sections',
            header: 'Secs',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
            multiSelect: true,
          },
        ],
      },
      { signal: abort.signal },
    );
    await new Promise((r) => setImmediate(r));

    // One form, two fields.
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.method).toBe('ui.form');
    const args = ctx.sent[0]!.args as {
      fields: Array<{ type: string; label: string; options: unknown[] }>;
    };
    expect(args.fields).toHaveLength(2);
    expect(args.fields[0]?.type).toBe('radio_group');
    expect(args.fields[0]?.label).toBe('Which language?');
    expect(args.fields[1]?.type).toBe('checkbox_group');

    // Still blocked.
    expect(pending.size('s-test')).toBe(1);

    // User submits form → agent calls resolveAllWith.
    pending.resolveAllWith('s-test', (p) => ({
      behavior: 'allow',
      updatedInput: { ...p.input, answers: { _raw: 'Lang: TypeScript' } },
    }));

    const decision = await decisionP;
    expect(decision.behavior).toBe('allow');
    expect((decision.updatedInput as { answers: { _raw: string } }).answers._raw).toBe(
      'Lang: TypeScript',
    );
  });
});
