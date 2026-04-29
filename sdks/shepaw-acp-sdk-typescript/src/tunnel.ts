/**
 * Channel Tunnel client for shepaw-acp-sdk.
 *
 * Port of the Python `shepaw_acp_sdk.tunnel` module. Wire-compatible with
 * the Shepaw Channel Service's `tunnel-http` / `tunnel-ws` protocol.
 *
 * Protocol messages (JSON, sent over the control WebSocket):
 *   request      — HTTP request forwarded from the Channel Service
 *   response     — HTTP response sent back to the Channel Service
 *   ws_connect   — new WebSocket stream
 *   ws_data      — WebSocket frame (body is base64)
 *   ws_close     — close a WebSocket stream
 *   ping         — heartbeat from server
 *   pong         — heartbeat reply
 *   close        — server is closing the tunnel (e.g. secret rotated)
 *
 * Usage:
 * ```ts
 * const config = new ChannelTunnelConfig({
 *   serverUrl: 'https://channel.example.com',
 *   channelId: 'ch_abc123',
 *   secret: 'ch_sec_xyz',
 * });
 *
 * await agent.runWithTunnel(config, { port: 8080 });
 * ```
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';

import { WebSocket } from 'ws';

// ── Configuration ───────────────────────────────────────────────────

export interface ChannelTunnelConfigInit {
  serverUrl: string;
  channelId: string;
  secret: string;
  /** Optional short-name endpoint. Without it, URLs are `/proxy/<channel_id>`. */
  channelEndpoint?: string;
  /** Unused by the Node SDK; kept for config-dict compatibility with the app. */
  autoConnect?: boolean;
}

export class ChannelTunnelConfig {
  readonly serverUrl: string;
  readonly channelId: string;
  readonly secret: string;
  readonly channelEndpoint: string;
  readonly autoConnect: boolean;

  constructor(init: ChannelTunnelConfigInit) {
    this.serverUrl = init.serverUrl;
    this.channelId = init.channelId;
    this.secret = init.secret;
    this.channelEndpoint = init.channelEndpoint ?? '';
    this.autoConnect = init.autoConnect ?? false;
  }

  /** Public WebSocket URL the Shepaw app should paste into the "remote agent" field. */
  getPublicEndpoint(
    opts: { agentId?: string; fingerprint?: string } = {},
  ): string {
    const base = this.serverUrl.replace(/\/+$/, '');
    const wsBase = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const path = this.channelEndpoint
      ? `/c/${this.channelEndpoint}/acp/ws`
      : `/proxy/${this.channelId}/acp/ws`;
    const params: string[] = [];
    // v2.1: no `token=` here. Authorization is per-peer public key (see
    // `authorized_peers.json` on the agent side); the pairing URL carries only
    // the agentId (as a routing/UX hint) and the fingerprint (to pin the
    // server's static public key at handshake time).
    if (opts.agentId) params.push(`agentId=${encodeURIComponent(opts.agentId)}`);
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    // Fingerprint goes in the URI fragment so it is NOT sent to the Channel Service
    // in the WebSocket upgrade request — fragments are client-side only.
    const fragment = opts.fingerprint ? `#fp=${encodeURIComponent(opts.fingerprint)}` : '';
    return `${wsBase}${path}${query}${fragment}`;
  }

  toDict(): Record<string, unknown> {
    return {
      server_url: this.serverUrl,
      channel_id: this.channelId,
      secret: this.secret,
      channel_endpoint: this.channelEndpoint,
      auto_connect: this.autoConnect,
    };
  }

  static fromDict(d: Record<string, unknown>): ChannelTunnelConfig {
    return new ChannelTunnelConfig({
      serverUrl: String(d.server_url),
      channelId: String(d.channel_id),
      secret: String(d.secret),
      channelEndpoint: typeof d.channel_endpoint === 'string' ? d.channel_endpoint : '',
      autoConnect: Boolean(d.auto_connect),
    });
  }

