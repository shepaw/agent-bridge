/**
 * Regression tests for the prompt branch of the resume relay
 * (`agent_resume_rebuild_req` → `agent_resume_rebuild_resp`).
 *
 * The frame carries two very different costs behind one name:
 *
 * - No prompt → deterministic re-derivation on the gateway (no LLM, ms).
 * - Prompt → the user wants a *rewrite*. The gateway's rebuild only stores the
 *   prompt as a standing instruction, so the relay must instead run the hub's
 *   AI polish flow (facts refresh + one chat turn + `agent.resume.summarySet`).
 *
 * These tests pin that routing, the offline fast-fail, and the fallback used
 * when the polish flow cannot read the summary back off the card.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import noiseLib from 'noise-protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrame, encodeFrame, NoiseSession, NOISE_PROLOGUE } from 'shepaw-acp-sdk';

import { addInstance, loadOrCreateHubConfig, saveHubConfig } from '../src/config.js';
import { loadOrCreatePeerIdentity } from '../src/peer/peer-identity.js';

// ── Fake PeerAcpClient ──────────────────────────────────────────────

const { FakePeerAcpClient } = vi.hoisted(() => {
  class FakePeerAcpClient {
    static instances: FakePeerAcpClient[] = [];
    /** `resumeRebuild` calls — empty proves the deterministic path was skipped. */
    resumeRebuildCalls: Array<Record<string, unknown> | undefined> = [];
    cardCalls = 0;
    onResumeChanged?: () => void;
    onTransportLost?: (taskIds?: readonly string[]) => void;

    constructor(..._args: unknown[]) {
      FakePeerAcpClient.instances.push(this);
    }

    async resumeRebuild(opts?: Record<string, unknown>): Promise<Record<string, unknown>> {
      this.resumeRebuildCalls.push(opts);
      return { description: 'rebuilt-desc', bio: 'rebuilt-bio', capabilities: [] };
    }

    async card(): Promise<Record<string, unknown>> {
      this.cardCalls += 1;
      return { description: 'card-desc', bio: 'card-bio', capabilities: [] };
    }

    close(): void {
      /* no-op */
    }
  }
  return { FakePeerAcpClient };
});

vi.mock('../src/peer/peer-acp-client.js', () => ({
  PeerAcpClient: FakePeerAcpClient,
}));

vi.mock('../src/instance-acp-rpc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/instance-acp-rpc.js')>()),
  polishInstanceResume: vi.fn(),
  rebuildInstanceResume: vi.fn(),
}));

vi.mock('../src/runtime-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime-status.js')>()),
  probeInstanceRuntime: vi.fn(),
}));

import { polishInstanceResume, rebuildInstanceResume } from '../src/instance-acp-rpc.js';
import { probeInstanceRuntime } from '../src/runtime-status.js';
import { drivePeerConnection, resetPeerSessionsForTest } from '../src/peer/peer-connection.js';

const mockPolish = vi.mocked(polishInstanceResume);
const mockRebuild = vi.mocked(rebuildInstanceResume);
const mockProbe = vi.mocked(probeInstanceRuntime);

// ── Test harness ────────────────────────────────────────────────────

let home: string;
let cwd: string;
let prevHome: string | undefined;
const servers: WebSocketServer[] = [];
const drivePromises: Promise<void>[] = [];

