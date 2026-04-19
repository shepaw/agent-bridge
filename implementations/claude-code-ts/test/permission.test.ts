import { describe, expect, it } from 'vitest';

import { ApprovalCache, PendingApprovals } from '../src/approval-cache.js';
import { makeCanUseTool } from '../src/permission.js';

/**
 * Hand-rolled TaskContext double for the non-blocking permission flow.
 *
 * The new protocol has the gateway *fire-and-forget* a UI component
 * (ui.actionConfirmation or ui.form) and then immediately return
 * `{behavior: 'deny', ...}` to the Agent SDK so the current turn ends.
 * No `waitForResponse` round-trip happens here — the user's reply
 * arrives later as a plain `agent.chat` message and the gateway writes
 * the verdict into the ApprovalCache. On the next turn, `canUseTool`
 * sees a cache hit and short-circuits to `allow`.
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

// canUseTool returns a narrowed shape we don't have nominal types for; use
// `any` here rather than re-declare @anthropic-ai/claude-agent-sdk's internals.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CanUseTool = (toolName: string, input: Record<string, unknown>) => Promise<any>;

function makeHarness() {
  const ctx = new FakeCtx();
  const cache = new ApprovalCache();
  const pending = new PendingApprovals();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const can = makeCanUseTool(ctx as any, {
    sessionId: ctx.sessionId,
    cache,
    pending,
  }) as CanUseTool;
  return { ctx, cache, pending, can };
}

describe('makeCanUseTool — ordinary tool approval (non-blocking)', () => {
  it('on cache miss, sends ui.actionConfirmation, records pending, and denies the turn', async () => {
    const { ctx, pending, can } = makeHarness();

    const decision = await can('Bash', { command: 'ls -la' });

    // Exactly one ui.actionConfirmation emitted.
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.method).toBe('ui.actionConfirmation');
    const args = ctx.sent[0]!.args as {
      prompt: string;
      actions: Array<{ value: string }>;
    };
    expect(args.prompt).toContain('Bash');
    expect(args.prompt).toContain('ls -la');
    // Only two actions in v1 (allow_always is not yet wired up).
    expect(args.actions.map((a) => a.value)).toEqual(['allow', 'deny']);

    // SDK is told to deny so the turn ends — user will reply later.
    expect(decision.behavior).toBe('deny');
    expect(typeof decision.message).toBe('string');

    // A pending approval is now tracked for this session.
    const top = pending.peekMostRecent('s-test');
    expect(top?.toolName).toBe('Bash');
    expect(top?.input).toEqual({ command: 'ls -la' });
  });

  it('on cache hit (allow), skips the UI and returns allow immediately', async () => {
    const { ctx, cache, can } = makeHarness();
    cache.set('s-test', 'Bash', { command: 'ls -la' }, 'allow', 'prompt', 'user msg');

    const decision = await can('Bash', { command: 'ls -la' });

    expect(ctx.sent).toHaveLength(0);
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
  });

  it('on cache hit (deny), skips the UI and returns deny with user message', async () => {
    const { ctx, cache, can } = makeHarness();
    cache.set('s-test', 'Edit', { file_path: '/a' }, 'deny', 'prompt', 'user msg');

    const decision = await can('Edit', { file_path: '/a' });

    expect(ctx.sent).toHaveLength(0);
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/denied/i);
  });
});

describe('makeCanUseTool — AskUserQuestion branch (non-blocking)', () => {
  it('packs all questions into a single ui.form with radio_group / checkbox_group fields and denies the turn', async () => {
    const { ctx, can } = makeHarness();

    const decision = await can('AskUserQuestion', {
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
    });

    // One form, two fields — not two separate select notifications.
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.method).toBe('ui.form');
    const args = ctx.sent[0]!.args as {
      fields: Array<{ type: string; label: string; options: unknown[] }>;
    };
    expect(args.fields).toHaveLength(2);
    expect(args.fields[0]?.type).toBe('radio_group');
    expect(args.fields[0]?.label).toBe('Which language?');
    expect(args.fields[1]?.type).toBe('checkbox_group');

    // Turn is ended; user will fill the form and reply with a plain chat message.
    expect(decision.behavior).toBe('deny');
  });
});