  /** Read config from env vars used by the Python example (returns `undefined` if missing). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ChannelTunnelConfig | undefined {
    const serverUrl = env.PAW_ACP_TUNNEL_SERVER_URL;
    const channelId = env.PAW_ACP_TUNNEL_CHANNEL_ID;
    const secret = env.PAW_ACP_TUNNEL_SECRET;
    if (!serverUrl || !channelId || !secret) return undefined;
    return new ChannelTunnelConfig({
      serverUrl,
      channelId,
      secret,
      channelEndpoint: env.PAW_ACP_TUNNEL_ENDPOINT ?? '',
    });
  }
}

// ── Tunnel protocol message ─────────────────────────────────────────

interface TunnelMessage {
  type: string;
  stream_id?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  status?: number;
  /** base64-encoded payload */
  body?: string;
  error?: string;
  /** 1 = text, 2 = binary */
  ws_msg_type?: number;
}

// ── TunnelClient ────────────────────────────────────────────────────

export interface TunnelClientOptions {
  config: ChannelTunnelConfig;
  localHost?: string;
  localPort: number;
  /**
   * Called when the reconnect loop logs a significant event. Use to wire the
   * tunnel into your app's logger.
   */
  onLog?: (line: string) => void;
}

export class TunnelClient {
  private readonly config: ChannelTunnelConfig;
  private readonly localHost: string;
  private readonly localPort: number;
  private readonly log: (line: string) => void;

  private running = false;
  private stopRequested = false;
  private ws: WebSocket | undefined;
  private loopTask: Promise<void> | undefined;
  private keepaliveTimer: NodeJS.Timeout | undefined;

  /** per-stream queues: stream_id → per-stream message buffer & resolver */
  private readonly wsStreams = new Map<number, StreamQueue>();

  constructor(opts: TunnelClientOptions) {
    this.config = opts.config;
    this.localHost = opts.localHost ?? '127.0.0.1';
    this.localPort = opts.localPort;
    this.log = opts.onLog ?? ((line) => console.log(line));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.loopTask = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    await this.disconnect();
    if (this.loopTask) {
      await this.loopTask.catch(() => undefined);
      this.loopTask = undefined;
    }
  }

  // ── reconnect loop ──────────────────────────────────────────

  private async runLoop(): Promise<void> {
    let backoff = 2.0;
    const maxBackoff = 60.0;

    while (this.running && !this.stopRequested) {
      try {
        await this.connect();
        this.log(`[Tunnel] Connected to ${this.config.serverUrl}`);
        backoff = 2.0;
        await this.listen();
      } catch (err) {
        if (this.stopRequested) break;
        this.log(`[Tunnel] Connection error: ${formatErr(err)}`);
      }

      if (this.stopRequested || !this.running) break;
      this.log(`[Tunnel] Reconnecting in ${backoff.toFixed(0)}s...`);
      await sleep(backoff * 1000);
      backoff = Math.min(backoff * 2, maxBackoff);
    }

    this.log('[Tunnel] Tunnel client stopped');
  }

  // ── connect / disconnect ────────────────────────────────────

