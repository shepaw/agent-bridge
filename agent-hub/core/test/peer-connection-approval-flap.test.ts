/**
 * Regression tests for peer flap behaviour:
 *
 * 1. Approvals survive a peer WS flap (migrated waiter, record kept pending,
 *    acp client stays open, late verdict rides the deferred relay).
 * 2. Turns are resumable: the peer-level turn registry keeps the request_id ↔
 *    task_id mapping + full accumulated stream + buffered terminal result, so
 *    after a reconnect `agent_turn_resume_req` replays exactly the suffix the
 *    phone missed — and terminal results stay replayable within their TTL.
 * 3. Approvals raised while NO connection is live are parked (detached), not
 *    registered on a dead connection (whose 20-min timeout would relay a
 *    spurious deny).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import noiseLib from 'noise-protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  NoiseSession,
  NOISE_PROLOGUE,
} from 'shepaw-acp-sdk';

import { addInstance, loadOrCreateHubConfig, saveHubConfig } from '../src/config.js';
import { loadOrCreatePeerIdentity } from '../src/peer/peer-identity.js';
import { getPendingApproval } from '../src/peer/peer-pending-approvals.js';
import { markPeerTurnTerminal } from '../src/peer/peer-turn-map.js';

// ── Fake PeerAcpClient ──────────────────────────────────────────────

const { FakePeerAcpClient } = vi.hoisted(() => {
  interface FakeHandlers {
    onChunk: (content: string) => void;
    onDone: (fullContent: string, metadata?: Record<string, unknown>) => void;
    onError: (message: string) => void;
    onApproval: (req: {
      confirmationId: string; taskId: string; prompt: string;
      actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
      toolKind?: string; toolCallId?: string;
    }) => Promise<{ id: string; label?: string; migrated?: boolean }>;
    onMetadata?: (metadata: Record<string, unknown>) => void;
  }
  interface FakeTurn {
    handlers: FakeHandlers;
    accumulated: string;
    pendingApprovals: number;
    completedPayload?: { content: string; metadata?: Record<string, unknown> };
    cancelRequested: boolean;
  }
  class FakePeerAcpClient {
    static instances: FakePeerAcpClient[] = [];
    /**
     * Proxy-side replay buffers (taskId → stream). Separate from client
     * instances on purpose: the proxy is a detached process that survives a
     * hub restart, so this state must outlive close()/instance replacement.
     */
    static proxyTasks = new Map<string, {
      accumulated: string;
      status: 'streaming' | 'done' | 'error';
      metadata?: Record<string, unknown>;
      errorMessage?: string;
    }>();
    closed = false;
    readonly turns = new Map<string, FakeTurn>();
    deferred: Array<{
      taskId: string;
      confirmationId: string;
      selected: { id: string; label?: string };
    }> = [];

    constructor(..._args: unknown[]) {
      FakePeerAcpClient.instances.push(this);
    }

    get hasInflightTurns(): boolean {
      return this.turns.size > 0;
    }

    async chat(req: { taskId: string }, handlers: FakeHandlers): Promise<void> {
      this.turns.set(req.taskId, {
        handlers,
        accumulated: '',
        pendingApprovals: 0,
        cancelRequested: false,
      });
      FakePeerAcpClient.proxyTasks.set(req.taskId, { accumulated: '', status: 'streaming' });
      // Turn lifecycle is driven by the test via emit*.
      return new Promise<void>(() => {});
    }

    /** Mirror of the real reattachTurn: answer from the proxy replay buffer. */
    async reattachTurn(
      taskId: string,
      handlers: FakeHandlers,
    ): Promise<{
      status: 'streaming' | 'done' | 'error' | 'lost';
      delta: string;
      metadata?: Record<string, unknown>;
      content?: string;
      terminalMetadata?: Record<string, unknown>;
      message?: string;
    }> {
      const proxy = FakePeerAcpClient.proxyTasks.get(taskId);
      if (proxy === undefined) return { status: 'lost', delta: '' };
      if (proxy.status === 'done') {
        return {
          status: 'done',
          delta: proxy.accumulated,
          content: proxy.accumulated,
          ...(proxy.metadata !== undefined ? { terminalMetadata: proxy.metadata } : {}),
        };
      }
      if (proxy.status === 'error') {
        return {
          status: 'error',
          delta: proxy.accumulated,
          message: proxy.errorMessage ?? 'agent error',
        };
      }
      // Streaming: register the live turn (accumulated pre-seeded) so later
      // emit* route to the rebuilt handlers.
      this.turns.set(taskId, {
        handlers,
        accumulated: proxy.accumulated,
        pendingApprovals: 0,
        cancelRequested: false,
      });
      return {
        status: 'streaming',
        delta: proxy.accumulated,
        ...(proxy.metadata !== undefined ? { metadata: proxy.metadata } : {}),
      };
    }

    cancelTurn(taskId: string): void {
      const t = this.turns.get(taskId);
      if (t !== undefined) t.cancelRequested = true;
    }

    async submitDeferredApproval(
      taskId: string,
      confirmationId: string,
      selected: { id: string; label?: string },
    ): Promise<boolean> {
      this.deferred.push({ taskId, confirmationId, selected });
      return true;
    }

    close(): void {
      this.closed = true;
    }

    // ── Test drivers (mirror the real client's semantics) ──────────

    firstTaskId(): string {
      const id = this.turns.keys().next().value;
      if (id === undefined) throw new Error('no turn registered');
      return id;
    }

    emitChunk(taskId: string, content: string): void {
      const t = this.turns.get(taskId);
      if (t === undefined) throw new Error(`no turn ${taskId}`);
      t.accumulated += content;
      const proxy = FakePeerAcpClient.proxyTasks.get(taskId);
      if (proxy !== undefined) proxy.accumulated += content;
      t.handlers.onChunk(content);
    }

    emitMetadata(taskId: string, metadata: Record<string, unknown>): void {
      this.turns.get(taskId)?.handlers.onMetadata?.(metadata);
    }

    emitApproval(taskId: string, confirmationId: string): Promise<{ id: string; label?: string; migrated?: boolean }> {
      const t = this.turns.get(taskId);
      if (t === undefined) throw new Error(`no turn ${taskId}`);
      t.pendingApprovals += 1;
      const p = t.handlers.onApproval({
        confirmationId,
        taskId,
        prompt: 'Allow?',
        actions: [{ id: 'allow' }, { id: 'deny' }],
      });
      void p.finally(() => {
        t.pendingApprovals = Math.max(0, t.pendingApprovals - 1);
        this.maybeFinish(taskId);
      });
      return p;
    }

    emitDone(taskId: string, metadata?: Record<string, unknown>): void {
      const t = this.turns.get(taskId);
      if (t === undefined) throw new Error(`no turn ${taskId}`);
      t.completedPayload = { content: t.accumulated, metadata };
      const proxy = FakePeerAcpClient.proxyTasks.get(taskId);
      if (proxy !== undefined) {
        proxy.status = 'done';
        proxy.metadata = metadata;
      }
      this.maybeFinish(taskId);
    }

    emitError(taskId: string, message: string): void {
      const t = this.turns.get(taskId);
      if (t === undefined) throw new Error(`no turn ${taskId}`);
      t.handlers.onError(message);
      this.turns.delete(taskId);
    }

    private maybeFinish(taskId: string): void {
      const t = this.turns.get(taskId);
      if (t === undefined || t.pendingApprovals > 0 || t.completedPayload === undefined) return;
      t.handlers.onDone(t.completedPayload.content, t.completedPayload.metadata);
      this.turns.delete(taskId);
    }
  }
  return { FakePeerAcpClient };
});

