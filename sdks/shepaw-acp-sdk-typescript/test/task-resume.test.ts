/**
 * Detached-task resume tests.
 *
 * A client disconnect must never kill agent work: the turn keeps running
 * (output accumulates in the per-task replay buffer) and a reconnecting
 * client re-attaches via `agent.taskResume` — delta replay for the missed
 * suffix, live rebind for subsequent frames, re-emitted confirmations, and
 * approval waiters that survive the flap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import noiseLib from 'noise-protocol';

import { ACPAgentServer } from '../src/server.js';
import { TaskContext } from '../src/task-context.js';
import { addPeer } from '../src/peers.js';

import { startAgent, V2TestClient } from './v2-test-client.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/**
 * Emits 'Hello ' immediately, then one chunk per test-driven gate release.
 * Returns (and completes) after the last gate.
 */
class ScriptedAgent extends ACPAgentServer {
  private readonly gates = new Map<string, Array<() => void>>();
  /** Released-before-registered gates resolve immediately (test pacing). */
  private readonly releasedGates = new Set<string>();

  release(taskId: string, gate: number): void {
    const id = `${taskId}:${gate}`;
    this.releasedGates.add(id);
    const waiters = this.gates.get(id) ?? [];
    this.gates.delete(id);
    for (const r of waiters) r();
  }

  private gate(id: string): Promise<void> {
    if (this.releasedGates.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.gates.get(id) ?? [];
      list.push(resolve);
      this.gates.set(id, list);
    });
  }

  override async onChat(ctx: TaskContext): Promise<void> {
    await ctx.sendText('Hello ');
    await this.gate(`${ctx.taskId}:0`);
    await ctx.sendText('world');
    await this.gate(`${ctx.taskId}:1`);
  }
}

describe('detached task resume', () => {
  let agent: ScriptedAgent;
  let port: number;
  let stop: () => Promise<void>;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  const connect = async (): Promise<V2TestClient> => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { agentId: agent.agentId, staticKeypair: authorized },
    );
    await client.waitReady();
    return client;
  };

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-resume-'));
    const peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new ScriptedAgent({ name: 'Scripted', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop?.();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('keeps a mid-turn task running across disconnect; resume replays the delta and rebinds live output', async () => {
    const client1 = await connect();
    await client1.request('agent.chat', {
      task_id: 't1',
      session_id: 's1',
      message: 'hi',
    });
    const chunk1 = await client1.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    );
    expect((chunk1.params as Record<string, unknown>).content).toBe('Hello ');

    // Flap. The old behavior aborted the task right here.
    await client1.close();

    // The turn keeps running detached; 'world' lands only in the buffer.
    agent.release('t1', 0);
    await sleep(150);

    // Reconnect + resume at the received prefix (UTF-16 units, like the hub).
    const client2 = await connect();
    const resp = await client2.request<{
      task_id: string;
      status: string;
      delta?: string;
    }>('agent.taskResume', { task_id: 't1', known_length: 6 });
    expect(resp.result).toMatchObject({
      task_id: 't1',
      status: 'streaming',
      delta: 'world',
    });

    // Live output after the resume flows on the NEW connection.
    agent.release('t1', 1);
    const done = await client2.waitForNotification('task.completed');
    expect(done.params).toMatchObject({ task_id: 't1', status: 'success' });
    await client2.close();
  });

  it('buffers the terminal result while disconnected; resume returns done + full content', async () => {
    const client1 = await connect();
    await client1.request('agent.chat', {
      task_id: 't2',
      session_id: 's2',
      message: 'hi',
    });
    await client1.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    );
    await client1.close();

    // Turn runs to completion with nobody listening.
    agent.release('t2', 0);
    agent.release('t2', 1);
    await sleep(150);

    const client2 = await connect();
    const resp = await client2.request<{
      task_id: string;
      status: string;
      delta?: string;
      content?: string;
    }>('agent.taskResume', { task_id: 't2', known_length: 6 });
    expect(resp.result).toMatchObject({
      task_id: 't2',
      status: 'done',
      delta: 'world',
      content: 'Hello world',
    });
    await client2.close();
  });

  it('answers lost for unknown tasks', async () => {
    const client = await connect();
    const resp = await client.request<{ status: string }>('agent.taskResume', {
      task_id: 'no-such-task',
      known_length: 0,
    });
    expect(resp.result).toMatchObject({ status: 'lost' });
    await client.close();
  });
});