  private connect(): Promise<void> {
    const base = this.config.serverUrl.replace(/\/+$/, '');
    const wsBase = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

    // HMAC-SHA256 签名认证（密钥不上线）
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signingString = `${this.config.channelId}\n${timestamp}\n${nonce}`;
    const signature = createHmac('sha256', this.config.secret)
      .update(signingString)
      .digest('hex');

    const url =
      `${wsBase}/tunnel/connect` +
      `?channel_id=${encodeURIComponent(this.config.channelId)}` +
      `&timestamp=${encodeURIComponent(timestamp)}` +
      `&nonce=${encodeURIComponent(nonce)}` +
      `&signature=${encodeURIComponent(signature)}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        handshakeTimeout: 30_000,
      });
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      const onOpen = () => {
        ws.off('error', onError);
        this.ws = ws;
        // Respond to server pings.
        ws.on('ping', () => {
          try {
            ws.pong();
          } catch {
            /* ignore */
          }
        });
        // Send a JSON-level `ping` every 20s so the tunnel stays alive even
        // through NAT/proxy paths that drop idle WS connections silently.
        // Matches the 30s server-side ping cadence but with margin.
        this.startKeepalive();
        resolve();
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  private async disconnect(): Promise<void> {
    this.stopKeepalive();
    // Drain per-stream queues so their forwarders exit.
    for (const [, q] of this.wsStreams) {
      q.push({ type: 'ws_close' });
    }
    this.wsStreams.clear();

    if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = undefined;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const ws = this.ws;
      if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* ignore — reconnect loop will handle a dead socket */
      }
    }, 20_000);
    // Don't keep the Node event loop alive just for the keepalive.
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  // ── main listen loop ────────────────────────────────────────

  private listen(): Promise<void> {
    const ws = this.ws;
    if (ws === undefined) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData) => {
        let data: TunnelMessage;
        try {
          data = JSON.parse(raw.toString('utf-8')) as TunnelMessage;
        } catch (err) {
          this.log(`[Tunnel] Failed to parse message: ${formatErr(err)}`);
          return;
        }
        void this.dispatch(data);
      };
      const cleanup = () => {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
    });
  }

  private async dispatch(msg: TunnelMessage): Promise<void> {
    switch (msg.type) {
      case 'ping':
        await this.send({ type: 'pong' });
        return;
      case 'request':
        void this.forwardHttp(msg);
        return;
      case 'ws_connect':
        void this.forwardWsConnect(msg);
        return;
      case 'ws_data':
      case 'ws_close': {
        if (msg.stream_id === undefined) return;
        const q = this.wsStreams.get(msg.stream_id);
        if (q !== undefined) q.push(msg);
        return;
      }
      case 'close':
        this.log('[Tunnel] Server closed tunnel (secret may have been rotated)');
        if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.close();
          } catch {
            /* ignore */
          }
        }
        return;
      default:
        this.log(`[Tunnel] Unknown message type: ${msg.type}`);
    }
  }

  // ── HTTP forwarding ─────────────────────────────────────────

  private async forwardHttp(req: TunnelMessage): Promise<void> {
    const streamId = req.stream_id ?? 0;
    try {
      const bodyBytes =
        req.body !== undefined && req.body.length > 0
          ? Buffer.from(req.body, 'base64')
          : undefined;

      const localUrl = `http://${this.localHost}:${this.localPort}${req.path ?? ''}`;

      const skip = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
      const fwdHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
      }

      const method = (req.method ?? 'GET').toUpperCase();

      const init: RequestInit = { method, headers: fwdHeaders, redirect: 'manual' };
      // Only GET/HEAD are allowed to omit body; others may legitimately have one.
      if (method !== 'GET' && method !== 'HEAD' && bodyBytes !== undefined) {
        init.body = bodyBytes;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);
      init.signal = controller.signal;

      let resp: Response;
      try {
        resp = await fetch(localUrl, init);
      } finally {
        clearTimeout(timeoutId);
      }

