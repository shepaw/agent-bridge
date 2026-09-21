/**
 * `agent.cancelTask` must be scoped to the task it names.
 *
 * It used to reject EVERY pending `waitForResponse` / `hubRequest` in the
 * process, so cancelling one conversation denied another conversation's
 * permission prompt: that waiter came back as TaskCancelledError and the
 * agent reported `cancelled` for a tool the user never rejected.
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

/** Waits on an approval card inside the turn, then echoes the verdict. */
class CardAgent extends ACPAgentServer {
  private readonly gates = new Map<string, Array<() => void>>();
  private readonly released = new Set<string>();

  release(id: string): void {
    this.released.add(id);
    const waiters = this.gates.get(id) ?? [];
    this.gates.delete(id);
    for (const r of waiters) r();
  }

  private gate(id: string): Promise<void> {
    if (this.released.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.gates.get(id) ?? [];
      list.push(resolve);
      this.gates.set(id, list);
    });
  }

  override async onChat(ctx: TaskContext): Promise<void> {
    await this.gate(`card:${ctx.taskId}`);
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

describe('agent.cancelTask scoping', () => {
  let agent: CardAgent;
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

  const cardFor = async (
    client: V2TestClient,
    taskId: string,
  ): Promise<string> => {
    const card = await client.waitFor(
      (m) =>
        m.method === 'ui.actionConfirmation' &&
        (m.params as Record<string, unknown>).task_id === taskId,
      3000,
    );
    return (card.params as Record<string, unknown>).confirmation_id as string;
  };

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-cancel-scope-'));
    const peersPath = join(workdir, 'authorized_peers.json');
    authorized = makePeerKeypair();
    addPeer(peersPath, authorized.publicKeyB64, 'test-client');

    agent = new CardAgent({ name: 'CardAgent', peersPath });
    const handle = await startAgent(agent);
    port = handle.port;
    stop = handle.stop;
  });

  afterAll(async () => {
    await stop?.();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('cancelling one task leaves another task’s approval waiter alive', async () => {
    const client = await connect();

    await client.request('agent.chat', { task_id: 'c1', session_id: 'sc1', message: 'a' });
    agent.release('card:c1');
    await cardFor(client, 'c1');

    await client.request('agent.chat', { task_id: 'c2', session_id: 'sc2', message: 'b' });
    agent.release('card:c2');
    const secondCardId = await cardFor(client, 'c2');

    // Cancel only c1.
    const cancelled = await client.request<{ status: string }>('agent.cancelTask', {
      task_id: 'c1',
    });
    expect(cancelled.result).toMatchObject({ task_id: 'c1', status: 'cancelled' });

    const errored = await client.waitFor(
      (m) =>
        m.method === 'task.error' &&
        (m.params as Record<string, unknown>).task_id === 'c1',
      3000,
    );
    expect(errored.params).toMatchObject({ task_id: 'c1' });

    // c2 was never cancelled: its waiter is still live, so the verdict the
    // user submits is honoured instead of being turned into a denial.
    await client.request('agent.submitResponse', {
      task_id: 'c2',
      response_data: { confirmation_id: secondCardId, selected_action_id: 'allow' },
    });
    const text = await client.waitFor(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).task_id === 'c2' &&
        (m.params as Record<string, unknown>).is_final === false,
      3000,
    );
    expect((text.params as Record<string, unknown>).content).toBe('verdict=allow');

    await client.close();
  });
});
