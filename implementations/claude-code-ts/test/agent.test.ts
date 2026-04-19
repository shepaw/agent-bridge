/**
 * End-to-end agent tests without hitting the Claude API.
 *
 * We mock `@anthropic-ai/claude-agent-sdk` so `query()` becomes a
 * programmable async generator. Then we spin up a real ClaudeCodeAgent
 * on an ephemeral port and drive it with a real WebSocket client,
 * exercising the full pipeline: JSON-RPC dispatch → onChat → SDK
 * message handling → ui.* notifications → task.completed.
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

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
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
import { ClaudeCodeAgent } from '../src/agent.js';

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;
let storePath: string;
let agent: ClaudeCodeAgent | undefined;
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
  agent = new ClaudeCodeAgent({
    name: 'Test CC',
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

describe('ClaudeCodeAgent (mocked SDK)', () => {
  it('getCard works without hitting Claude', async () => {
    await startAgent();
    const client = new TestClient(port);
    await client.ready();
    const id = client.send('agent.getCard');
    const resp = await client.waitFor((m) => m.id === id);
    expect(resp.result).toMatchObject({
      name: 'Test CC',
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
        model: 'claude-fake',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello from mocked Claude.' }],
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
        (m.params as Record<string, unknown>).content === 'Hello from mocked Claude.',
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

  it('canUseTool: first turn emits ui.actionConfirmation + denies; second turn with "allow" hits the cache', async () => {
    // First turn: Claude tries to use Write. canUseTool denies because
    // no approval is cached yet, and fires off a ui.actionConfirmation.
    scenario.messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-C' },
      {
        _triggerCanUseTool: { toolName: 'Write', input: { file_path: '/a', content: 'hi' } },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'waiting for approval' }] },
      },
      { type: 'result', subtype: 'success' },
    ];
    // Capture the decision returned by canUseTool so we can assert it
    // was a deny on the first turn and an allow on the second.
    const decisions: Array<{ toolName: string; behavior: string }> = [];
    scenario.onCanUseTool = async (toolName, _input) => {
      // We can't see the return value directly from within the generator;
      // instead, peek at the agent's pending tracker after each turn.
      decisions.push({ toolName, behavior: 'recorded' });
    };

    await startAgent();
    const client = new TestClient(port);
    await client.ready();

    // ── Turn 1 ────────────────────────────────────────────────────
    client.send('agent.chat', {
      task_id: 't-ct-1',
      session_id: 's-ct',
      message: 'please write the file',
    });

    const confirm = await client.waitFor((m) => m.method === 'ui.actionConfirmation');
    const prompt = (confirm.params as { prompt: string }).prompt;
    expect(prompt).toContain('Write');
    expect(prompt).toContain('/a');

    await client.waitFor(
      (m) =>
        m.method === 'task.completed' &&
        (m.params as Record<string, unknown>).task_id === 't-ct-1',
    );

    // A pending approval should now be tracked for this session.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentRef = agent as unknown as {
      pendingApprovals: { peekMostRecent(sid: string): { toolName: string } | undefined };
      approvalCache: { get(sid: string, t: string, i: unknown): string | undefined };
    };
    expect(agentRef.pendingApprovals.peekMostRecent('s-ct')?.toolName).toBe('Write');

    // ── Turn 2: user types "allow" (approval keyword) ─────────────
    // onChat should record allow into the cache, then query() fires again
    // with the same tool_use; canUseTool hits the cache and returns allow.
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

    client.send('agent.chat', {
      task_id: 't-ct-2',
      session_id: 's-ct',
      message: 'allow',
    });

    // The second turn should complete with Claude's "done" text and
    // WITHOUT emitting another ui.actionConfirmation.
    await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).content === 'done',
    );
    await client.waitFor(
      (m) =>
        m.method === 'task.completed' &&
        (m.params as Record<string, unknown>).task_id === 't-ct-2',
    );

    // Cache now has the allow verdict.
    expect(agentRef.approvalCache.get('s-ct', 'Write', { file_path: '/a', content: 'hi' })).toBe(
      'allow',
    );
    // Exactly one confirmation was ever emitted (first turn only).
    const confirmations = client.allMessages.filter(
      (m) => m.method === 'ui.actionConfirmation',
    );
    expect(confirmations).toHaveLength(1);

    await client.close();
    // Silence unused-var lint.
    void decisions;
  });
});
