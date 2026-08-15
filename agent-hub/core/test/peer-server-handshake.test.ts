/**
 * Peer pairing handshake: verifies PairingResponse includes channel_endpoint
 * when a gateway tunnel is configured, including when the WS path is routed
 * through the device-level tunnel router (/peer/ws dispatch).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import noiseLib from 'noise-protocol';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  NoiseSession,
  NOISE_PROLOGUE,
} from 'shepaw-acp-sdk';

import { addInstance, loadOrCreateHubConfig, saveHubConfig, setHubGateway, type HubConfig } from '../src/config.js';
import { PeerServer } from '../src/peer/peer-server.js';
import { loadOrCreatePeerIdentity } from '../src/peer/peer-identity.js';
import { PAIRING_TTL_MS, writePairingFile } from '../src/peer/peer-pairing.js';
import { GatewayTunnelRouter } from '../src/tunnel-router.js';

let home: string;
let prevHome: string | undefined;
let peerServer: PeerServer;
let router: GatewayTunnelRouter | undefined;
let peerPort: number;
let routerPort: number;

async function freePort(): Promise<number> {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  await new Promise<void>((r) => wss.close(() => r()));
  return port;
}

/** Drive a pairing handshake and return the decrypted PairingResponse payload. */
async function pairOverWs(
  url: string,
  code: string,
): Promise<{ payload: Record<string, unknown>; initiatorKeys: { publicKey: Uint8Array; secretKey: Uint8Array } }> {
  const peerIdentity = loadOrCreatePeerIdentity();
  const initiatorKeys = noiseLib.keygen();
  const session = NoiseSession.initiator({
    staticPublicKey: initiatorKeys.publicKey,
    staticPrivateKey: initiatorKeys.secretKey,
    remoteStaticPublicKey: peerIdentity.staticPublicKey,
    prologue: NOISE_PROLOGUE,
  });

  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const msg1Payload = JSON.stringify({
    pairing_code: code,
    device_name: 'test-phone',
    device_id: 'phone-1',
  });
  ws.send(encodeFrame({ t: 'hs', payload: session.writeHandshake1(Buffer.from(msg1Payload, 'utf-8')) }));

  const msg2Raw = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 5_000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString('utf-8'));
    });
    ws.once('error', (err) => reject(err));
  });

  const frame = decodeFrame(msg2Raw);
  expect(frame.t).toBe('hs');
  const payload = JSON.parse(Buffer.from(session.readHandshake2(frame.payload)).toString('utf-8')) as Record<string, unknown>;
  try { ws.close(); } catch { /* hub may already have closed the pairing socket */ }
  return { payload, initiatorKeys };
}

