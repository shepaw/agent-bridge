/**
 * Regression test for the "approval lost on a peer flap" incident.
 *
 * Old behaviour: when the peer WS dropped mid-approval (e.g. the desktop app
 * force-refreshed its connections on resume), the hub denied the approval,
 * marked the persisted record submitted, and closed all acp clients — the
 * late phone tap then hit NO MATCH / deferred miss, the deny relay raced a
 * closed client and never reached the agent, and the proxy aborted the
 * agent's task when its last hub WS went away.
 *
 * New behaviour: teardown migrates the in-memory waiter ({migrated:true}),
 * keeps the record 'pending', and keeps the peer-scoped acp client open. On
 * reconnect the pending card is re-sent and the late verdict is delivered
 * through the deferred relay on the SAME (still open) acp client.
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

// ── Fake PeerAcpClient ──────────────────────────────────────────────

const { FakePeerAcpClient } = vi.hoisted(() => {
  class FakePeerAcpClient {
    static instances: FakePeerAcpClient[] = [];
    inflightTurns = 0;
    closed = false;
    handlers?: {
      onChunk: (content: string) => void;
      onDone: (fullContent: string, metadata?: Record<string, unknown>) => void;
      onError: (message: string) => void;
      onApproval: (req: {
        confirmationId: string; taskId: string; prompt: string;
        actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
        toolKind?: string; toolCallId?: string;
      }) => Promise<{ id: string; label?: string; migrated?: boolean }>;
      onMetadata?: (metadata: Record<string, unknown>) => void;
    };
    deferred: Array<{
      taskId: string;
      confirmationId: string;
      selected: { id: string; label?: string };
    }> = [];

    constructor(..._args: unknown[]) {
      FakePeerAcpClient.instances.push(this);
    }

    get hasInflightTurns(): boolean {
      return this.inflightTurns > 0;
    }

    async chat(_req: unknown, handlers: FakePeerAcpClient['handlers']): Promise<void> {
      this.handlers = handlers;
      this.inflightTurns = 1;
      // Turn never ends on its own — the test drives its lifecycle.
      return new Promise<void>(() => {});
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
  }
  return { FakePeerAcpClient };
});

vi.mock('../src/peer/peer-acp-client.js', () => ({
  PeerAcpClient: FakePeerAcpClient,
}));

import { drivePeerConnection, reapIdlePeerSessions, resetPeerSessionsForTest } from '../src/peer/peer-connection.js';

// ── Test harness ────────────────────────────────────────────────────

let home: string;
let prevHome: string | undefined;
let cwd: string;
const servers: WebSocketServer[] = [];
const drivePromises: Promise<void>[] = [];

interface PhoneLink {
  send: (obj: Record<string, unknown>) => void;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
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
    const obj = JSON.parse(hubSessionDecrypt(phoneSession, frame.payload));
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
    close() {
      try { phoneWs.close(); } catch { /* ignore */ }
    },
  };
}

function hubSessionDecrypt(session: NoiseSession, payload: Uint8Array): string {
  return Buffer.from(session.decrypt(payload)).toString('utf-8');
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

// ── Tests ───────────────────────────────────────────────────────────

describe('peer flap mid-approval', () => {
  it('migrates the waiter, keeps record pending, keeps acp client open, and delivers the late verdict via deferred relay', async () => {
    const logLines: string[] = [];
    let link = await connectPhone('peer1', logLines);

    // Start a chat turn → fake acp client created via the shared registry.
    link.send({ type: 'agent_chat', request_id: 'r1', agent_id: 'alpha', message: 'hi' });
    await waitFor(() => FakePeerAcpClient.instances.length === 1);
    const client = FakePeerAcpClient.instances[0];
    expect(client.handlers).toBeDefined();

    // Agent raises a tool-call approval.
    const approvalPromise = client.handlers!.onApproval({
      confirmationId: 'perm_flap',
      taskId: 't1',
      prompt: 'Allow?',
      actions: [{ id: 'allow' }, { id: 'deny' }],
    });
    const card = await link.nextMessage();
    expect(card.type).toBe('agent_approval_req');
    expect(card.approval_id).toBe('perm_flap');
    expect(getPendingApproval('perm_flap')?.status).toBe('pending');

    // ── The flap: phone WS drops mid-approval.
    link.close();
    await expect(approvalPromise).resolves.toMatchObject({ id: '', migrated: true });
    await waitFor(() => logLines.some((l) => l.includes('migrate approval perm_flap')));

    // Old behaviour would have: marked submitted, closed the client.
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
      taskId: 't1',
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

    const approvalPromise = client.handlers!.onApproval({
      confirmationId: 'perm_live',
      taskId: 't2',
      prompt: 'Allow?',
      actions: [{ id: 'allow' }, { id: 'deny' }],
    });
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

  it('idle reaper closes clients only once no turn is in flight and no connection is live', async () => {
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

    // Turn drained → reaper closes the idle client.
    client.inflightTurns = 0;
    reapIdlePeerSessions();
    expect(client.closed).toBe(true);
  });
});
