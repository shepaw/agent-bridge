/**
 * Shared v2-protocol test client used across `server.test.ts`, `tunnel.test.ts`,
 * and any other integration-level tests.
 *
 * Performs the Noise IK handshake, then auto-decrypts/encrypts every frame so
 * the tests can pretend they're talking plain JSON-RPC — the envelope and
 * crypto layer is hidden. This matches how the Flutter app will behave once
 * Step 4 (Flutter side) lands.
 */

import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import type { ACPAgentServer } from '../src/server.js';
import { decodeFrame, encodeFrame } from '../src/envelope.js';
import { NoiseSession, NOISE_PROLOGUE } from '../src/noise.js';
import type {
  JsonRpcNotification,
  JsonRpcResponse,
} from '../src/types.js';

import noiseLib from 'noise-protocol';

/** One independent "app" side, running the Noise initiator half. */
export class V2TestClient {
  private readonly ws: WebSocket;
  private readonly messages: Array<Record<string, unknown>> = [];
  private readonly messageHandlers: Array<(m: Record<string, unknown>) => void> = [];
  private nextId = 1;
  private closed = false;
  private session: NoiseSession | undefined;
  private readonly ready: Promise<void>;
  private _lastCloseCode: number | undefined;
  private readonly closeWaiters: Array<(code: number | undefined) => void> = [];
  private _staticPublicKey!: Uint8Array;

  /**
   * The static X25519 public key this test client presented during Noise
   * handshake msg 1. Tests use this to pre-seed `authorized_peers.json`
   * before connecting, or to verify that the agent saw the expected peer.
   */
  get staticPublicKey(): Uint8Array {
    return this._staticPublicKey;
  }