vi.mock('../src/peer/peer-acp-client.js', () => ({
  PeerAcpClient: FakePeerAcpClient,
}));

import { drivePeerConnection, getPeerSessionsForTest, reapIdlePeerSessions, resetPeerSessionsForTest } from '../src/peer/peer-connection.js';

// ── Test harness ────────────────────────────────────────────────────

let home: string;
let prevHome: string | undefined;
let cwd: string;
const servers: WebSocketServer[] = [];
const drivePromises: Promise<void>[] = [];

interface PhoneLink {
  send: (obj: Record<string, unknown>) => void;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  /** Collect every message for ms (settle window), returning them in order. */
  drain: (ms?: number) => Promise<Record<string, unknown>[]>;
  close: () => void;
}

/** Wire up a WS + Noise pair and start drivePeerConnection on the hub side. */
async function connectPhone(peerId: string, logLines: string[]): Promise<PhoneLink> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;

  const hubIdentity = loadOrCreatePeerIdentity();
  const phoneKeys = noiseLib.keygen();
  const phoneSession = NoiseSession.initiator({
    staticPublicKey: phoneKeys.publicKey,
    staticPrivateKey: phoneKeys.secretKey,
    remoteStaticPublicKey: hubIdentity.staticPublicKey,
    prologue: NOISE_PROLOGUE,
  });
  const hubSession = NoiseSession.responder(hubIdentity, NOISE_PROLOGUE);

  const connPromise = once(wss, 'connection');
  const phoneWs = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(phoneWs, 'open');
  const [hubWs] = (await connPromise) as [WebSocket, unknown];

  // Noise handshake: phone msg1 → hub msg2.
  const msg1 = phoneSession.writeHandshake1(
    Buffer.from(JSON.stringify({ type: 'reconnect', device_id: 'phone' }), 'utf-8'),
  );
  phoneWs.send(encodeFrame({ t: 'hs', payload: msg1 }));
  const [msg1Raw] = (await once(hubWs, 'message')) as [Buffer];
  const msg1Frame = decodeFrame(msg1Raw);
  hubSession.readHandshake1(msg1Frame.payload);
  const msg2 = hubSession.writeHandshake2(
    Buffer.from(JSON.stringify({ type: 'reconnect_ack' }), 'utf-8'),
  );
  hubWs.send(encodeFrame({ t: 'hs', payload: msg2 }));
  const [msg2Raw] = (await once(phoneWs, 'message')) as [Buffer];
  const msg2Frame = decodeFrame(msg2Raw);
  phoneSession.readHandshake2(msg2Frame.payload);
  expect(phoneSession.ready).toBe(true);
  expect(hubSession.ready).toBe(true);

  drivePromises.push(
    drivePeerConnection({
      ws: hubWs,
      session: hubSession,
      peerIdentity: hubIdentity,
      peerId,
      log: (line) => logLines.push(line),
    }),
  );

  // Decrypted message pump on the phone side.
  const buffered: Record<string, unknown>[] = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  phoneWs.on('message', (data) => {
    const frame = decodeFrame(data as Buffer);
    if (frame.t !== 'data') return;
    const obj = JSON.parse(Buffer.from(phoneSession.decrypt(frame.payload)).toString('utf-8'));
    const w = waiters.shift();
    if (w !== undefined) w(obj);
    else buffered.push(obj);
  });

  return {
    send(obj) {
      const ct = phoneSession.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
      phoneWs.send(encodeFrame({ t: 'data', payload: ct }));
    },
    nextMessage(timeoutMs = 3000) {
      const m = buffered.shift();
      if (m !== undefined) return Promise.resolve(m);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('nextMessage timeout')), timeoutMs);
        waiters.push((m2) => {
          clearTimeout(timer);
          resolve(m2);
        });
      });
    },
    async drain(ms = 100) {
      await new Promise((r) => setTimeout(r, ms));
      return buffered.splice(0, buffered.length);
    },
    close() {
      try { phoneWs.close(); } catch { /* ignore */ }
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-peer-flap-'));
  cwd = mkdtempSync(join(tmpdir(), 'shepaw-agent-cwd-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
  FakePeerAcpClient.instances = [];
  FakePeerAcpClient.proxyTasks = new Map();
  // The peer-scoped acp client registry is module-level (shared across
  // reconnects by design) — reset it between tests.
  resetPeerSessionsForTest();

  let cfg = loadOrCreateHubConfig();
  cfg = addInstance(cfg, {
    id: 'alpha',
    engine: 'claude-code',
    cwd,
    host: '127.0.0.1',
    port: 18811,
    baseUrl: '',
    extraArgs: [],
  });
  saveHubConfig(cfg.path, cfg);
});

afterEach(async () => {
  for (const wss of servers.splice(0)) {
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => wss.close(() => r()));
  }
  // Let drivePeerConnection teardown run before wiping state.
  await Promise.allSettled(drivePromises.splice(0));
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// ── Approval flap tests (pre-existing behaviour, must not regress) ──

describe('peer flap mid-approval', () => {
  it('migrates the waiter, keeps record pending, keeps acp client open, and delivers the late verdict via deferred relay', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);

    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    const approvalPromise = client.emitApproval(taskId, 'perm_flap');
    const card = await link.nextMessage();
    expect(card.type).toBe('agent_approval_req');
    expect(card.approval_id).toBe('perm_flap');
    expect(getPendingApproval('perm_flap')?.status).toBe('pending');

    // ── The flap: phone WS drops mid-approval.
    link.close();
    await expect(approvalPromise).resolves.toMatchObject({ id: '', migrated: true });
    await waitFor(() => logLines.some((l) => l.includes('migrate approval perm_flap')));

    expect(getPendingApproval('perm_flap')?.status).toBe('pending');
    expect(client.closed).toBe(false);

    // ── Reconnect: hub re-sends the pending card, reuses the same client.
    link = await connectPhone('peer1', logLines);
    const resent = await link.nextMessage();
    expect(resent.type).toBe('agent_approval_req');
    expect(resent.approval_id).toBe('perm_flap');
    expect(FakePeerAcpClient.instances.length).toBe(1);

    // ── The late tap rides the deferred relay on the still-open client.
    link.send({
      type: 'agent_approval_resp',
      approval_id: 'perm_flap',
      selected_action_id: 'allow',
      selected_action_label: 'Allow',
    });
    await waitFor(() => client.deferred.length === 1, 2000);
    expect(client.deferred[0]).toMatchObject({
      taskId,
      confirmationId: 'perm_flap',
      selected: { id: 'allow', label: 'Allow' },
    });
    await waitFor(() => getPendingApproval('perm_flap')?.status === 'submitted');
    link.close();
  });

  it('in-connection approval_resp still resolves the waiter directly (no regression)', async () => {
    const logLines: string[] = [];
    const link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];

    const approvalPromise = client.emitApproval(client.firstTaskId(), 'perm_live');
    await link.nextMessage();

    link.send({
      type: 'agent_approval_resp',
      approval_id: 'perm_live',
      selected_action_id: 'allow',
    });
    await expect(approvalPromise).resolves.toMatchObject({ id: 'allow' });
    expect(getPendingApproval('perm_live')?.status).toBe('submitted');
    expect(client.deferred.length).toBe(0);
    link.close();
  });

  it('idle reaper keeps clients after disconnect so reconnects resume instantly', async () => {
    const logLines: string[] = [];
    const link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];

    // While the connection is live, the reaper must not touch the client.
    reapIdlePeerSessions();
    expect(client.closed).toBe(false);

    // Disconnect with a turn still running → reaper keeps it (agent survives).
    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    reapIdlePeerSessions();
    expect(client.closed).toBe(false);

    // Turn drained → the client STILL stays open: the peer↔agent link must not
    // drop just because the app went away — the next reconnect resumes on it.
    client.turns.clear();
    reapIdlePeerSessions();
    expect(client.closed).toBe(false);
  });
});

