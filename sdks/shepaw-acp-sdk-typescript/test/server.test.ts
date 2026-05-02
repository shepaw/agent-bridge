/**
 * ACPAgentServer v2.1 integration tests.
 *
 * Exercises the full v2.1 handshake + transport flow: client drives Noise IK,
 * server checks the client's static public key against the authorized-peers
 * allowlist, JSON-RPC subsequently flows encrypted. Any behavior that
 * survived from v1 / v2 (task lifecycle, UI components, cancellation) is
 * re-verified here now that it runs atop the new auth model.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import noiseLib from 'noise-protocol';

import { ACPAgentServer } from '../src/server.js';
import { TaskContext } from '../src/task-context.js';
import { WS_CLOSE } from '../src/envelope.js';
import { addPeer, removePeerByFingerprint } from '../src/peers.js';
import type { JsonRpcNotification } from '../src/types.js';

import { startAgent, V2TestClient } from './v2-test-client.js';

// ── helpers ────────────────────────────────────────────────────────

/**
 * Generate a fresh static keypair for a test client and (optionally) authorize
 * it on the agent. Returns both the raw keypair (so `V2TestClient` can reuse
 * it via `opts.staticKeypair`) and the base64 pubkey (in case you want to do
 * it yourself). This is the v2.1 equivalent of "give your client the right
 * token" — only now there is no shared secret, just a pubkey registration.
 */
function makePeerKeypair(): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyB64: string;
} {
  const kp = noiseLib.keygen();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.secretKey,
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
  };
}

// ── Echo flow ──────────────────────────────────────────────────────

describe('ACPAgentServer v2.1 — echo flow', () => {
  class EchoAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext, message: string): Promise<void> {
      await ctx.sendText(`Echo: ${message}`);
    }
  }

  let agent: EchoAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-server-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new EchoAgent({ name: 'Echo', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('completes a chat with task.started → ui.textContent → task.completed', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { agentId: agent.agentId, staticKeypair: authorized },
    );
    await client.waitReady();

    const ack = await client.request<{ task_id: string; status: string }>('agent.chat', {
      task_id: 't1',
      session_id: 's1',
      message: 'hi',
    });
    expect(ack.result).toEqual({ task_id: 't1', status: 'accepted' });

    const started = await client.waitForNotification('task.started');
    expect(started.params).toMatchObject({ task_id: 't1' });

    const text = (await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    )) as unknown as JsonRpcNotification;
    expect(text.params).toMatchObject({
      task_id: 't1',
      content: 'Echo: hi',
      is_final: false,
    });

    const textFinal = (await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === true,
    )) as unknown as JsonRpcNotification;
    expect(textFinal.params).toMatchObject({ task_id: 't1', is_final: true });

    const completed = await client.waitForNotification('task.completed');
    expect(completed.params).toMatchObject({ task_id: 't1', status: 'success' });

    await client.close();
  });

  it('ping (post-handshake) returns pong', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();
    const pong = await client.request('ping');
    expect(pong.result).toEqual({ pong: true });
    await client.close();
  });
});

// ── Handshake rejection paths ──────────────────────────────────────

describe('ACPAgentServer v2.1 — handshake rejection', () => {
  class EchoAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext, message: string): Promise<void> {
      await ctx.sendText(`Echo: ${message}`);
    }
  }

  let agent: EchoAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-server-reject-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new EchoAgent({ name: 'Echo', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('rejects unauthorized peer (not on allowlist) with close code 4405', async () => {
    // Fresh keypair never added to the allowlist — handshake completes but
    // the server aborts before activating the session.
    const stranger = makePeerKeypair();
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: stranger },
    );
    await expect(client.waitReady()).rejects.toThrow();
    const code = await client.waitForClose();
    expect(code).toBe(WS_CLOSE.PEER_NOT_AUTHORIZED);
  });

  it('rejects wrong pinned peer public key (MITM) with close during handshake', async () => {
    // Simulating a client that tried to handshake against a responder with a
    // different static key than what the agent actually has — Noise decryption
    // fails. (Authorized-peer check never runs because handshake aborts first.)
    const wrongPub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) wrongPub[i] = i;
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      wrongPub,
      { staticKeypair: authorized },
    );
    await expect(client.waitReady()).rejects.toThrow();
    const code = await client.waitForClose();
    // HANDSHAKE_FAILED comes from the server's Noise decrypt failure.
    expect(code).toBe(WS_CLOSE.HANDSHAKE_FAILED);
  });

  it('rejects claimed agentId mismatch with close code 4404', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { agentId: 'acp_agent_bogus', staticKeypair: authorized },
    );
    await expect(client.waitReady()).rejects.toThrow();
    const code = await client.waitForClose();
    expect(code).toBe(WS_CLOSE.AGENTID_MISMATCH);
  });
});

