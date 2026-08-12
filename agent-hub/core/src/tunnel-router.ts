/**
 * Device-level tunnel router.
 *
 * The gateway refactor collapses the old "one Channel Service channel per
 * agent" model into "one channel per device". A single long-lived router
 * process owns exactly one {@link TunnelClient} (the reverse tunnel to the
 * Channel Service) and a local dispatch server. Incoming public WebSocket
 * connections arrive at a routing path:
 *
 *   wss://<server>/proxy/<channelId>/p/<instanceId>/acp/ws?agentId=...#fp&pk
 *
 * The TunnelClient strips the `/proxy/<channelId>` (or `/c/<alias>`) prefix
 * and forwards to `ws://127.0.0.1:<routerPort>/p/<instanceId>/acp/ws?...`.
 * This router then peels the `/p/<instanceId>` (or `/a/<agentId>`) segment,
 * looks up the matching agent's loopback port, and proxies the *still
 * Noise-encrypted* frames straight through. The router never terminates the
 * Noise session — end-to-end encryption stays app ↔ agent, and each agent
 * keeps its own identity / fingerprint / public key.
 *
 * HTTP requests are handled too: `/health` returns router health; a
 * `/p/<id>/…` or `/a/<id>/…` prefix is proxied to the matching agent's HTTP
 * endpoint (used by the app's `/health` probe over the tunnel).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';
import { ChannelTunnelConfig, TunnelClient, loadOrCreateIdentity } from 'shepaw-acp-sdk';

import { loadOrCreateHubConfig, type HubConfig, type InstanceConfig, DEFAULT_PEER_HOST, DEFAULT_PEER_PORT } from './config.js';
import { instancePaths } from './paths.js';
import { AgentRegistry } from './registry.js';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

export interface GatewayRouterOptions {
  /** Loopback host to bind the dispatch server to. Default `127.0.0.1`. */
  routerHost?: string;
  /** Local port the dispatch server listens on. */
  routerPort: number;
  /** Optional shared Channel Service tunnel. When omitted, LAN-only. */
  tunnel?: ChannelTunnelConfig;
  /** Log sink. Defaults to `console.log`. */
  onLog?: (line: string) => void;
  /** Hub config loader (injectable for tests). Defaults to on-disk config. */
  loadConfig?: () => HubConfig;
}

interface RouteTarget {
  instanceId: string;
  host: string;
  port: number;
}

interface ParsedRoute {
  /** Routing key parsed from the path prefix, if any. */
  key: { type: 'instance' | 'agent'; value: string } | null;
  /** Remaining local path after stripping the routing prefix (starts with `/`). */
  localPath: string;
}

export class GatewayTunnelRouter {
  private readonly routerHost: string;
  private readonly routerPort: number;
  private readonly tunnelConfig: ChannelTunnelConfig | undefined;
  private readonly log: (line: string) => void;
  private readonly loadConfig: () => HubConfig;

  private httpServer: Server | undefined;
  private wsServer: WebSocketServer | undefined;
  private tunnelClient: TunnelClient | undefined;
  private registry: AgentRegistry | undefined;

  /** Cache of agentId → instanceId, rebuilt lazily. Cheap; identities are tiny. */
  private agentIdCache: Map<string, string> | undefined;

  constructor(opts: GatewayRouterOptions) {
    this.routerHost = opts.routerHost ?? '127.0.0.1';
    this.routerPort = opts.routerPort;
    this.tunnelConfig = opts.tunnel;
    this.log = opts.onLog ?? ((line) => console.log(line));
    this.loadConfig = opts.loadConfig ?? (() => loadOrCreateHubConfig());
  }