      const respBody = Buffer.from(await resp.arrayBuffer());
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of resp.headers) {
        if (k.toLowerCase() !== 'transfer-encoding' && k.toLowerCase() !== 'connection') {
          respHeaders[k] = v;
        }
      }

      await this.send({
        type: 'response',
        stream_id: streamId,
        status: resp.status,
        headers: respHeaders,
        body: respBody.toString('base64'),
      });
    } catch (err) {
      this.log(`[Tunnel] HTTP forward error stream=${streamId}: ${formatErr(err)}`);
      await this.send({
        type: 'response',
        stream_id: streamId,
        status: 502,
        error: `local request error: ${formatErr(err)}`,
      });
    }
  }

  // ── WebSocket forwarding ────────────────────────────────────

  private async forwardWsConnect(req: TunnelMessage): Promise<void> {
    const streamId = req.stream_id ?? 0;
    let path = req.path ?? '';
    const proxyPrefix = `/proxy/${this.config.channelId}`;
    if (path.startsWith(proxyPrefix)) {
      path = path.slice(proxyPrefix.length);
    } else if (this.config.channelEndpoint) {
      const shortPrefix = `/c/${this.config.channelEndpoint}`;
      if (path.startsWith(shortPrefix)) path = path.slice(shortPrefix.length);
    } else {
      // No `channelEndpoint` configured, but the relay may still route this
      // channel via a short-name slug it assigned. Strip any `/c/<slug>` prefix
      // so local path matching ("/acp/ws") still works.
      const m = /^\/c\/[^/]+/.exec(path);
      if (m !== null) path = path.slice(m[0].length);
    }
    const localWsUrl = `ws://${this.localHost}:${this.localPort}${path}`;

    this.log(`[Tunnel] ws_connect stream=${streamId} '${req.path}' → '${localWsUrl}'`);

    // Register the per-stream queue BEFORE connecting so messages that arrive
    // during the handshake aren't lost.
    const queue = new StreamQueue();
    this.wsStreams.set(streamId, queue);

    const skipWs = new Set([
      'host',
      'upgrade',
      'connection',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-extensions',
    ]);
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!skipWs.has(k.toLowerCase())) fwdHeaders[k] = v;
    }

    let localWs: WebSocket;
    try {
      localWs = await openWs(localWsUrl, fwdHeaders);
    } catch (err) {
      this.log(`[Tunnel] WS connect to local failed (${localWsUrl}): ${formatErr(err)}`);
      await this.send({ type: 'ws_close', stream_id: streamId });
      this.wsStreams.delete(streamId);
      return;
    }

    let bothClosed = false;
    const closeAll = async () => {
      if (bothClosed) return;
      bothClosed = true;
      if (localWs.readyState === WebSocket.OPEN) {
        try {
          localWs.close();
        } catch {
          /* ignore */
        }
      }
      await this.send({ type: 'ws_close', stream_id: streamId });
      this.wsStreams.delete(streamId);
    };

    // local → tunnel
    localWs.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        void this.send({
          type: 'ws_data',
          stream_id: streamId,
          body: buf.toString('base64'),
          ws_msg_type: 2,
        });
      } else {
        const str = typeof data === 'string' ? data : data.toString('utf-8');
        void this.send({
          type: 'ws_data',
          stream_id: streamId,
          body: Buffer.from(str, 'utf-8').toString('base64'),
          ws_msg_type: 1,
        });
      }
    });
    localWs.on('close', () => void closeAll());
    localWs.on('error', (err) => {
      this.log(`[Tunnel] local→tunnel error stream=${streamId}: ${formatErr(err)}`);
      void closeAll();
    });

    // tunnel → local (drain the queue until ws_close)
    void (async () => {
      try {
        for (;;) {
          const tm = await queue.pop();
          if (tm.type === 'ws_close') break;
          if (tm.type === 'ws_data' && typeof tm.body === 'string') {
            const raw = Buffer.from(tm.body, 'base64');
            if (tm.ws_msg_type === 1) {
              localWs.send(raw.toString('utf-8'));
            } else {
              localWs.send(raw, { binary: true });
            }
          }
        }
      } catch (err) {
        this.log(`[Tunnel] tunnel→local error stream=${streamId}: ${formatErr(err)}`);
      } finally {
        await closeAll();
      }
    })();
  }

  // ── send helper ─────────────────────────────────────────────

  private async send(msg: TunnelMessage): Promise<void> {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
    await new Promise<void>((resolve) => {
      ws.send(JSON.stringify(msg), (err) => {
        if (err) this.log(`[Tunnel] send failed: ${formatErr(err)}`);
        resolve();
      });
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/** A tiny async queue: `push()` is sync, `pop()` awaits. */
class StreamQueue {
  private readonly buffer: TunnelMessage[] = [];
  private readonly waiters: Array<(m: TunnelMessage) => void> = [];

  push(msg: TunnelMessage): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(msg);
    else this.buffer.push(msg);
  }

  pop(): Promise<TunnelMessage> {
    const queued = this.buffer.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<TunnelMessage>((resolve) => this.waiters.push(resolve));
  }
}

function openWs(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000 });
    const onError = (err: Error) => {
      ws.off('open', onOpen);
      reject(err);
    };
    const onOpen = () => {
      ws.off('error', onError);
      resolve(ws);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