// ── peer.unregister flow ──────────────────────────────────────────

describe('ACPAgentServer v2.1 — peer.unregister', () => {
  class EchoAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext, message: string): Promise<void> {
      await ctx.sendText(`Echo: ${message}`);
    }
    // Expose the allowlist so the test can assert the entry is gone.
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    get peersForTest() {
      return this.peers;
    }
  }

  let agent: EchoAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-server-unreg-'));
    peersPath = join(workdir, 'authorized_peers.json');
    agent = new EchoAgent({ name: 'Echo', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterEach(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('removes the peer from the allowlist and closes with 4411', async () => {
    const kp = makePeerKeypair();
    addPeer(peersPath, kp.publicKeyB64, 'revocable');
    agent['reloadPeers']();  // pick up the new entry before connecting

    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: kp },
    );
    await client.waitReady();
    expect(agent.peersForTest.peers.length).toBe(1);

    // Fire-and-forget notification — no id, no response.
    client.sendRaw({ jsonrpc: '2.0', method: 'peer.unregister' });

    const code = await client.waitForClose(2000);
    expect(code).toBe(WS_CLOSE.UNREGISTERED);
    expect(agent.peersForTest.peers.length).toBe(0);

    // Reconnecting with the same keypair now fails at the allowlist check.
    const retry = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: kp },
    );
    await expect(retry.waitReady()).rejects.toThrow();
    const retryCode = await retry.waitForClose();
    expect(retryCode).toBe(WS_CLOSE.PEER_NOT_AUTHORIZED);
  });
});

// ── Cancel + UI ───────────────────────────────────────────────────

describe('ACPAgentServer v2.1 — cancel + UI interaction', () => {
  let resolveConfirm: ((value: Record<string, unknown>) => void) | undefined;

  class InteractiveAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext, _message: string): Promise<void> {
      const cid = await ctx.sendActionConfirmation({
        prompt: 'Proceed?',
        actions: [
          { label: 'Yes', value: 'y' },
          { label: 'No', value: 'n' },
        ],
        confirmationId: 'confirm_static',
      });
      const response = await ctx.waitForResponse(cid, { timeoutMs: 5000 });
      resolveConfirm?.(response);
      await ctx.sendText(`result: ${response.value as string}`);
    }
  }

  let agent: InteractiveAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-server-ui-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new InteractiveAgent({ name: 'Interactive', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('routes agent.submitResponse back to waitForResponse', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const received = new Promise<Record<string, unknown>>((r) => (resolveConfirm = r));

    await client.request('agent.chat', {
      task_id: 't2',
      session_id: 's2',
      message: 'delete this please',
    });

    const confirm = await client.waitForNotification('ui.actionConfirmation', 3000);
    expect(confirm.params).toMatchObject({
      task_id: 't2',
      confirmation_id: 'confirm_static',
      prompt: 'Proceed?',
    });

    const ack = await client.request('agent.submitResponse', {
      task_id: 't2',
      response_type: 'confirmation',
      response_data: { confirmation_id: 'confirm_static', value: 'y' },
    });
    expect(ack.result).toEqual({ task_id: 't2', status: 'received' });

    const payload = await received;
    expect(payload).toMatchObject({ confirmation_id: 'confirm_static', value: 'y' });

    const text = (await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false &&
        typeof (m.params as Record<string, unknown>).content === 'string' &&
        ((m.params as Record<string, unknown>).content as string).includes('result: y'),
    )) as unknown as JsonRpcNotification;
    expect(text).toBeDefined();

    await client.close();
  });
});

// ── Cancellation ──────────────────────────────────────────────────

describe('ACPAgentServer v2.1 — cancellation', () => {
  class StallAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext): Promise<void> {
      await ctx.waitForResponse('never_confirmed', { timeoutMs: 60_000 });
    }
  }

  let agent: StallAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-server-cancel-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new StallAgent({ name: 'Stall', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('sends task.error with code -32008 on agent.cancelTask', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    await client.request('agent.chat', { task_id: 't3', session_id: 's3', message: 'stall' });
    await client.waitForNotification('task.started');

    const cancel = await client.request('agent.cancelTask', { task_id: 't3' });
    expect(cancel.result).toMatchObject({ task_id: 't3', status: 'cancelled' });

    const errNotif = await client.waitForNotification('task.error', 3000);
    expect(errNotif.params).toMatchObject({ task_id: 't3', code: -32008 });

    await client.close();
  });
});

// ── agent.commands.list (default empty + override) ─────────────────