// ── Turn resume tests ───────────────────────────────────────────────

describe('turn resume after peer flap', () => {
  it('replays the exact missing suffix, then live chunks and done reach the new connection', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    client.emitChunk(taskId, 'Hello ');
    const live1 = await link.nextMessage();
    expect(live1).toMatchObject({ type: 'agent_chunk', request_id: 'r1', content: 'Hello ' });

    // ── Flap: two more chunks land only in the registry's accumulated.
    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    client.emitChunk(taskId, 'wor');
    client.emitChunk(taskId, 'ld');

    // ── Reconnect + resume: delta is exactly 'world' (K=6).
    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 6 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({
      type: 'agent_turn_resume_resp',
      request_id: 'r1',
      status: 'streaming',
      delta: 'world',
    });

    // Live output now routes to the new connection.
    client.emitChunk(taskId, '!');
    const live2 = await link.nextMessage();
    expect(live2).toMatchObject({ type: 'agent_chunk', request_id: 'r1', content: '!' });

    client.emitDone(taskId);
    const done = await link.nextMessage();
    expect(done).toMatchObject({ type: 'agent_done', request_id: 'r1', content: 'Hello world!' });
    link.close();
  });

  it('buffers done while disconnected and replays delta + full result on resume', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    client.emitChunk(taskId, 'Hello ');
    await link.nextMessage();

    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    client.emitChunk(taskId, 'world');
    client.emitDone(taskId);

    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 6 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({
      type: 'agent_turn_resume_resp',
      request_id: 'r1',
      status: 'done',
      delta: 'world',
      content: 'Hello world',
    });
    link.close();
  });

  it('buffers error while disconnected and replays it on resume', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    client.emitChunk(taskId, 'partial');
    await link.nextMessage();

    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    client.emitError(taskId, 'boom');

    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 7 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({
      type: 'agent_turn_resume_resp',
      request_id: 'r1',
      status: 'error',
      delta: '',
      message: 'boom',
    });
    link.close();
  });

  it('answers lost for unknown request_id; hub state wipe rebuilds from the proxy instead', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'nope', known_content_length: 0 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({ type: 'agent_turn_resume_resp', request_id: 'nope', status: 'lost' });

    // A real turn, then hub "restarts" (registry wiped): the persisted
    // mapping + the proxy's replay buffer still serve the resume.
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();
    client.emitChunk(taskId, 'partial');
    await link.nextMessage();
    resetPeerSessionsForTest();
    FakePeerAcpClient.instances = [];

    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 3 });
    const resp2 = await link.nextMessage();
    expect(resp2).toMatchObject({
      type: 'agent_turn_resume_resp',
      request_id: 'r1',
      status: 'streaming',
      delta: 'tial',
    });
    link.close();
  });

  it('repeated resume with the same offset yields the same delta (idempotent base)', async () => {
    const logLines: string[] = [];
    const link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();
    client.emitChunk(taskId, 'abcdef');
    await link.nextMessage();

    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 2 });
    const resp1 = await link.nextMessage();
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 2 });
    const resp2 = await link.nextMessage();
    expect(resp1).toMatchObject({ status: 'streaming', delta: 'cdef' });
    expect(resp2).toMatchObject({ status: 'streaming', delta: 'cdef' });

    // Advancing the offset narrows the delta.
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 4 });
    const resp3 = await link.nextMessage();
    expect(resp3).toMatchObject({ status: 'streaming', delta: 'ef' });
    link.close();
  });

  it('clamps an out-of-range known_content_length instead of failing', async () => {
    const logLines: string[] = [];
    const link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    client.emitChunk(client.firstTaskId(), 'abc');
    await link.nextMessage();

    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 9999 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({ status: 'streaming', delta: '' });
    expect(logLines.some((l) => l.includes('clamped'))).toBe(true);
    link.close();
  });

  it('done delivered live stays replayable after a subsequent flap (no false lost)', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    client.emitChunk(taskId, 'full');
    await link.nextMessage();
    client.emitDone(taskId);
    const done = await link.nextMessage();
    expect(done).toMatchObject({ type: 'agent_done', content: 'full' });

    // Flap AFTER delivery — the terminal entry must still answer resume.
    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 4 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({ status: 'done', delta: '', content: 'full' });
    link.close();
  });

  it('parks approvals raised while disconnected; verdict via deferred relay resolves the waiter once', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    // ── Flap FIRST, then the agent asks for approval while disconnected.
    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    const approvalPromise = client.emitApproval(taskId, 'perm_offline');
    // Record persisted (card replays on reconnect); nothing sent (no live conn).
    expect(getPendingApproval('perm_offline')?.status).toBe('pending');
    await waitFor(() => logLines.some((l) => l.includes('detached approval parked')));

    // Done arrives while the approval is open — deferred behind it.
    client.emitChunk(taskId, 'work');
    client.emitDone(taskId);

    // ── Reconnect: the parked card is re-sent.
    link = await connectPhone('peer1', logLines);
    const card = await link.nextMessage();
    expect(card).toMatchObject({ type: 'agent_approval_req', approval_id: 'perm_offline' });

    // ── Phone approves: verdict rides the deferred relay exactly once, the
    // parked waiter resolves {migrated}, and the deferred done reaches the
    // new connection.
    link.send({
      type: 'agent_approval_resp',
      approval_id: 'perm_offline',
      selected_action_id: 'allow',
      selected_action_label: 'Allow',
    });
    await waitFor(() => client.deferred.length === 1, 2000);
    await expect(approvalPromise).resolves.toMatchObject({ id: 'allow', migrated: true });
    // Exactly one relay — no duplicate deny from a stale waiter.
    await new Promise((r) => setTimeout(r, 300));
    expect(client.deferred.length).toBe(1);
    const done = await link.nextMessage();
    expect(done).toMatchObject({ type: 'agent_done', request_id: 'r1', content: 'work' });
    link.close();
  });

  it('routes agent_cancel to the turn via the registry, from any live connection', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_cancel', request_id: 'r1' });
    await waitFor(() => client.turns.get(taskId)?.cancelRequested === true);

    // Cancel on a terminal/unknown entry is a safe no-op.
    client.emitDone(taskId);
    link.send({ type: 'agent_cancel', request_id: 'r1' });
    link.send({ type: 'agent_cancel', request_id: 'unknown' });
    link.close();
  });

  it('keeps buffered terminal results until TTL; sweeps them after', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));
    client.emitChunk(taskId, 'data');
    client.emitDone(taskId);

    // Reaper keeps the drained client (peer↔agent link stays up) and must
    // keep the result replayable.
    reapIdlePeerSessions();
    expect(client.closed).toBe(false);
    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 0 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({ status: 'done', delta: 'data', content: 'data' });

    // Age the entry past the TTL → the reaper sweeps it. The persisted
    // mapping (hub-restart recovery path) must also be aged past ITS TTL,
    // otherwise the rebuild path resurrects the turn from the proxy.
    const entry = getPeerSessionsForTest().get('peer1')?.turns.get('r1');
    expect(entry).toBeDefined();
    entry!.terminalAt = Date.now() - 26 * 60 * 1000;
    link.close();
    reapIdlePeerSessions();
    expect(getPeerSessionsForTest().get('peer1')?.turns.has('r1') ?? false).toBe(false);
    markPeerTurnTerminal('r1', Date.now() - 26 * 60 * 1000);

    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 0 });
    const lost = await link.nextMessage();
    expect(lost).toMatchObject({ status: 'lost' });
    link.close();
  });

  it('routes output to the newest connection and falls back after it drops (glare)', async () => {
    const logLines: string[] = [];
    const linkA = await connectPhone('peer1', logLines);
    linkA.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    const linkB = await connectPhone('peer1', logLines);

    client.emitChunk(taskId, 'to-newest');
    const onB = await linkB.nextMessage();
    expect(onB).toMatchObject({ type: 'agent_chunk', content: 'to-newest' });
    // A gets nothing while B is the top route.
    const drainedA = await linkA.drain(150);
    expect(drainedA.filter((m) => m.type === 'agent_chunk')).toHaveLength(0);

    // B drops → routing falls back to A.
    linkB.close();
    await waitFor(() => logLines.filter((l) => l.includes('disconnected')).length >= 1);
    client.emitChunk(taskId, 'to-oldest');
    const onA = await linkA.nextMessage();
    expect(onA).toMatchObject({ type: 'agent_chunk', content: 'to-oldest' });
    linkA.close();
  });
});