describe('approval waiter survives disconnect', () => {
  class ApprovalAgent extends ACPAgentServer {
    private readonly gates = new Map<string, Array<() => void>>();

    /** Let onChat proceed past the named gate (for raising cards while detached). */
    release(id: string): void {
      const waiters = this.gates.get(id) ?? [];
      this.gates.delete(id);
      for (const r of waiters) r();
    }

    private gate(id: string): Promise<void> {
      return new Promise((resolve) => {
        const list = this.gates.get(id) ?? [];
        list.push(resolve);
        this.gates.set(id, list);
      });
    }

    override async onChat(ctx: TaskContext): Promise<void> {
      // Tests may hold the confirmation until the client is gone.
      await this.gate(`confirm:${ctx.taskId}`);
      const cid = await ctx.sendActionConfirmation({
        prompt: 'Allow?',
        actions: [
          { id: 'allow', label: 'Allow', value: 'allow' },
          { id: 'deny', label: 'Deny', value: 'deny' },
        ],
      });
      const verdict = await ctx.waitForResponse(cid, { timeoutMs: 30_000 });
      await ctx.sendText(`verdict=${String(verdict.selected_action_id)}`);
    }
  }

  let agent: ApprovalAgent;
  let port: number;
  let stop: () => Promise<void>;
  let workdir: string;
  let authorized: ReturnType<typeof makePeerKeypair>;

  const connectApproval = async (): Promise<V2TestClient> => {
    const client = new V2TestClient(
      `ws://127.0.0.1:${port}/acp/ws`,
      agent.identity.staticPublicKey,
      { agentId: agent.agentId, staticKeypair: authorized },
    );
    await client.waitReady();
    return client;
  };

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-resume-approval-'));
    const peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new ApprovalAgent({ name: 'Approval', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop?.();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('card delivered before the flap: no duplicate re-emit; verdict rides the new connection', async () => {
    const client1 = await connectApproval();
    await client1.request('agent.chat', {
      task_id: 'a1',
      session_id: 'sa',
      message: 'do it',
    });
    agent.release('confirm:a1');
    const card = await client1.waitForNotification('ui.actionConfirmation');
    const confirmationId = (card.params as Record<string, unknown>)
      .confirmation_id as string;
    expect(confirmationId).toBeTruthy();

    // User walks away mid-approval: the connection drops unanswered. The old
    // behavior rejected the waiter here ('Connection closed') → deny.
    await client1.close();
    await sleep(150);

    // Reconnect + resume. The card WAS delivered pre-flap, so the rebind must
    // NOT re-emit it (the client — or its hub — is already showing it).
    const client2 = await connectApproval();
    const resp = await client2.request<{ status: string }>('agent.taskResume', {
      task_id: 'a1',
      known_length: 0,
    });
    expect(resp.result).toMatchObject({ status: 'streaming' });
    await expect(
      client2.waitForNotification('ui.actionConfirmation', 400),
    ).rejects.toThrow(/timed out/);

    // The verdict arrives on the NEW connection and resolves the OLD waiter.
    await client2.request('agent.submitResponse', {
      task_id: 'a1',
      response_data: {
        confirmation_id: confirmationId,
        selected_action_id: 'allow',
      },
    });
    const text = await client2.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    );
    expect((text.params as Record<string, unknown>).content).toBe('verdict=allow');
    const done = await client2.waitForNotification('task.completed');
    expect(done.params).toMatchObject({ task_id: 'a1', status: 'success' });
    await client2.close();
  });

  it('card raised while detached: rebind re-emits it so the user can decide', async () => {
    const client1 = await connectApproval();
    await client1.request('agent.chat', {
      task_id: 'a2',
      session_id: 'sb',
      message: 'do it',
    });
    await client1.waitForNotification('task.started');
    await client1.close();
    await sleep(150);

    // The approval is raised with NO client connected — buffered, undelivered.
    agent.release('confirm:a2');
    await sleep(150);

    const client2 = await connectApproval();
    const resp = await client2.request<{ status: string }>('agent.taskResume', {
      task_id: 'a2',
      known_length: 0,
    });
    expect(resp.result).toMatchObject({ status: 'streaming' });
    const card = await client2.waitForNotification('ui.actionConfirmation');
    const confirmationId = (card.params as Record<string, unknown>)
      .confirmation_id as string;

    await client2.request('agent.submitResponse', {
      task_id: 'a2',
      response_data: {
        confirmation_id: confirmationId,
        selected_action_id: 'deny',
      },
    });
    const text = await client2.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    );
    expect((text.params as Record<string, unknown>).content).toBe('verdict=deny');
    await client2.close();
  });
});
