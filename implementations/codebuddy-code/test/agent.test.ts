/**
 * End-to-end agent tests without hitting the CodeBuddy API.
 *
 * We mock `@tencent-ai/agent-sdk` so `query()` becomes a programmable
 * async generator. Then we spin up a real CodeBuddyCodeAgent on an
 * ephemeral port and drive it with a real WebSocket client, exercising
 * the full pipeline: JSON-RPC dispatch → onChat → SDK message handling
 * → ui.* notifications → task.completed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

// ── Mock setup BEFORE importing the agent ─────────────────────────

/**
 * Scenario describes what `query()` should emit for each call and what
 * the `canUseTool` callback (if invoked) should return.
 */
interface Scenario {
  /** SDK messages to yield from `query()`, in order. */
  messages: unknown[];
  /** Called with (toolName, input) for every canUseTool request. */
  onCanUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Records how many times query() was invoked and with what options. */
  calls: Array<{
    prompt: unknown;
    options: Record<string, unknown>;
  }>;
}

const scenario: Scenario = { messages: [], calls: [] };

vi.mock('@tencent-ai/agent-sdk', () => {
  return {
    query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
      scenario.calls.push({ prompt: params.prompt, options: params.options });

      // Allow the test to call canUseTool (if provided) as the mock streams.
      const canUseTool = params.options.canUseTool as
        | ((
            toolName: string,
            input: Record<string, unknown>,
            extra: { signal: AbortSignal },
          ) => Promise<unknown>)
        | undefined;

      async function* gen() {
        for (const msg of scenario.messages) {
          // If the test supplied an onCanUseTool hook, call canUseTool
          // exactly once BEFORE yielding the first tool_use message, so
          // assertions can verify both sides.
          const m = msg as { _triggerCanUseTool?: { toolName: string; input: Record<string, unknown> } };
          if (m._triggerCanUseTool !== undefined && canUseTool !== undefined) {
            const result = await canUseTool(
              m._triggerCanUseTool.toolName,
              m._triggerCanUseTool.input,
              { signal: new AbortController().signal },
            );
            if (scenario.onCanUseTool !== undefined) {
              await scenario.onCanUseTool(m._triggerCanUseTool.toolName, m._triggerCanUseTool.input);
            }
            // Record result just so unused-var lint is happy; not asserted.
            void result;
            // Don't yield this synthetic marker — skip to next real message.
            continue;
          }
          yield msg;
        }
      }
      return gen();
    },
  };
});

// Import AFTER vi.mock so the agent picks up the mocked module.
import { CodeBuddyCodeAgent } from '../src/agent.js';

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let storePath: string;
let agent: CodeBuddyCodeAgent | undefined;
let port: number;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'shepaw-gateway-test-'));
  storePath = join(tmpDir, 'sessions.json');
  scenario.messages = [];
  scenario.calls = [];
  scenario.onCanUseTool = undefined;
});