// ── Hub restart recovery ────────────────────────────────────────────

describe('turn resume after hub restart (rebuild from proxy)', () => {
  it('rebuilds a streaming turn from the proxy replay buffer via the persisted mapping', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    client.emitChunk(taskId, 'Hello ');
    const live1 = await link.nextMessage();
    expect(live1).toMatchObject({ type: 'agent_chunk', content: 'Hello ' });

    // ── Hub "restarts": registry + clients die; the persisted turn mapping
    // and the proxy's replay buffer survive.
    resetPeerSessionsForTest();
    FakePeerAcpClient.instances = [];
    const proxy = FakePeerAcpClient.proxyTasks.get(taskId)!;
    expect(proxy).toBeDefined();
    // The turn keeps running on the proxy while the hub is down.
    proxy.accumulated += 'wor';
    proxy.accumulated += 'ld';

    // ── Phone reconnects and resumes; the hub knows nothing in memory.
    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 6 });

    // The replayed stream is folded into the rebuilt registry entry (NOT
    // live-routed — that would double-deliver); the resume response carries
    // exactly the missed suffix.
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({
      type: 'agent_turn_resume_resp',
      request_id: 'r1',
      status: 'streaming',
      delta: 'world',
    });

    // A duplicate agent_chat with the same request_id is still rejected
    // (persisted mapping survives the restart).
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi again' });
    const dup = await link.nextMessage();
    expect(dup).toMatchObject({ type: 'agent_error', request_id: 'r1', message: 'duplicate request_id' });

    // Live output keeps flowing on the rebuilt turn; completion routes too.
    const client2 = FakePeerAcpClient.instances[0];
    client2.emitChunk(taskId, '!');
    const live3 = await link.nextMessage();
    expect(live3).toMatchObject({ type: 'agent_chunk', content: '!' });
    client2.emitDone(taskId);
    const done = await link.nextMessage();
    expect(done).toMatchObject({ type: 'agent_done', request_id: 'r1', content: 'Hello world!' });
    link.close();
  });

  it('serves a turn that finished while the hub was down', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    const taskId = client.firstTaskId();

    client.emitChunk(taskId, 'Hello ');
    await link.nextMessage();
    link.close();
    await waitFor(() => logLines.some((l) => l.includes('disconnected')));

    // Hub down; the proxy finishes the turn with nobody listening.
    resetPeerSessionsForTest();
    FakePeerAcpClient.instances = [];
    const proxy = FakePeerAcpClient.proxyTasks.get(taskId)!;
    proxy.accumulated += 'world';
    proxy.status = 'done';

    link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'r1', known_content_length: 6 });
    // Terminal rebuild: the buffered result comes back in the resume
    // response itself (no separate live agent_done — that would double).
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({
      type: 'agent_turn_resume_resp',
      request_id: 'r1',
      status: 'done',
      delta: 'world',
      content: 'Hello world',
    });
    link.close();
  });

  it('still answers lost when neither registry nor proxy know the turn', async () => {
    const logLines: string[] = [];
    const link = await connectPhone('peer1', logLines);
    link.send({ type: 'agent_turn_resume_req', request_id: 'never-seen', known_content_length: 0 });
    const resp = await link.nextMessage();
    expect(resp).toMatchObject({ status: 'lost' });
    link.close();
  });
});
