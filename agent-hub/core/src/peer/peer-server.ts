/**
 * Peer service WS server + Noise IK responder handshake.
 *
 * Listens on `/peer/ws` (default :18792). For each inbound connection:
 *   1. Noise IK responder handshake.
 *   2. msg1 payload is either a `PairingRequest` (pairing_code + device info)
 *      or a `{type:"reconnect"}` (returning paired phone).
 *   3. On pairing: constant-time code check → `PairingResponse` (accept/reject)
 *      → persist PairedPeer → hand off to `drivePeerConnection`.
 *   4. On reconnect: match pubkey against the paired store → `reconnect_ack`
 *      → hand off.
 *
 * The hub auto-accepts a pairing when the 6-char code matches (the code is the
 * auth; the operator already initiated pairing by running `peer pair`). This
 * skips the app's manual "confirm" step, which a headless hub has no UI for.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  decodeFrame,
  encodeFrame,
  NoiseSession,
  NOISE_PROLOGUE,
} from 'shepaw-acp-sdk';
import type { AgentIdentity } from 'shepaw-acp-sdk';
import { createHash } from 'node:crypto';
import { DEFAULT_PEER_HOST, DEFAULT_PEER_PORT, loadOrCreateHubConfig } from '../config.js';
import type { PeerServiceConfig } from '../config.js';
import { loadOrCreatePeerIdentity } from './peer-identity.js';
import {
  clearPairingFile,
  constantTimeEquals,
  readActivePairingFile,
  resolveLocalEndpoint,
} from './peer-pairing.js';
import { upsertPairedPeer, loadPairedPeers, type PairedPeer } from './peer-store.js';
import { drivePeerConnection } from './peer-connection.js';

export interface PeerServerOptions {
  host?: string;
  port?: number;
  log?: (line: string) => void;
}

export class PeerServer {
  private readonly identity: AgentIdentity;
  private readonly host: string;
  private readonly port: number;
  private readonly log: (line: string) => void;
  private httpServer: Server | undefined;
  private wss: WebSocketServer | undefined;

  constructor(opts: PeerServerOptions = {}) {
    this.identity = loadOrCreatePeerIdentity();
    const cfg = loadOrCreateHubConfig().peer;
    this.host = opts.host ?? cfg?.host ?? DEFAULT_PEER_HOST;
    this.port = opts.port ?? cfg?.port ?? DEFAULT_PEER_PORT;
    this.log = opts.log ?? (() => undefined);
  }

  get fingerprint(): string {
    return this.identity.fingerprint;
  }

  /** Start the WS server. Resolves when listening. */
  async start(): Promise<void> {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Duplex, head));
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, this.host, () => {
        this.log(`peer service listening on ${this.host}:${this.port}/peer/ws (fp=${this.fingerprint})`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.wss !== undefined) {
      for (const client of this.wss.clients) client.close();
    }
    await new Promise<void>((resolve) => {
      if (this.httpServer !== undefined) this.httpServer.close(() => resolve());
      else resolve();
    });
  }

  /** List currently-paired devices (from the persistent store). */
  listPairedDevices(): PairedPeer[] {
    return loadPairedPeers();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? '';
    if (!url.startsWith('/peer/ws')) {
      socket.destroy();
      return;
    }
    this.wss!.handleUpgrade(req, socket as unknown as Socket, head, (ws) => {
      void this.handleConnection(ws).catch((err) => {
        this.log(`peer connection error: ${err instanceof Error ? err.message : String(err)}`);
        try { ws.close(); } catch { /* ignore */ }
      });
    });
  }

  private async handleConnection(ws: WebSocket): Promise<void> {
    const session = NoiseSession.responder(this.identity, NOISE_PROLOGUE);

    // Wait for msg1 (30s).
    const msg1Raw = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        ws.off('message', onMsg);
        resolve(undefined);
      }, 30_000);
      const onMsg = (data: WebSocket.RawData): void => {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(data.toString('utf-8'));
      };
      ws.once('message', onMsg);
      ws.once('close', () => { clearTimeout(timer); resolve(undefined); });
    });
    if (msg1Raw === undefined) {
      this.log('peer handshake timeout (no msg1)');
      ws.close();
      return;
    }

    let frame;
    try {
      frame = decodeFrame(msg1Raw);
    } catch {
      ws.close();
      return;
    }
    if (frame.t !== 'hs') { ws.close(); return; }

    let hsResult;
    try {
      hsResult = session.readHandshake1(frame.payload);
    } catch {
      this.log('peer handshake1 failed (decrypt)');
      ws.close();
      return;
    }
    const peerStaticPubkey = hsResult.peerStaticPublicKey;
    const peerFingerprint = fingerprintFromPubkey(peerStaticPubkey);
    let payloadObj: Record<string, unknown>;
    try {
      payloadObj = JSON.parse(Buffer.from(hsResult.msg1Payload).toString('utf-8')) as Record<string, unknown>;
    } catch {
      payloadObj = {};
    }

    // Pairing vs reconnect dispatch.
    if (typeof payloadObj.pairing_code === 'string') {
      await this.handlePairing(ws, session, payloadObj, peerStaticPubkey, peerFingerprint);
    } else if (payloadObj.type === 'reconnect') {
      await this.handleReconnect(ws, session, peerStaticPubkey, peerFingerprint);
    } else {
      this.log(`peer ${peerFingerprint}: unrecognized msg1 payload`);
      ws.close();
    }
  }

  private async handlePairing(
    ws: WebSocket,
    session: NoiseSession,
    req: Record<string, unknown>,
    peerPubkey: Uint8Array,
    peerFingerprint: string,
  ): Promise<void> {
    const code = req.pairing_code as string;
    // The active code is written to peer-pairing.json by `peer pair` (CLI).
    // Read it fresh here so the daemon stays stateless across restarts.
    const active = readActivePairingFile();
    const codeOk = active !== undefined && constantTimeEquals(code, active.code);

    if (!codeOk) {
      const resp = {
        accepted: false,
        device_name: 'shepaw-hub',
        device_id: this.identity.fingerprint,
        peer_id: '',
        reject_reason: 'Invalid or expired pairing code',
      };
      try {
        const msg2 = session.writeHandshake2(Buffer.from(JSON.stringify(resp), 'utf-8'));
        ws.send(encodeFrame({ t: 'hs', payload: msg2 }));
      } catch { /* ignore */ }
      this.log(`peer ${peerFingerprint}: pairing rejected (bad code)`);
      ws.close();
      return;
    }

    // Accept.
    const peerId = randomUUID();
    const localEndpoint = resolveLocalEndpoint(this.port, this.host);
    const resp = {
      accepted: true,
      device_name: 'shepaw-hub',
      device_id: this.identity.fingerprint,
      peer_id: peerId,
      local_endpoint: localEndpoint,
    };
    const msg2 = session.writeHandshake2(Buffer.from(JSON.stringify(resp), 'utf-8'));
    ws.send(encodeFrame({ t: 'hs', payload: msg2 }));

    // Consume the code (single-use) + persist the peer.
    clearPairingFile();
    const pubB64 = Buffer.from(peerPubkey).toString('base64');
    upsertPairedPeer({
      id: peerId,
      deviceName: (req.device_name as string | undefined) ?? 'device',
      deviceId: (req.device_id as string | undefined) ?? peerFingerprint,
      publicKey: pubB64,
      fingerprint: peerFingerprint,
      localEndpoint: (req.local_endpoint as string | undefined),
      channelEndpoint: (req.channel_endpoint as string | undefined),
      pairedAt: new Date().toISOString(),
    });
    this.log(`peer ${peerFingerprint} paired (id=${peerId}, name=${req.device_name ?? '?'})`);

    await drivePeerConnection({ ws, session, peerIdentity: this.identity, peerId, log: this.log });
  }

  private async handleReconnect(
    ws: WebSocket,
    session: NoiseSession,
    peerPubkey: Uint8Array,
    peerFingerprint: string,
  ): Promise<void> {
    const pubB64 = Buffer.from(peerPubkey).toString('base64');
    const peer = loadPairedPeers().find((p) => p.publicKey === pubB64);
    if (peer === undefined) {
      this.log(`reconnect from unknown peer ${peerFingerprint} — rejecting`);
      ws.close();
      return;
    }
    const ack = { type: 'reconnect_ack', device_id: this.identity.fingerprint };
    try {
      const msg2 = session.writeHandshake2(Buffer.from(JSON.stringify(ack), 'utf-8'));
      ws.send(encodeFrame({ t: 'hs', payload: msg2 }));
    } catch {
      ws.close();
      return;
    }
    this.log(`peer ${peerFingerprint} reconnected`);
    await drivePeerConnection({ ws, session, peerIdentity: this.identity, peerId: peer.id, log: this.log });
  }
}

/** SHA-256(pubkey)[0:8] hex — matches the app's fingerprint scheme. */
function fingerprintFromPubkey(pub: Uint8Array): string {
  return createHash('sha256').update(pub).digest().subarray(0, 8).toString('hex');
}

/** Resolve effective peer config (host/port) without starting the server. */
export function resolvePeerConfig(): PeerServiceConfig {
  const cfg = loadOrCreateHubConfig().peer;
  return {
    host: cfg?.host ?? DEFAULT_PEER_HOST,
    port: cfg?.port ?? DEFAULT_PEER_PORT,
  };
}