afterEach(async () => {
  if (agent !== undefined) {
    await agent.close().catch(() => undefined);
    agent = undefined;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

async function startAgent(): Promise<void> {
  agent = new CodeBuddyCodeAgent({
    name: 'Test CB',
    token: '',
    cwd: tmpDir,
    sessionStoreOptions: { path: storePath },
  });
  await agent.init();
  // Bind to an ephemeral port.
  await agent.run({ host: '127.0.0.1', port: 0 });
  // Peek at the underlying HTTP server to learn the chosen port.
  // ACPAgentServer keeps it private; we probe via a short-lived connect
  // instead. Reuse the field via `Reflect` for test purposes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const http = (agent as any).httpServer as { address(): AddressInfo };
  port = http.address().port;
}

class TestClient {
  private readonly ws: WebSocket;
  private readonly messages: Array<Record<string, unknown>> = [];
  private nextId = 1;

  constructor(p: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${p}/acp/ws`);
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString('utf-8')) as Record<string, unknown>);
    });
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(method: string, params?: Record<string, unknown>): number {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return id;
  }

  async waitFor(
    pred: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const existing = this.messages.find(pred);
    if (existing !== undefined) return existing;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Client.waitFor timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
        if (pred(msg)) {
          clearTimeout(timer);
          this.ws.off('message', handler);
          resolve(msg);
        }
      };
      this.ws.on('message', handler);
    });
  }

  async close(): Promise<void> {
    this.ws.close();
  }

  get allMessages(): ReadonlyArray<Record<string, unknown>> {
    return this.messages;
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('CodeBuddyCodeAgent (mocked SDK)', () => {
  it('getCard works without hitting CodeBuddy', async () => {
    await startAgent();
    const client = new TestClient(port);
    await client.ready();
    const id = client.send('agent.getCard');
    const resp = await client.waitFor((m) => m.id === id);
    expect(resp.result).toMatchObject({
      name: 'Test CB',
      capabilities: expect.arrayContaining([
        'code_editing',
        'bash_execution',
        'interactive_messages',
      ]),
    });
    await client.close();
  });

  it('streams a pure text turn end-to-end', async () => {
    scenario.messages = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-session-42',
        cwd: '/',
        tools: [],
        mcp_servers: [],
        model: 'codebuddy-fake',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello from mocked CodeBuddy.' }],
        },
      },
      { type: 'result', subtype: 'success' },
    ];

    await startAgent();
    const client = new TestClient(port);
    await client.ready();

    client.send('agent.chat', { task_id: 't1', session_id: 's-pb', message: 'hi' });

    const started = await client.waitFor((m) => m.method === 'task.started');
    expect(started.params).toMatchObject({ task_id: 't1' });

    const text = await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false &&
        (m.params as Record<string, unknown>).content === 'Hello from mocked CodeBuddy.',
    );
    expect(text).toBeDefined();

    await client.waitFor((m) => m.method === 'task.completed');
    await client.close();

    // Session store should now carry the sdk_session_id from the init event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentRef = agent as unknown as { sessionStore: { get(k: string): string | undefined } };
    expect(agentRef.sessionStore.get('s-pb')).toBe('sdk-session-42');

    // And `query` should have been called exactly once.
    expect(scenario.calls).toHaveLength(1);
    expect(scenario.calls[0]?.options).toMatchObject({ cwd: tmpDir });
  });

  it('announces tool_use with ui.messageMetadata + ui.textContent', async () => {
    scenario.messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-a' },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      },
      { type: 'result', subtype: 'success' },
    ];

    await startAgent();
    const client = new TestClient(port);
    await client.ready();

    client.send('agent.chat', { task_id: 't-tool', session_id: 's-tool', message: 'run' });

    await client.waitFor((m) => m.method === 'task.started');
    const meta = await client.waitFor((m) => m.method === 'ui.messageMetadata');
    expect(meta.params).toMatchObject({
      collapsible: true,
      collapsible_title: 'Tool: Bash',
    });

    const text = await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        typeof (m.params as Record<string, unknown>).content === 'string' &&
        ((m.params as Record<string, unknown>).content as string).includes('`Bash`') &&
        ((m.params as Record<string, unknown>).content as string).includes('echo hi'),
    );
    expect(text).toBeDefined();

    await client.waitFor((m) => m.method === 'task.completed');
    await client.close();
  });

  it('resumes with sdk session_id on a second chat turn', async () => {
    scenario.messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-B' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first' }] },
      },
      { type: 'result', subtype: 'success' },
    ];

    await startAgent();
    const client = new TestClient(port);
    await client.ready();

    client.send('agent.chat', { task_id: 't1', session_id: 'shepaw-sess', message: 'one' });
    await client.waitFor((m) => m.method === 'task.completed');

    // Second turn: fresh messages, but query() should be called with resume=sess-B.
    scenario.messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-B' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second' }] },
      },
      { type: 'result', subtype: 'success' },
    ];

    client.send('agent.chat', { task_id: 't2', session_id: 'shepaw-sess', message: 'two' });
    await client.waitFor(
      (m) =>
        m.method === 'task.completed' &&
        (m.params as Record<string, unknown>).task_id === 't2',
    );
    await client.close();

    expect(scenario.calls).toHaveLength(2);
    expect(scenario.calls[1]?.options).toMatchObject({ resume: 'sess-B' });
  });

  it('canUseTool: blocks the SDK turn; a follow-up "allow" message resolves it without opening a new query', async () => {
    // Single turn: CodeBuddy calls Write via canUseTool. canUseTool
    // blocks (ui.actionConfirmation goes out) until onChat receives a
    // second chat message with an approval keyword, which resolves the
    // pending confirmation and lets this same query() continue.
    scenario.messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-C' },
      {
        _triggerCanUseTool: { toolName: 'Write', input: { file_path: '/a', content: 'hi' } },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
      { type: 'result', subtype: 'success' },
    ];

    await startAgent();
    const client = new TestClient(port);
    await client.ready();

    // ── Turn 1: starts, fires confirmation, then blocks inside the SDK ──
    client.send('agent.chat', {
      task_id: 't-block-1',
      session_id: 's-block',
      message: 'please write the file',
    });

    const confirm = await client.waitFor((m) => m.method === 'ui.actionConfirmation');
    const prompt = (confirm.params as { prompt: string }).prompt;
    expect(prompt).toContain('Write');
    expect(prompt).toContain('/a');

    // Turn 1 is NOT yet completed — the SDK is blocked waiting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentRef = agent as unknown as {
      pendingConfirmations: { size(sid: string): number };
      approvalCache: { get(sid: string, t: string, i: unknown): string | undefined };
    };
    expect(agentRef.pendingConfirmations.size('s-block')).toBe(1);

    // ── Turn 2: user says "allow" — resolves the pending wait ──────────
    // The second chat message arrives while turn 1's SDK call is still
    // mid-flight. onChat resolves the pending confirmation and returns
    // without opening a new query(); turn 1 resumes and emits "done".
    client.send('agent.chat', {
      task_id: 't-block-2',
      session_id: 's-block',
      message: 'allow',
    });

    // The second agent.chat has no SDK work; it just completes.
    await client.waitFor(
      (m) =>
        m.method === 'task.completed' &&
        (m.params as Record<string, unknown>).task_id === 't-block-2',
    );

    // Turn 1 now unblocks, emits "done", and completes.
    await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).content === 'done',
    );
    await client.waitFor(
      (m) =>
        m.method === 'task.completed' &&
        (m.params as Record<string, unknown>).task_id === 't-block-1',
    );

    // Cache now has the allow verdict (mirrored on resolveAll).
    expect(
      agentRef.approvalCache.get('s-block', 'Write', { file_path: '/a', content: 'hi' }),
    ).toBe('allow');
    // Exactly one confirmation was ever emitted.
    const confirmations = client.allMessages.filter(
      (m) => m.method === 'ui.actionConfirmation',
    );
    expect(confirmations).toHaveLength(1);
    // And query() was called exactly once — the "allow" message did
    // NOT open a second query.
    expect(scenario.calls).toHaveLength(1);

    await client.close();
  });
});
