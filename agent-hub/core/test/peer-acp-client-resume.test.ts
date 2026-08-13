/**
 * Real client ↔ real server contract test for detached-task resume.
 *
 * Unlike peer-connection-approval-flap.test.ts (which mocks PeerAcpClient),
 * this drives a REAL PeerAcpClient against a REAL in-process ACPAgentServer:
 * the hub→proxy WS is killed mid-turn, the proxy keeps the turn running
 * (replay buffer), and the client's reconnect loop must resume it with
 * exactly-once chunk delivery. Also covers the proxy-restart case, where
 * the replay buffer is genuinely gone and the turn must fail as 'lost'.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACPAgentServer,
  TaskContext,
  addPeer,
  loadOrCreateIdentity,
} from 'shepaw-acp-sdk';

import { PeerAcpClient } from '../src/peer/peer-acp-client.js';
import type { InstanceConfig } from '../src/config.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Emits 'Hello ' immediately, then 'world' per gate release, then completes. */
class ScriptedAgent extends ACPAgentServer {
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
    await ctx.sendText('Hello ');
    await this.gate(`${ctx.taskId}:0`);
    await ctx.sendText('world');
    await this.gate(`${ctx.taskId}:1`);
  }
}

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

async function startServer(agent: ScriptedAgent, port = 0): Promise<RunningServer> {
  const { httpServer, wsServer } = agent.createServer() as {
    httpServer: HttpServer;
    wsServer: WebSocketServer;
  };
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const bound = (httpServer.address() as AddressInfo).port;
  return {
    port: bound,
    stop: async () => {
      for (const client of wsServer.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await agent.close().catch(() => undefined);
    },
  };
}

describe('PeerAcpClient ↔ ACPAgentServer resume contract', () => {
  let workdir: string;
  let peersPath: string;
  let identityPath: string;
  let agent: ScriptedAgent;
  let server: RunningServer;
  let client: PeerAcpClient;
  const logLines: string[] = [];

  const instanceOf = (port: number): InstanceConfig =>
    ({
      id: 'alpha',
      label: 'Alpha',
      engine: 'claude-code',
      cwd: workdir,
      port,
      host: '127.0.0.1',
      baseUrl: '',
      extraArgs: [],
      createdAt: new Date().toISOString(),
    }) as unknown as InstanceConfig;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-client-resume-'));
    peersPath = join(workdir, 'authorized_peers.json');
    identityPath = join(workdir, 'agent-identity.json');
    // Authorize the peer BEFORE constructing the agent — the allowlist is
    // loaded once at construction time.
    const peerIdentity = loadOrCreateIdentity({ path: join(workdir, 'peer-identity.json') });
    addPeer(peersPath, Buffer.from(peerIdentity.staticPublicKey).toString('base64'), 'hub');
    agent = new ScriptedAgent({ name: 'Scripted', peersPath, identityPath });
    server = await startServer(agent);

    client = new PeerAcpClient(
      peerIdentity,
      instanceOf(server.port),
      agent.identity,
      (line) => logLines.push(line),
    );
  });

  afterAll(async () => {
    try { client.close(); } catch { /* ignore */ }
    await server.stop().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });

  it('resumes an in-flight turn after the transport drops, with exactly-once delivery', async () => {
    let chunks = '';
    let doneContent: string | undefined;
    let errorMessage: string | undefined;
    const done = new Promise<void>((resolve) => {
      const chat = client.chat(
        { message: 'hi', taskId: 't-flap' },
        {
          onChunk: (c) => { chunks += c; },
          onDone: (content) => { doneContent = content; },
          onError: (m) => { errorMessage = m; },
          onApproval: () => Promise.resolve({ id: '' }),
        },
      );
      void chat.then(() => resolve());
    });

    // Wait for the first chunk, then kill the transport mid-turn.
    try {
      await waitFor(() => chunks === 'Hello ', 3000);
    } catch (err) {
      throw new Error(`first chunk never arrived; client logs:\n${logLines.join('\n')}`);
    }
    (client as unknown as { ws?: { close(): void } }).ws?.close();

    // The turn keeps running on the proxy while the client is detached.
    await sleep(200);
    agent.release('t-flap:0');

    // The client reconnects (backoff starts at 500ms) and resumes.
    await sleep(1500);
    agent.release('t-flap:1');

    await done;
    expect(errorMessage).toBeUndefined();
    // Exactly once: any duplication from the resume/delta overlap breaks this.
    expect(chunks).toBe('Hello world');
    expect(doneContent).toBe('Hello world');
    expect(logLines.some((l) => l.includes('resume task=t-flap → streaming'))).toBe(true);
  }, 15_000);

  it('fails the turn as lost when the proxy restarted (replay buffer gone)', async () => {
    let errorMessage: string | undefined;
    const settled = new Promise<void>((resolve) => {
      void client.chat(
        { message: 'hi', taskId: 't-restart' },
        {
          onChunk: () => {},
          onDone: () => {},
          onError: (m) => { errorMessage = m; },
          onApproval: () => Promise.resolve({ id: '' }),
        },
      ).then(() => resolve());
    });
    await waitFor(
      () => logLines.some((l) => l.includes('acp client connected')),
      3000,
    );
    // Give the chat a beat to reach the agent, then restart the proxy.
    await sleep(300);

    const oldPort = server.port;
    await server.stop();
    agent = new ScriptedAgent({ name: 'Scripted2', peersPath, identityPath });
    server = await startServer(agent, oldPort);

    // The client's reconnect succeeds (same port), but taskResume answers
    // 'lost' — the new proxy process never heard of the task.
    await settled;
    expect(errorMessage).toContain('丢失');
  }, 20_000);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(50);
  }
}