  constructor(
    url: string,
    responderStaticPublicKey: Uint8Array,
    opts: {
      agentId?: string;
      /**
       * Optional fixed keypair for the test client's static X25519 identity.
       * When omitted, a fresh ephemeral pair is generated — use that for
       * "unknown peer" scenarios. When provided, tests can match the resulting
       * public key against a pre-seeded `authorized_peers.json` to simulate a
       * paired app.
       */
      staticKeypair?: { publicKey: Uint8Array; privateKey: Uint8Array };
      /**
       * Optional enrollment code to carry in the Noise msg1 payload. Simulates
       * an app that scanned an `enroll` QR / typed the short code. The server
       * will consume it and auto-add this client's pubkey to the allowlist if
       * the code validates.
       */
      enroll?: string;
    } = {},
  ) {
    const kp = opts.staticKeypair ?? (() => {
      const k = noiseLib.keygen();
      return { publicKey: k.publicKey, privateKey: k.secretKey };
    })();
    const session = NoiseSession.initiator({
      staticPublicKey: kp.publicKey,
      staticPrivateKey: kp.privateKey,
      remoteStaticPublicKey: responderStaticPublicKey,
      prologue: NOISE_PROLOGUE,
    });
    this._staticPublicKey = kp.publicKey;

    // v2.1: no token query param, no Authorization header. Authorization
    // happens via public-key allowlist after the Noise handshake.
    const ws = new WebSocket(url);
    this.ws = ws;

    // Record the first close code we see — any subsequent handlers can read
    // `closeCode` even after the socket is gone.
    ws.on('close', (code) => {
      this.closed = true;
      if (this._lastCloseCode === undefined) {
        this._lastCloseCode = code;
      }
      for (const w of this.closeWaiters.splice(0)) w(this._lastCloseCode);
    });

    this.ready = (async () => {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('close', (code) => reject(new Error(`ws closed before open (code ${code})`)));
      });

      // Drive the Noise handshake.
      const msg1PayloadObj: Record<string, unknown> = {
        agentId: opts.agentId ?? '',
        clientVersion: 'v2testclient/1.0',
      };
      if (opts.enroll !== undefined && opts.enroll.length > 0) {
        msg1PayloadObj.enroll = opts.enroll;
      }
      const msg1Payload = JSON.stringify(msg1PayloadObj);
      const msg1 = session.writeHandshake1(Buffer.from(msg1Payload, 'utf-8'));
      ws.send(encodeFrame({ t: 'hs', payload: msg1 }));

      // Wait for the server's handshake response.
      const msg2Raw = await new Promise<string>((resolve, reject) => {
        const onMsg = (data: WebSocket.RawData) => {
          cleanup();
          resolve(data.toString('utf-8'));
        };
        const onClose = (code: number) => {
          cleanup();
          reject(new Error(`ws closed before handshake 2 (code ${code})`));
        };
        const cleanup = (): void => {
          ws.off('message', onMsg);
          ws.off('close', onClose);
        };
        ws.once('message', onMsg);
        ws.once('close', onClose);
      });
      const msg2Frame = decodeFrame(msg2Raw);
      if (msg2Frame.t !== 'hs') {
        throw new Error(`expected hs frame, got ${msg2Frame.t}`);
      }
      session.readHandshake2(msg2Frame.payload);
      this.session = session;

      // Attach the real data-frame handler.
      ws.on('message', (data) => {
        try {
          const frame = decodeFrame(data.toString('utf-8'));
          if (frame.t === 'data') {
            const plaintext = session.decrypt(frame.payload);
            const obj = JSON.parse(Buffer.from(plaintext).toString('utf-8')) as Record<
              string,
              unknown
            >;
            this.messages.push(obj);
            for (const handler of this.messageHandlers) handler(obj);
          }
        } catch {
          /* swallow — test client is permissive */
        }
      });
    })();
    // Swallow uncaught promise rejection for the case where callers just test
    // `waitForClose()` without awaiting `waitReady()`.
    this.ready.catch(() => undefined);
  }

  waitReady(): Promise<void> {
    return this.ready;
  }

  sendRaw(msg: unknown): void {
    if (this.session === undefined) {
      throw new Error('session not yet ready');
    }
    const json = JSON.stringify(msg);
    const ct = this.session.encrypt(Buffer.from(json, 'utf-8'));
    this.ws.send(encodeFrame({ t: 'data', payload: ct }));
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse & { result?: T }> {
    const id = this.nextId++;
    this.sendRaw({ jsonrpc: '2.0', id, method, params });
    return (await this.waitFor((m) => typeof m.id === 'number' && m.id === id)) as unknown as
      JsonRpcResponse & { result?: T };
  }

  async waitFor(
    pred: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const existing = this.messages.find(pred);
    if (existing !== undefined) return existing;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const idx = this.messageHandlers.indexOf(handler);
          if (idx >= 0) this.messageHandlers.splice(idx, 1);
          reject(new Error(`V2TestClient.waitFor timed out after ${timeoutMs}ms`));
        },
        timeoutMs,
      );
      const handler = (msg: Record<string, unknown>) => {
        if (pred(msg)) {
          clearTimeout(timer);
          const idx = this.messageHandlers.indexOf(handler);
          if (idx >= 0) this.messageHandlers.splice(idx, 1);
          resolve(msg);
        }
      };
      this.messageHandlers.push(handler);
    });
  }

  async waitForNotification(method: string, timeoutMs = 3000): Promise<JsonRpcNotification> {
    return (await this.waitFor(
      (m) => m.method === method && m.id === undefined,
      timeoutMs,
    )) as unknown as JsonRpcNotification;
  }

  get allMessages(): ReadonlyArray<Record<string, unknown>> {
    return this.messages;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Raw WebSocket close code from the server, available after close. */
  get closeCode(): number | undefined {
    return this._lastCloseCode;
  }

  async waitForClose(timeoutMs = 3000): Promise<number | undefined> {
    if (this.closed) return this._lastCloseCode;
    return new Promise<number | undefined>((resolve) => {
      const t = setTimeout(() => {
        const idx = this.closeWaiters.indexOf(w);
        if (idx >= 0) this.closeWaiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const w = (code: number | undefined) => {
        clearTimeout(t);
        resolve(code);
      };
      this.closeWaiters.push(w);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.ws.close();
    await new Promise<void>((resolve) => this.ws.once('close', resolve));
  }
}

/** Spin up the agent's HTTP+WS server on an ephemeral port. */
export async function startAgent(
  agent: ACPAgentServer,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const { httpServer, wsServer } = agent.createServer();
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port,
    stop: async () => {
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await agent.close().catch(() => undefined);
    },
  };
}