describe('ACPAgentServer v2.1 — agent.commands.list', () => {
  class CommandsAgent extends ACPAgentServer {
    override async onChat(ctx: TaskContext): Promise<void> {
      await ctx.sendText('ok');
    }
    override async onCommandsList() {
      return {
        commands: [
          { name: 'plan', description: 'Plan something', scope: 'project' as const, source: 'filesystem' as const },
          { name: 'compact', scope: 'builtin' as const, source: 'sdk' as const },
        ],
      };
    }

    // expose protected helper for tests
    async forceBroadcast() {
      await this.broadcastCommandsChanged([
        { name: 'new', scope: 'project', source: 'filesystem' },
      ]);
    }
  }

  let agent: CommandsAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-server-commands-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new CommandsAgent({ name: 'Cmds', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('returns commands from onCommandsList override', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const resp = await client.request<{ commands: Array<{ name: string }> }>(
      'agent.commands.list',
    );
    expect(resp.result).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ name: 'plan', scope: 'project', source: 'filesystem' }),
        expect.objectContaining({ name: 'compact', scope: 'builtin', source: 'sdk' }),
      ]),
    });

    await client.close();
  });

  it('default ACPAgentServer returns an empty list', async () => {
    class BareAgent extends ACPAgentServer {}
    const bare = new BareAgent({ name: 'Bare', peersPath });
    const handle = await startAgent(bare);
    const client = new V2TestClient(
      `ws://127.0.0.1:${handle.port}/acp/ws`,
      bare.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const resp = await client.request<{ commands: unknown[] }>('agent.commands.list');
    expect(resp.result).toEqual({ commands: [] });

    await client.close();
    await handle.stop();
  });

  it('broadcastCommandsChanged pushes agent.commands.changed to authenticated clients', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    // Let the handshake settle before firing the broadcast so the client
    // is already in the authenticated set.
    await new Promise((r) => setTimeout(r, 50));

    const waitNotif = client.waitForNotification('agent.commands.changed', 2000);
    await agent.forceBroadcast();
    const notif = await waitNotif;
    expect(notif.params).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ name: 'new' }),
      ]),
    });

    await client.close();
  });
});

// ── onSlashCommand hook ────────────────────────────────────────────

describe('ACPAgentServer v2.1 — onSlashCommand hook', () => {
  class SlashAgent extends ACPAgentServer {
    chatCallCount = 0;
    slashCalls: Array<{ command: string; args: string; raw: string }> = [];

    override async onChat(ctx: TaskContext, message: string): Promise<void> {
      this.chatCallCount += 1;
      await ctx.sendText(`chat:${message}`);
    }

    override async onSlashCommand(
      ctx: TaskContext,
      command: string,
      args: string,
      raw: string,
    ): Promise<boolean> {
      this.slashCalls.push({ command, args, raw });
      if (command === 'model') {
        await ctx.sendText(`picked model handling ${args}`);
        return true;
      }
      return false;
    }
  }

  let agent: SlashAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-slash-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new SlashAgent({ name: 'Slash', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('intercepts /model and skips onChat', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    agent.chatCallCount = 0;
    agent.slashCalls = [];

    await client.request('agent.chat', {
      task_id: 't-slash',
      session_id: 's-slash',
      message: '/model list',
    });

    const text = await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        typeof (m.params as Record<string, unknown>).content === 'string' &&
        ((m.params as Record<string, unknown>).content as string).startsWith('picked'),
    );
    expect(text).toBeDefined();
    await client.waitForNotification('task.completed');

    expect(agent.chatCallCount).toBe(0);
    expect(agent.slashCalls).toEqual([
      { command: 'model', args: 'list', raw: '/model list' },
    ]);

    await client.close();
  });

  it('falls through to onChat when onSlashCommand returns false', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    agent.chatCallCount = 0;
    agent.slashCalls = [];

    await client.request('agent.chat', {
      task_id: 't-passthru',
      session_id: 's-passthru',
      message: '/unknownCommand foo',
    });

    await client.waitForNotification('task.completed');
    expect(agent.chatCallCount).toBe(1);
    expect(agent.slashCalls).toEqual([
      { command: 'unknownCommand', args: 'foo', raw: '/unknownCommand foo' },
    ]);

    await client.close();
  });

  it('does not invoke onSlashCommand for non-slash messages', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    agent.chatCallCount = 0;
    agent.slashCalls = [];

    await client.request('agent.chat', {
      task_id: 't-plain',
      session_id: 's-plain',
      message: 'hello',
    });

    await client.waitForNotification('task.completed');
    expect(agent.chatCallCount).toBe(1);
    expect(agent.slashCalls).toEqual([]);

    await client.close();
  });
});

// ── agent.models.list / agent.models.setCurrent ────────────────────