interface PhoneLink {
  send: (obj: Record<string, unknown>) => void;
  nextOfType: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

/** Wire up a WS + Noise pair and start drivePeerConnection on the hub side. */
async function connectPhone(peerId: string): Promise<PhoneLink> {
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

  const msg1 = phoneSession.writeHandshake1(
    Buffer.from(JSON.stringify({ type: 'reconnect', device_id: 'phone' }), 'utf-8'),
  );
  phoneWs.send(encodeFrame({ t: 'hs', payload: msg1 }));
  const [msg1Raw] = (await once(hubWs, 'message')) as [Buffer];
  hubSession.readHandshake1(decodeFrame(msg1Raw).payload);
  const msg2 = hubSession.writeHandshake2(
    Buffer.from(JSON.stringify({ type: 'reconnect_ack' }), 'utf-8'),
  );
  hubWs.send(encodeFrame({ t: 'hs', payload: msg2 }));
  const [msg2Raw] = (await once(phoneWs, 'message')) as [Buffer];
  phoneSession.readHandshake2(decodeFrame(msg2Raw).payload);

  drivePromises.push(
    drivePeerConnection({
      ws: hubWs,
      session: hubSession,
      peerIdentity: hubIdentity,
      peerId,
      log: () => undefined,
    }),
  );

  // Every decrypted frame is buffered; `nextOfType` takes the message it wants
  // and leaves the rest (agent-list pushes, pongs) for later reads.
  const buffered: Record<string, unknown>[] = [];
  phoneWs.on('message', (data) => {
    const frame = decodeFrame(data as Buffer);
    if (frame.t !== 'data') return;
    buffered.push(
      JSON.parse(Buffer.from(phoneSession.decrypt(frame.payload)).toString('utf-8')) as Record<string, unknown>,
    );
  });

  return {
    send(obj) {
      phoneWs.send(
        encodeFrame({ t: 'data', payload: phoneSession.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8')) }),
      );
    },
    nextOfType(type, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      const take = (): Record<string, unknown> | undefined => {
        const idx = buffered.findIndex((m) => m['type'] === type);
        return idx < 0 ? undefined : buffered.splice(idx, 1)[0];
      };
      const found = take();
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setInterval(() => {
          const hit = take();
          if (hit !== undefined) {
            clearInterval(timer);
            resolve(hit);
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error(`nextOfType(${type}) timeout`));
          }
        }, 20);
      });
    },
    close() {
      try { phoneWs.close(); } catch { /* ignore */ }
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-peer-resume-'));
  cwd = mkdtempSync(join(tmpdir(), 'shepaw-agent-cwd-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
  FakePeerAcpClient.instances = [];
  resetPeerSessionsForTest();
  mockPolish.mockReset();
  mockRebuild.mockReset();
  mockProbe.mockReset();

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
  await Promise.allSettled(drivePromises.splice(0));
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('agent_resume_rebuild_req routing', () => {
  it('a prompt runs the AI polish flow and returns the rewritten resume', async () => {
    mockProbe.mockResolvedValue({ availability: 'online' } as never);
    mockRebuild.mockResolvedValue(null);
    mockPolish.mockResolvedValue({
      ok: true,
      summary: 'AI 改写的简历',
      capabilities: ['x'],
      reply: 'done',
      error: null,
      elapsedMs: 12,
    });

    const link = await connectPhone('peer-resume-1');
    link.send({
      type: 'agent_resume_rebuild_req',
      request_id: 'r1',
      agent_id: 'alpha',
      prompt: '  聚焦后端架构  ',
    });

    const resp = await link.nextOfType('agent_resume_rebuild_resp');
    expect(resp['ok']).toBe(true);
    expect(resp['resume']).toBe('AI 改写的简历');
    // Facts are refreshed first, with the prompt so the gateway keeps it as a
    // standing instruction for later rebuilds.
    expect(mockRebuild).toHaveBeenCalledWith('alpha', '聚焦后端架构');
    // The agent's own label rides along so the polish prompt can name it.
    expect(mockPolish).toHaveBeenCalledWith('alpha', 'alpha', '聚焦后端架构', cwd, '');
    // The deterministic rebuild must not also run — it would overwrite the
    // freshly polished Summary. No peer ACP client is even opened.
    expect(FakePeerAcpClient.instances).toEqual([]);
    link.close();
  });

  it('no prompt stays a deterministic rebuild (no LLM, no polish)', async () => {
    const link = await connectPhone('peer-resume-2');
    link.send({ type: 'agent_resume_rebuild_req', request_id: 'r2', agent_id: 'alpha' });

    const resp = await link.nextOfType('agent_resume_rebuild_resp');
    expect(resp['ok']).toBe(true);
    // The card's `bio` wins over `description` — that is the field the app and
    // the agent list read first.
    expect(resp['resume']).toBe('rebuilt-bio');
    expect(FakePeerAcpClient.instances[0]?.resumeRebuildCalls).toEqual([{}]);
    expect(mockPolish).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
    link.close();
  });

  it('fails fast on an offline gateway instead of burning the 3-minute turn', async () => {
    mockProbe.mockResolvedValue({
      availability: 'offline',
      probeError: '网关离线，无法进行 AI 改写简历。请先启动实例。',
    } as never);

    const link = await connectPhone('peer-resume-3');
    link.send({
      type: 'agent_resume_rebuild_req',
      request_id: 'r3',
      agent_id: 'alpha',
      prompt: '换个风格',
    });

    const resp = await link.nextOfType('agent_resume_rebuild_resp');
    expect(resp['ok']).toBe(false);
    expect(resp['error']).toBe('网关离线，无法进行 AI 改写简历。请先启动实例。');
    expect(mockPolish).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
    link.close();
  });

  it('falls back to the live card when polish cannot read the summary back', async () => {
    mockProbe.mockResolvedValue({ availability: 'online' } as never);
    mockRebuild.mockResolvedValue(null);
    mockPolish.mockResolvedValue({
      ok: true,
      summary: null,
      capabilities: [],
      reply: 'done',
      error: null,
      elapsedMs: 12,
    });

    const link = await connectPhone('peer-resume-4');
    link.send({
      type: 'agent_resume_rebuild_req',
      request_id: 'r4',
      agent_id: 'alpha',
      prompt: '精简一点',
    });

    const resp = await link.nextOfType('agent_resume_rebuild_resp');
    expect(resp['ok']).toBe(true);
    expect(resp['resume']).toBe('card-bio');
    expect(FakePeerAcpClient.instances[0]?.cardCalls).toBe(1);
    link.close();
  });
});