/** Reconnect like the Shepaw app after pairing (fresh WS + {type:"reconnect"}). */
async function reconnectOverWs(
  url: string,
  initiatorKeys: { publicKey: Uint8Array; secretKey: Uint8Array },
): Promise<Record<string, unknown>> {
  const peerIdentity = loadOrCreatePeerIdentity();
  const session = NoiseSession.initiator({
    staticPublicKey: initiatorKeys.publicKey,
    staticPrivateKey: initiatorKeys.secretKey,
    remoteStaticPublicKey: peerIdentity.staticPublicKey,
    prologue: NOISE_PROLOGUE,
  });

  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const msg1Payload = JSON.stringify({ type: 'reconnect', device_id: 'phone-fp' });
  ws.send(encodeFrame({ t: 'hs', payload: session.writeHandshake1(Buffer.from(msg1Payload, 'utf-8')) }));

  const msg2Raw = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reconnect handshake timeout')), 5_000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString('utf-8'));
    });
    ws.once('error', (err) => reject(err));
  });
  const hsFrame = decodeFrame(msg2Raw);
  expect(hsFrame.t).toBe('hs');
  session.readHandshake2(hsFrame.payload);

  ws.send(encodeFrame({
    t: 'data',
    payload: session.encrypt(Buffer.from(JSON.stringify({ type: 'agent_list_req' }), 'utf-8')),
  }));

  const listMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent_list timeout')), 5_000);
    const onMsg = (data: WebSocket.RawData): void => {
      try {
        const frame = decodeFrame(data.toString('utf-8'));
        if (frame.t !== 'data') return;
        const obj = JSON.parse(Buffer.from(session.decrypt(frame.payload)).toString('utf-8')) as Record<string, unknown>;
        if (obj.type === 'agent_list_resp') {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(obj);
        }
      } catch {
        /* wait for the matching response frame */
      }
    };
    ws.on('message', onMsg);
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  ws.close();
  return listMsg;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-peer-handshake-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;

  peerPort = await freePort();
  routerPort = await freePort();

  const cfg = setHubGateway(loadOrCreateHubConfig(), {
    tunnel: {
      serverUrl: 'https://channel.example.com',
      channelId: 'ch_peer',
      secret: 'secret',
    },
  });
  const withInstance = addInstance(cfg, {
    id: 'alpha',
    engine: 'claude-code',
    cwd: home,
    host: '127.0.0.1',
    port: 18801,
    baseUrl: '',
    extraArgs: [],
  });
  saveHubConfig(withInstance.path, {
    ...withInstance,
    peer: { host: '127.0.0.1', port: peerPort },
  });

  writePairingFile({
    code: 'ABC234',
    expiresAt: Date.now() + PAIRING_TTL_MS,
    qrPayload: 'shepaw://peer?code=ABC234',
    localEndpoint: `ws://127.0.0.1:${peerPort}/peer/ws`,
    createdAt: Date.now(),
  });

  peerServer = new PeerServer({ host: '127.0.0.1', port: peerPort, log: () => undefined });
  await peerServer.start();

  const hubCfg = loadOrCreateHubConfig();
  router = new GatewayTunnelRouter({
    routerPort,
    loadConfig: () => hubCfg as HubConfig,
    onLog: () => undefined,
  });
  await router.start();
});

afterEach(async () => {
  if (router !== undefined) await router.stop();
  if (peerServer !== undefined) await peerServer.stop();
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('peer pairing handshake', () => {
  it('returns channel_endpoint in PairingResponse when gateway tunnel is configured', async () => {
    const { payload } = await pairOverWs(`ws://127.0.0.1:${peerPort}/peer/ws`, 'ABC234');
    expect(payload.accepted).toBe(true);
    expect(payload.local_endpoint).toMatch(/^ws:\/\//);
    expect(payload.channel_endpoint).toBe('wss://channel.example.com/proxy/ch_peer/peer/ws');
  });

  it('accepts pairing through the tunnel router /peer/ws dispatch', async () => {
    const { payload } = await pairOverWs(`ws://127.0.0.1:${routerPort}/peer/ws`, 'ABC234');
    expect(payload.accepted).toBe(true);
    expect(payload.channel_endpoint).toBe('wss://channel.example.com/proxy/ch_peer/peer/ws');
  });

  it('pushes agent_list_resp on reconnect after pairing (app flow)', async () => {
    writePairingFile({
      code: 'XYZ789',
      expiresAt: Date.now() + PAIRING_TTL_MS,
      qrPayload: 'shepaw://peer?code=XYZ789',
      localEndpoint: `ws://127.0.0.1:${peerPort}/peer/ws`,
      createdAt: Date.now(),
    });
    const { initiatorKeys } = await pairOverWs(`ws://127.0.0.1:${peerPort}/peer/ws`, 'XYZ789');
    const listMsg = await reconnectOverWs(`ws://127.0.0.1:${peerPort}/peer/ws`, initiatorKeys);
    expect(listMsg.type).toBe('agent_list_resp');
    const agents = listMsg.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe('alpha');
    expect(agents[0]!.capabilities).toEqual(['chat']);
    expect(agents[0]!.engine).toBe('claude-code');
    expect(agents[0]!.avatar).toBe('engine-avatar:claude-code');
    expect(typeof agents[0]!.avatar_data).toBe('string');
    expect((agents[0]!.avatar_data as string).length).toBeGreaterThan(20);
    expect(agents[0]!.avatar_ext).toBe('svg');
    expect(typeof agents[0]!.workspace_uri).toBe('string');
    expect(String(agents[0]!.workspace_uri)).toMatch(/^store:\/\/workspaces\//);
  });
});