  async start(): Promise<void> {
    const httpServer = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.log(`[Router] HTTP handler error: ${formatErr(err)}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: formatErr(err) }));
      });
    });

    const wsServer = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(wsServer, req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(this.routerPort, this.routerHost, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });

    this.httpServer = httpServer;
    this.wsServer = wsServer;
    this.log(`[Router] Dispatch server on ${this.routerHost}:${this.routerPort}`);

    if (this.tunnelConfig !== undefined) {
      this.tunnelClient = new TunnelClient({
        config: this.tunnelConfig,
        localHost: this.routerHost,
        localPort: this.routerPort,
        onLog: (line) => this.log(line),
      });
      await this.tunnelClient.start();
      this.log(`[Router] Channel tunnel started → ${this.tunnelConfig.serverUrl}`);

      // 设备级隧道不带单一 agent 身份；各实例经 REST 注册到 channel 注册中心
      // （兼作心跳，失败不影响路由）。
      this.registry = new AgentRegistry({
        serverUrl: this.tunnelConfig.serverUrl,
        channelId: this.tunnelConfig.channelId,
        secret: this.tunnelConfig.secret,
        loadConfig: this.loadConfig,
        onLog: (line) => this.log(line),
      });
      this.registry.start();
    } else {
      this.log('[Router] No channel tunnel configured (LAN-only dispatch).');
    }
  }

  async stop(): Promise<void> {
    if (this.registry !== undefined) {
      this.registry.stop();
      this.registry = undefined;
    }
    if (this.tunnelClient !== undefined) {
      await this.tunnelClient.stop().catch(() => undefined);
      this.tunnelClient = undefined;
    }
    if (this.wsServer !== undefined) {
      for (const client of this.wsServer.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      this.wsServer.close();
      this.wsServer = undefined;
    }
    if (this.httpServer !== undefined) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
  }

  // ── routing ──────────────────────────────────────────────────────

  /** Force the agentId cache to rebuild on next resolution. */
  invalidateCache(): void {
    this.agentIdCache = undefined;
  }

  private parseRoute(rawUrl: string): ParsedRoute {
    const url = new URL(rawUrl, 'http://localhost');
    const path = url.pathname;
    const instanceMatch = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
    if (instanceMatch !== null) {
      return {
        key: { type: 'instance', value: decodeURIComponent(instanceMatch[1]!) },
        localPath: `${instanceMatch[2] ?? '/'}${url.search}`,
      };
    }
    const agentMatch = /^\/a\/([^/]+)(\/.*)?$/.exec(path);
    if (agentMatch !== null) {
      return {
        key: { type: 'agent', value: decodeURIComponent(agentMatch[1]!) },
        localPath: `${agentMatch[2] ?? '/'}${url.search}`,
      };
    }
    // No path prefix — fall back to query params (?instanceId= / ?agentId=).
    const instanceId = url.searchParams.get('instanceId');
    const agentId = url.searchParams.get('agentId');
    if (instanceId !== null && instanceId.length > 0) {
      return { key: { type: 'instance', value: instanceId }, localPath: `${path}${url.search}` };
    }
    if (agentId !== null && agentId.length > 0) {
      return { key: { type: 'agent', value: agentId }, localPath: `${path}${url.search}` };
    }
    return { key: null, localPath: `${path}${url.search}` };
  }

  private rebuildAgentIdCache(cfg: HubConfig): void {
    const cache = new Map<string, string>();
    for (const instance of cfg.instances) {
      const idPath = instancePaths(instance.id).identityPath;
      if (!existsSync(idPath)) continue;
      try {
        const identity = loadOrCreateIdentity({ path: idPath });
        cache.set(identity.agentId, instance.id);
      } catch {
        /* skip unreadable identity */
      }
    }
    this.agentIdCache = cache;
  }

  private agentIdToInstanceId(cfg: HubConfig, agentId: string): string | undefined {
    if (this.agentIdCache === undefined) this.rebuildAgentIdCache(cfg);
    let instanceId = this.agentIdCache!.get(agentId);
    // Cache miss may mean a instance was added/started since last build —
    // rebuild once and retry so newly-registered agents resolve.
    if (instanceId === undefined) {
      this.rebuildAgentIdCache(cfg);
      instanceId = this.agentIdCache!.get(agentId);
    }
    return instanceId;
  }

  private resolveTarget(rawUrl: string): { target: RouteTarget | undefined; localPath: string } {
    const peerTarget = this.resolvePeerTarget(rawUrl);
    if (peerTarget !== undefined) {
      const url = new URL(rawUrl, 'http://localhost');
      return { target: peerTarget, localPath: `${url.pathname}${url.search}` };
    }

    const cfg = this.loadConfig();
    const { key, localPath } = this.parseRoute(rawUrl);

    let instance: InstanceConfig | undefined;
    if (key === null) {
      // Single-instance convenience: if exactly one instance exists, use it.
      instance = cfg.instances.length === 1 ? cfg.instances[0] : undefined;
    } else if (key.type === 'instance') {
      instance = cfg.instances.find((p) => p.id === key.value);
    } else {
      const instanceId = this.agentIdToInstanceId(cfg, key.value);
      instance = instanceId !== undefined ? cfg.instances.find((p) => p.id === instanceId) : undefined;
    }

    if (instance === undefined) {
      return { target: undefined, localPath };
    }
    const host = WILDCARD_HOSTS.has(instance.host) ? '127.0.0.1' : instance.host;
    return { target: { instanceId: instance.id, host, port: instance.port }, localPath };
  }

  /** Route `/peer/ws` to the device-level peer service (separate from ACP agents). */
  private resolvePeerTarget(rawUrl: string): RouteTarget | undefined {
    const url = new URL(rawUrl, 'http://localhost');
    if (!url.pathname.startsWith('/peer')) return undefined;
    const cfg = this.loadConfig();
    const peerPort = cfg.peer?.port ?? DEFAULT_PEER_PORT;
    const peerHost = cfg.peer?.host ?? DEFAULT_PEER_HOST;
    const host = WILDCARD_HOSTS.has(peerHost) ? '127.0.0.1' : peerHost;
    return { instanceId: '__peer__', host, port: peerPort };
  }

  // ── HTTP forwarding ──────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://localhost');

    // Router-local health check (also reachable via the tunnel as /health).
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          role: 'gateway-router',
          tunnel: this.tunnelConfig !== undefined,
          time: new Date().toISOString(),
        }),
      );
      return;
    }

    const { target, localPath } = this.resolveTarget(rawUrl);
    if (target === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No agent matched the routing key.' }));
      return;
    }

    const body = await readBody(req);
    const method = (req.method ?? 'GET').toUpperCase();
    const skip = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (skip.has(k.toLowerCase())) continue;
      fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const localUrl = `http://${target.host}:${target.port}${localPath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const init: RequestInit = { method, headers: fwdHeaders, redirect: 'manual', signal: controller.signal };
      if (method !== 'GET' && method !== 'HEAD' && body.length > 0) init.body = body;
      const resp = await fetch(localUrl, init);
      const respBody = Buffer.from(await resp.arrayBuffer());
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value, k) => {
        if (k.toLowerCase() !== 'transfer-encoding' && k.toLowerCase() !== 'connection') {
          respHeaders[k] = value;
        }
      });
      res.writeHead(resp.status, respHeaders);
      res.end(respBody);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── WebSocket forwarding ─────────────────────────────────────────