describe('ACPAgentServer v2.1 — agent.models.*', () => {
  class ModelsAgent extends ACPAgentServer {
    current: string | undefined = 'm-a';

    override async onChat(ctx: TaskContext): Promise<void> {
      await ctx.sendText('ok');
    }

    override async onModelsList() {
      return {
        models: [
          { value: 'm-a', display_name: 'Model A', description: 'The default' },
          { value: 'm-b', display_name: 'Model B', description: 'Better' },
        ],
        current: this.current,
      };
    }

    override async onModelsSetCurrent(p: { model: string }) {
      if (p.model !== 'm-a' && p.model !== 'm-b') {
        throw new Error(`unknown model: ${p.model}`);
      }
      this.current = p.model;
      return { model: p.model, display_name: p.model === 'm-a' ? 'Model A' : 'Model B' };
    }
  }

  let agent: ModelsAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-models-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new ModelsAgent({ name: 'Models', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('agent.models.list returns models + current', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const resp = await client.request<{
      models: Array<{ value: string; display_name: string }>;
      current?: string;
    }>('agent.models.list');
    expect(resp.result?.current).toBe('m-a');
    expect(resp.result?.models).toHaveLength(2);
    expect(resp.result?.models[0]).toMatchObject({ value: 'm-a', display_name: 'Model A' });

    await client.close();
  });

  it('agent.models.setCurrent updates and returns display_name', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const resp = await client.request<{ model: string; display_name?: string }>(
      'agent.models.setCurrent',
      { model: 'm-b' },
    );
    expect(resp.result).toEqual({ model: 'm-b', display_name: 'Model B' });

    const list = await client.request<{ current?: string }>('agent.models.list');
    expect(list.result?.current).toBe('m-b');

    await client.close();
  });

  it('agent.models.setCurrent rejects missing model param with -32602', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const resp = await client.request('agent.models.setCurrent');
    expect(resp).toHaveProperty('error');
    const asErr = resp as unknown as { error: { code: number } };
    expect(asErr.error.code).toBe(-32602);

    await client.close();
  });

  it('agent.models.setCurrent surfaces agent errors with -32000', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    const resp = await client.request('agent.models.setCurrent', { model: 'bogus' });
    expect(resp).toHaveProperty('error');
    const asErr = resp as unknown as { error: { code: number; message: string } };
    expect(asErr.error.code).toBe(-32000);
    expect(asErr.error.message).toContain('unknown model');

    await client.close();
  });
});

// ── registerFormHandler (non-blocking form flow) ───────────────────

describe('ACPAgentServer v2.1 — registerFormHandler', () => {
  class FormAgent extends ACPAgentServer {
    lastChoice: string | undefined;

    override async onChat(): Promise<void> {}

    override async onSlashCommand(
      ctx: TaskContext,
      command: string,
    ): Promise<boolean> {
      if (command !== 'pick') return false;
      const formId = 'form_fixed';
      await ctx.sendForm({
        title: 'Pick',
        fields: [
          {
            name: 'choice',
            label: 'Choice',
            type: 'radio_group',
            required: true,
            options: [
              { label: 'A', value: 'a' },
              { label: 'B', value: 'b' },
            ],
          },
        ],
        formId,
      });
      // Fire-and-forget: register handler and return immediately.
      this.exposeRegister(formId, (data) => {
        this.lastChoice = typeof data.choice === 'string' ? data.choice : undefined;
      });
      return true;
    }

    // Expose protected helper for the test.
    exposeRegister(
      formId: string,
      handler: (d: Record<string, unknown>) => void,
    ): void {
      this.registerFormHandler(formId, handler);
    }
  }

  let agent: FormAgent;
  let port: number;
  let stop: () => Promise<void>;
  let peersPath: string;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-form-handler-'));
    peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new FormAgent({ name: 'FormAgent', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('lets task complete immediately, then invokes handler on later submit', async () => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { staticKeypair: authorized },
    );
    await client.waitReady();

    agent.lastChoice = undefined;

    // Send /pick — expect task.completed WITHOUT any prior submit.
    await client.request('agent.chat', {
      task_id: 't-pick',
      session_id: 's-pick',
      message: '/pick',
    });

    const form = await client.waitForNotification('ui.form', 2000);
    expect((form.params as Record<string, unknown>).form_id).toBe('form_fixed');

    // Task should complete without waiting for submit — the fix.
    await client.waitForNotification('task.completed', 2000);
    expect(agent.lastChoice).toBeUndefined();

    // Later, user submits. Handler fires in the background.
    await client.request('agent.submitResponse', {
      task_id: 't-pick',
      response_type: 'form',
      response_data: { form_id: 'form_fixed', choice: 'b' },
    });

    // Give the microtask queue a tick for the handler to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.lastChoice).toBe('b');

    await client.close();
  });
});

// eliminate unused-import lint warning
void removePeerByFingerprint;