  private handleUpgrade(
    wsServer: WebSocketServer,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const { target, localPath } = this.resolveTarget(req.url ?? '/');
    if (target === undefined) {
      this.log(`[Router] ws upgrade rejected — no agent for '${req.url}'`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (clientWs) => {
      this.proxyWs(clientWs, req, target, localPath);
    });
  }

  private proxyWs(clientWs: WebSocket, req: IncomingMessage, target: RouteTarget, localPath: string): void {
    const localUrl = `ws://${target.host}:${target.port}${localPath}`;
    this.log(`[Router] ws '${req.url}' → '${localUrl}' (instance=${target.instanceId})`);

    const skipWs = new Set([
      'host',
      'upgrade',
      'connection',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-extensions',
      'sec-websocket-accept',
    ]);
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (skipWs.has(k.toLowerCase())) continue;
      fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const upstream = new WebSocket(localUrl, { headers: fwdHeaders, handshakeTimeout: 15_000 });
    // Buffer client → upstream frames that arrive before upstream opens.
    const pending: Array<{ data: Buffer; binary: boolean }> = [];
    let upstreamOpen = false;

    const closeBoth = (code?: number, reason?: string) => {
      try {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
      } catch {
        /* ignore */
      }
      try {
        if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
        else upstream.terminate();
      } catch {
        /* ignore */
      }
    };

    upstream.on('open', () => {
      upstreamOpen = true;
      for (const frame of pending.splice(0)) {
        upstream.send(frame.data, { binary: frame.binary });
      }
    });
    upstream.on('message', (data, isBinary) => {
      const buf = toBuffer(data);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(buf, { binary: isBinary });
    });
    upstream.on('close', (code, reason) => closeBoth(sanitizeCode(code), reason?.toString()));
    upstream.on('error', (err) => {
      this.log(`[Router] upstream ws error (instance=${target.instanceId}): ${formatErr(err)}`);
      closeBoth(1011, 'upstream error');
    });

    clientWs.on('message', (data, isBinary) => {
      const buf = toBuffer(data);
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(buf, { binary: isBinary });
      } else {
        pending.push({ data: buf, binary: isBinary });
      }
    });
    clientWs.on('close', (code, reason) => closeBoth(sanitizeCode(code), reason?.toString()));
    clientWs.on('error', (err) => {
      this.log(`[Router] client ws error (instance=${target.instanceId}): ${formatErr(err)}`);
      closeBoth(1011, 'client error');
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** WS close codes must be 1000 or 3000-4999 when sent by an endpoint. */
function sanitizeCode(code: number | undefined): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
