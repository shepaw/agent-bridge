/**
 * ACP Agent Server base class.
 *
 * Wire-compatible with `shepaw_acp_sdk.server.ACPAgentServer`. Subclasses
 * override `onChat()` to implement agent logic. Everything else — WebSocket
 * routing, authentication, heartbeat, task lifecycle, conversation history,
 * hub request tracking — is handled automatically.
 *
 * Minimal example:
 * ```ts
 * class EchoAgent extends ACPAgentServer {
 *   async onChat(ctx: TaskContext, message: string) {
 *     await ctx.sendText(`You said: ${message}`);
 *   }
 * }
 *
 * await new EchoAgent({ name: 'Echo' }).run({ port: 8080 });
 * // Authorize a paired app via the `peers add <pubkey>` CLI subcommand first.
 * ```
 */

import { createServer as createHttpServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import { ConversationManager } from './conversation.js';
import {
  decodeFrame,
  encodeFrame,
  EnvelopeError,
  MAX_FRAME_APP_TO_AGENT,
  MAX_PREHANDSHAKE_BYTES,
  WS_CLOSE,
} from './envelope.js';
import type { AgentIdentity } from './identity.js';
import { loadOrCreateIdentity } from './identity.js';
import { jsonrpcNotification, jsonrpcResponse } from './jsonrpc.js';
import { NoiseHandshakeError, NoiseSession, NoiseTransportError } from './noise.js';
import type { AuthorizedPeer, AuthorizedPeers } from './peers.js';
import {
  addPeer,
  derivedPeerFingerprint,
  isPeerAuthorized,
  loadOrCreatePeers,
  removePeerByFingerprint,
} from './peers.js';
import {
  EnrollmentError,
  consumeEnrollmentToken,
  resolveEnrollmentsPath,
} from './enrollments.js';
import {
  createDeferred,
  Deferred,
  TaskContext,
  wsSend,
} from './task-context.js';
import type { ChannelTunnelConfig } from './tunnel.js';
import { TunnelClient } from './tunnel.js';
import type {
  AgentCard,
  ChatKwargs,
  ConversationMessage,
  JsonRpcErrorObject,
} from './types.js';
import { DEFAULT_CAPABILITIES, DEFAULT_PROTOCOLS } from './types.js';

import type { ShepawWebSocket } from './task-context.js';

// ── v2 handshake constants ─────────────────────────────────────────

/** How long a connected client has to send a valid handshake frame. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Our version of the v2 msg 2 server-side payload. */
const SERVER_VERSION_STRING = 'acp-sdk/2.1';

/** Debounce window for fs.watch-triggered allowlist reloads. */
const PEERS_RELOAD_DEBOUNCE_MS = 100;

/** Thrown internally when a task is cancelled via `agent.cancelTask`. */
export class TaskCancelledError extends Error {
  override readonly name = 'TaskCancelledError';
  constructor() {
    super('Task cancelled');
  }
}

// ── public types ────────────────────────────────────────────────────

export interface ACPAgentServerOptions {
  name?: string;
  /**
   * Path to the agent identity file (X25519 keypair + derived agentId). Defaults to
   * `$SHEPAW_IDENTITY_PATH` / `$XDG_CONFIG_HOME/shepaw-cb-gateway/identity.json` /
   * `~/.config/shepaw-cb-gateway/identity.json`. Auto-created on first run.
   */
  identityPath?: string;
  /**
   * Path to the authorized-peers allowlist (JSON of app public keys). Defaults to
   * `$SHEPAW_PEERS_PATH` / `$XDG_CONFIG_HOME/shepaw-cb-gateway/authorized_peers.json` /
   * `~/.config/shepaw-cb-gateway/authorized_peers.json`. Auto-created as empty on
   * first run. Use the gateway CLI's `peers add <pubkey>` subcommand to authorize
   * paired apps.
   */
  peersPath?: string;
  /**
   * Path to the enrollment-tokens store (short-lived single-use codes that
   * let a new app self-authorize on first connect). Defaults to
   * `$SHEPAW_ENROLLMENTS_PATH` / `$XDG_CONFIG_HOME/shepaw-cb-gateway/enrollments.json` /
   * `~/.config/shepaw-cb-gateway/enrollments.json`. Auto-created as empty on
   * first run. Tokens are minted via the gateway CLI's `enroll` subcommand.
   */
  enrollmentsPath?: string;
  description?: string;
  systemPrompt?: string;
  /** Max conversation turns kept per session. Default 20. */
  maxHistory?: number;
  /**
   * When true, `<<<directive>>>` blocks in saved assistant replies are replaced
   * with human-readable summaries. Default true.
   */
  cleanDirectivesInHistory?: boolean;
  /**
   * Optional Channel Service tunnel. When provided, `run()` additionally
   * establishes a reverse-tunnel to the Channel Service so the agent is
   * reachable from the public internet. Can also be set via `runWithTunnel`.
   */
  tunnelConfig?: ChannelTunnelConfig;
}

export interface RunOptions {
  host?: string;
  port?: number;
}

// ── directive cleanup for history ───────────────────────────────────

const ACP_DIRECTIVE_BLOCK_RE = /<<<directive\s*\n([\s\S]*?)\n>>>/g;

function cleanReplyForHistory(fullReply: string): string {
  return fullReply.replace(ACP_DIRECTIVE_BLOCK_RE, (match, body: string) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(body).trim()) as Record<string, unknown>;
    } catch {
      return match;
    }

    const dtype = typeof payload.type === 'string' ? payload.type : 'unknown';
    const parts: string[] = [];

    for (const key of ['prompt', 'title', 'reason'] as const) {
      const val = payload[key];
      if (typeof val === 'string' && val.length > 0) {
        parts.push(val);
        break;
      }
    }

    for (const key of ['actions', 'options', 'fields'] as const) {
      const items = payload[key];
      if (Array.isArray(items) && items.length > 0) {
        const labels = items
          .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
          .map((i) => (typeof i.label === 'string' ? i.label : '?'));
        if (labels.length > 0) {
          parts.push(labels.join(', '));
        }
        break;
      }
    }

    const filename = payload.filename;
    if (typeof filename === 'string') parts.push(filename);

    const detail = parts.length > 0 ? ': ' + parts.join(' | ') : '';
    return `[Directive ${dtype}${detail}]`;
  });
}

// ── ACPAgentServer ──────────────────────────────────────────────────

export class ACPAgentServer {
  readonly name: string;
  readonly identity: AgentIdentity;
  readonly agentId: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly cleanDirectivesInHistory: boolean;
  readonly convMgr: ConversationManager;

  /**
   * The authorized-peers allowlist snapshot. Updated in place (via `reloadPeers`)
   * whenever the on-disk file changes. Only public keys live here — no private
   * material.
   */
  protected peers: AuthorizedPeers;

  /**
   * Path to the enrollments store. Enrollment tokens are short-lived,
   * single-use codes that let a new app auto-add itself to `peers` on first
   * connection — bypassing the manual `peers add <pubkey>` step. We hold the
   * path (not a snapshot) because tokens are consumed on every handshake that
   * carries one; re-reading the file is cheap and avoids stale-cache issues.
   */
  protected readonly enrollmentsPath: string;

  private httpServer: HttpServer | undefined;
  private wsServer: WebSocketServer | undefined;
  private tunnelConfig: ChannelTunnelConfig | undefined;
  private tunnelClient: TunnelClient | undefined;
  private peersWatcher: FSWatcher | undefined;
  private peersReloadTimer: NodeJS.Timeout | undefined;
  /** shepaw session_id → AbortController for the running task (one per session). */
  protected readonly activeTasks = new Map<string, AbortController>();
  private readonly pendingHubRequests = new Map<string, Deferred<unknown>>();
  private readonly pendingResponses = new Map<string, Deferred<Record<string, unknown>>>();

  constructor(opts: ACPAgentServerOptions = {}) {
    this.name = opts.name ?? 'ACP Agent';
    this.identity = loadOrCreateIdentity({ path: opts.identityPath });
    this.agentId = this.identity.agentId;
    this.peers = loadOrCreatePeers({ path: opts.peersPath });
    this.enrollmentsPath = resolveEnrollmentsPath(opts.enrollmentsPath);
    this.description = opts.description ?? `ACP Agent: ${this.name}`;
    this.systemPrompt = opts.systemPrompt ?? 'You are a helpful AI assistant.';
    this.cleanDirectivesInHistory = opts.cleanDirectivesInHistory ?? true;
    this.convMgr = new ConversationManager({ maxHistory: opts.maxHistory ?? 20 });
    this.tunnelConfig = opts.tunnelConfig;
  }

  // ── override points ────────────────────────────────────────────

  /**
   * Handle an incoming chat message. Override with your agent logic.
   *
   * The lifecycle around `onChat` is:
   *   - `ctx.started()` is sent automatically before the call
   *   - your `onChat` runs
   *   - `ctx.sendTextFinal()` is sent automatically after it returns
   *   - `ctx.completed()` is sent automatically after that
   *
   * If `onChat` throws, `ctx.error(...)` is sent instead of the two trailing events.
   */
  async onChat(ctx: TaskContext, message: string, _kwargs: ChatKwargs): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }

  /** Return the agent card (override to customise). */
  getAgentCard(): AgentCard {
    return {
      agent_id: this.agentId,
      name: this.name,
      description: this.description,
      version: '1.0.0',
      capabilities: [...DEFAULT_CAPABILITIES],
      supported_protocols: [...DEFAULT_PROTOCOLS],
    };
  }

  /**
   * Handle `agent.requestFileData`. Override to implement binary file transfer.
   * Default: respond with method-not-found.
   */
  async onRequestFileData(
    ws: WebSocket,
    msgId: string | number,
    _params: Record<string, unknown>,
  ): Promise<void> {
    await wsSend(
      ws,
      jsonrpcResponse(msgId, {
        error: { code: -32601, message: 'requestFileData not supported by this agent' },
      }),
    );
  }

  // ── saving replies ─────────────────────────────────────────────

  /** Save an assistant reply to conversation history (optionally cleaning directives). */
  saveReplyToHistory(sessionId: string, reply: string): void {
    if (!reply) return;
    const cleaned = this.cleanDirectivesInHistory ? cleanReplyForHistory(reply) : reply;
    this.convMgr.addAssistantMessage(sessionId, cleaned);
  }

  // ── server lifecycle ───────────────────────────────────────────

  async run(opts: RunOptions = {}): Promise<void> {
    const host = opts.host ?? '0.0.0.0';
    const port = opts.port ?? 8080;

    const { httpServer, wsServer } = this.createServer();
    this.httpServer = httpServer;
    this.wsServer = wsServer;

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });

    this.printStartupBanner(host, port);
    // Watcher is started in createServer() so test harnesses that bypass run()
    // still get live revocation semantics.

    if (this.tunnelConfig !== undefined) {
      this.tunnelClient = new TunnelClient({
        config: this.tunnelConfig,
        localHost: host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host,
        localPort: port,
      });
      await this.tunnelClient.start();
      const publicUrl = this.tunnelConfig.getPublicEndpoint({
        agentId: this.agentId,
        fingerprint: this.identity.fingerprint,
      });
      // eslint-disable-next-line no-console
      console.log(`  Public WS: ${publicUrl}`);
      // eslint-disable-next-line no-console
      console.log('='.repeat(60));
    }
  }

  /**
   * Start the agent and open a reverse tunnel to the Shepaw Channel Service
   * so the agent is reachable from the public internet.
   */
  async runWithTunnel(tunnelConfig: ChannelTunnelConfig, opts: RunOptions = {}): Promise<void> {
    this.tunnelConfig = tunnelConfig;
    await this.run(opts);
  }

  /** Stop the server. Closes all WS connections and the underlying HTTP server. */
  async close(): Promise<void> {
    // Cancel all running tasks.
    for (const ctrl of this.activeTasks.values()) ctrl.abort();
    this.activeTasks.clear();

    this.stopPeersWatcher();

    if (this.tunnelClient !== undefined) {
      await this.tunnelClient.stop().catch(() => undefined);
      this.tunnelClient = undefined;
    }

    if (this.wsServer) {
      await new Promise<void>((resolve) => {
        this.wsServer!.close(() => resolve());
      });
      this.wsServer = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }
  }

  /**
   * Build the HTTP+WebSocket server without starting it. Useful for tests
   * that want to listen on an ephemeral port.
   */
  createServer(): { httpServer: HttpServer; wsServer: WebSocketServer } {
    const httpServer = createHttpServer(this.handleHttpRequest.bind(this));
    const wsServer = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/acp/ws') {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          this.handleWebSocket(ws, req).catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[ACP] WebSocket handler error:', err);
          });
        });
      } else {
        socket.destroy();
      }
    });

    // Stash the server so live revocation can iterate clients, and start the
    // allowlist watcher. Doing this in createServer (not just run) means
    // test harnesses that call `createServer + httpServer.listen` directly
    // also get live revocation — otherwise the watcher never starts.
    this.wsServer = wsServer;
    this.startPeersWatcher();

    return { httpServer, wsServer };
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  // ── peers allowlist ────────────────────────────────────────────

  private startPeersWatcher(): void {
    // Watch the PARENT directory, not the file itself: our own writes use
    // atomic rename (tmp + rename), which on macOS replaces the inode and
    // orphans a file-level fs.watch. A directory-level watch keeps firing
    // because the dirent that changes is still inside the watched dir.
    const watchDir = dirname(this.peers.path);
    const watchName = basename(this.peers.path);
    try {
      this.peersWatcher = watch(watchDir, { persistent: false });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[ACP] Could not watch ${watchDir}:`, err);
      return;
    }
    this.peersWatcher.on('change', (_eventType, filename) => {
      // Node passes `filename` as Buffer | string | null depending on platform.
      // Filter so edits to unrelated files in the same dir are ignored.
      const name = typeof filename === 'string' ? filename : filename?.toString('utf-8');
      if (name !== watchName && name !== `${watchName}.tmp`) return;
      if (name === `${watchName}.tmp`) {
        // Still mid-write — rename event will follow shortly, so let that fire.
        return;
      }
      // Editors (vi, some atomic-write tools) emit multiple events per save.
      // Debounce so we reload once per "human edit".
      if (this.peersReloadTimer !== undefined) clearTimeout(this.peersReloadTimer);
      this.peersReloadTimer = setTimeout(() => {
        this.peersReloadTimer = undefined;
        this.reloadPeers();
      }, PEERS_RELOAD_DEBOUNCE_MS);
    });
    this.peersWatcher.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[ACP] peers watcher error:', err);
    });
  }

  private stopPeersWatcher(): void {
    if (this.peersReloadTimer !== undefined) {
      clearTimeout(this.peersReloadTimer);
      this.peersReloadTimer = undefined;
    }
    if (this.peersWatcher !== undefined) {
      try {
        this.peersWatcher.close();
      } catch {
        /* ignore */
      }
      this.peersWatcher = undefined;
    }
  }

  /**
   * Reload the authorized-peers allowlist from disk and boot any live WS
   * sessions whose peer has been revoked. Called internally by:
   *   - fs.watch when `authorized_peers.json` changes (debounced 100 ms)
   *   - `peer.unregister` handler (immediately, so the caller disconnects)
   *   - test harnesses for deterministic revocation
   */
  protected reloadPeers(): void {
    try {
      this.peers = loadOrCreatePeers({ path: this.peers.path });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ACP] peers reload failed (keeping previous list):', err);
      return;
    }
    if (this.wsServer === undefined) return;
    for (const client of this.wsServer.clients) {
      const sws = client as ShepawWebSocket;
      if (sws.authorizedPeer === undefined) continue;
      const stillThere = isPeerAuthorized(this.peers, sws.authorizedPeer.publicKey);
      if (stillThere === undefined) {
        // eslint-disable-next-line no-console
        console.log(
          `[ACP] Booting revoked peer: ${sws.authorizedPeer.fingerprint} (${sws.authorizedPeer.label || 'unlabeled'})`,
        );
        sws.v2Closing = true;
        try {
          client.close(WS_CLOSE.UNREGISTERED, 'unregistered');
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Try to consume an enrollment token carried in the Noise msg1 payload and,
   * on success, promote the peer into the authorized list.
   *
   * Returns the newly-authorized entry on success, or `undefined` on any
   * failure (invalid format, expired, already consumed, etc.). All failure
   * reasons are logged but collapse to "peer not authorized" on the wire —
   * we don't want to give a scanner hints about whether it tripped the
   * rate-limit check vs. the expiry check.
   *
   * Token lookup is single-use: a successful consume removes the token from
   * the enrollments store BEFORE this method returns the new peer. A race
   * between two peers presenting the same code resolves to one winner and
   * one 4405.
   *
   * After addPeer succeeds, we also invoke `reloadPeers()` so the hot
   * in-memory `this.peers` snapshot reflects the new entry immediately
   * (the fs.watch reload would fire shortly anyway, but we can't rely on
   * it for the current handshake).
   */
  protected tryEnrollViaToken(
    code: string,
    peerStaticPublicKey: Uint8Array,
    remote: string,
  ): AuthorizedPeer | undefined {
    let consumed;
    try {
      consumed = consumeEnrollmentToken(this.enrollmentsPath, code);
    } catch (err) {
      if (err instanceof EnrollmentError) {
        // eslint-disable-next-line no-console
        console.log(
          `[ACP] ${remote}: enrollment token rejected (${err.reason}): ${err.message}`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.error(`[ACP] ${remote}: enrollment consume failed:`, err);
      }
      return undefined;
    }

    // Token consumed — promote the peer. addPeer is idempotent, so the
    // theoretical case where two handshakes share the same pubkey but
    // different codes collapses to a single allowlist entry.
    const pubB64 = Buffer.from(peerStaticPublicKey).toString('base64');
    const label = consumed.token.label || `enrolled ${consumed.token.code}`;
    try {
      addPeer(this.peers.path, pubB64, label);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[ACP] ${remote}: enrollment token consumed but peer write failed:`,
        err,
      );
      return undefined;
    }

    // Refresh the hot snapshot so the caller can proceed on this same
    // handshake. fs.watch will also fire, but we can't wait for it.
    this.reloadPeers();
    const entry = isPeerAuthorized(this.peers, peerStaticPublicKey);
    // eslint-disable-next-line no-console
    console.log(
      `[ACP] ${remote}: enrolled via token ${consumed.token.code} → fingerprint ${entry?.fingerprint ?? '(unknown)'} (${label})`,
    );
    return entry;
  }

  // ── WebSocket handler ──────────────────────────────────────────

  private async handleWebSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const sws = ws as ShepawWebSocket;
    // eslint-disable-next-line no-console
    console.log(`[ACP] New WebSocket connection from ${remote}`);

    // v2.1: no token pre-filter. Authorization is by public-key allowlist
    // and happens after the Noise handshake completes (so we learn the peer's
    // static public key first). The handshake itself is cheap enough that
    // unauthorized peers just get an extra few hundred microseconds of X25519
    // work before being kicked; replacing that with a pre-filter would be a
    // regression to v2's less-expressive auth model.

    // ── Start the Noise responder handshake ─────────────────────
    const noise = NoiseSession.responder(this.identity);
    let prehandshakeBytes = 0;

    // Handshake deadline.
    const handshakeTimer = setTimeout(() => {
      if (noise.ready) return;
      // eslint-disable-next-line no-console
      console.log(`[ACP] ${remote}: handshake timeout`);
      sws.v2Closing = true;
      try {
        ws.close(WS_CLOSE.HANDSHAKE_TIMEOUT, 'handshake timeout');
      } catch {
        /* ignore */
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const closeWith = (code: number, reason: string): void => {
      // eslint-disable-next-line no-console
      console.log(`[ACP] ${remote}: closing ${code} ${reason}`);
      sws.v2Closing = true;
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    ws.on('message', (rawData) => {
      void (async () => {
        try {
          // Size cap on pre-handshake traffic.
          const size = (rawData as Buffer).byteLength;
          if (!noise.ready) {
            prehandshakeBytes += size;
            if (prehandshakeBytes > MAX_PREHANDSHAKE_BYTES) {
              closeWith(WS_CLOSE.FRAME_TOO_LARGE, 'pre-handshake size exceeded');
              return;
            }
          }

          const text = rawData.toString('utf-8');
          let frame;
          try {
            frame = decodeFrame(text, MAX_FRAME_APP_TO_AGENT);
          } catch (err) {
            if (err instanceof EnvelopeError) {
              closeWith(err.closeCode, err.code);
            } else {
              closeWith(WS_CLOSE.MALFORMED_FRAME, 'decode error');
            }
            return;
          }

          if (!noise.ready) {
            // Expecting a handshake frame.
            if (frame.t !== 'hs') {
              closeWith(WS_CLOSE.UNEXPECTED_DATA_BEFORE_READY, 'expected hs frame first');
              return;
            }
            await this.handleHandshake1(noise, frame.payload, sws, closeWith, handshakeTimer, remote);
            return;
          }

          // Post-handshake: only data frames allowed.
          if (frame.t === 'hs') {
            closeWith(WS_CLOSE.UNEXPECTED_HS_AFTER_READY, 'hs after ready');
            return;
          }
          if (frame.t === 'err') {
            // Peer told us they're aborting. Log and let the close handler
            // clean up — no reply.
            // eslint-disable-next-line no-console
            console.log(`[ACP] ${remote}: peer sent err frame`);
            return;
          }

          // Decrypt.
          let plaintext: Uint8Array;
          try {
            plaintext = noise.decrypt(frame.payload);
          } catch (err) {
            // Never echo the decrypt error back — oracle risk.
            if (err instanceof NoiseTransportError) {
              closeWith(WS_CLOSE.HANDSHAKE_FAILED, 'decrypt failed');
            } else {
              closeWith(WS_CLOSE.HANDSHAKE_FAILED, 'decrypt failed');
            }
            return;
          }

          const utf8 = Buffer.from(plaintext).toString('utf-8');
          await this.onWsMessage(sws, utf8);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[ACP] Message handler error:', err);
        }
      })();
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      try {
        noise.close();
      } catch {
        /* ignore */
      }
      for (const ctrl of this.activeTasks.values()) ctrl.abort();
      this.activeTasks.clear();
      for (const d of this.pendingHubRequests.values()) d.reject(new Error('Connection closed'));
      this.pendingHubRequests.clear();
      for (const d of this.pendingResponses.values()) d.reject(new Error('Connection closed'));
      this.pendingResponses.clear();
      // eslint-disable-next-line no-console
      console.log('[ACP] WebSocket connection closed');
    });
  }

  /**
   * Process handshake message 1 from the app, check the app's static public key
   * against the authorized-peers allowlist, produce msg 2, attach the session to
   * the ws so subsequent `wsSend` calls auto-encrypt.
   */
  private async handleHandshake1(
    noise: NoiseSession,
    msg1Bytes: Uint8Array,
    sws: ShepawWebSocket,
    closeWith: (code: number, reason: string) => void,
    handshakeTimer: NodeJS.Timeout,
    remote: string,
  ): Promise<void> {
    let hs1;
    try {
      hs1 = noise.readHandshake1(msg1Bytes);
    } catch (err) {
      if (err instanceof NoiseHandshakeError) {
        // Don't leak the reason.
        closeWith(WS_CLOSE.HANDSHAKE_FAILED, 'hs1 decrypt failed');
      } else {
        closeWith(WS_CLOSE.HANDSHAKE_FAILED, 'hs1 error');
      }
      return;
    }

    // Inspect msg1 payload — it should be {agentId, clientVersion}. We
    // optionally validate agentId here (belt-and-suspenders: the peer pubkey
    // allowlist check below is the authoritative gate).
    let msg1Payload: Record<string, unknown> = {};
    try {
      msg1Payload = JSON.parse(Buffer.from(hs1.msg1Payload).toString('utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      // Empty or non-JSON payload — accept but warn. Older clients may
      // not send anything here; we don't require it.
      // eslint-disable-next-line no-console
      console.log('[ACP] Handshake msg1 payload is not valid JSON; proceeding');
    }

    const claimedAgentId = typeof msg1Payload.agentId === 'string' ? msg1Payload.agentId : '';
    if (claimedAgentId && claimedAgentId !== this.agentId) {
      // eslint-disable-next-line no-console
      console.log(
        `[ACP] Handshake rejected: client claimed agentId='${claimedAgentId}', we are '${this.agentId}'`,
      );
      closeWith(WS_CLOSE.AGENTID_MISMATCH, 'agentId mismatch');
      return;
    }

    // v2.1 authorization: the peer's static public key must be on the allowlist,
    // OR the peer must present a valid single-use enrollment token that was
    // minted via `<gateway> enroll`. Enrollment promotes the peer into the
    // allowlist as a side effect of the handshake; subsequent connections use
    // the standard pubkey path.
    let authorized = isPeerAuthorized(this.peers, hs1.peerStaticPublicKey);
    if (authorized === undefined) {
      const enrollCode = typeof msg1Payload.enroll === 'string' ? msg1Payload.enroll : '';
      if (enrollCode.length > 0) {
        const enrolled = this.tryEnrollViaToken(
          enrollCode,
          hs1.peerStaticPublicKey,
          remote,
        );
        if (enrolled !== undefined) {
          authorized = enrolled;
        }
      }
    }
    if (authorized === undefined) {
      const fp = derivedPeerFingerprint(hs1.peerStaticPublicKey);
      const pubB64 = Buffer.from(hs1.peerStaticPublicKey).toString('base64');
      // eslint-disable-next-line no-console
      console.log(
        `[ACP] ${remote}: unauthorized peer rejected\n` +
          `       fingerprint: ${fp}\n` +
          `       publicKey:   ${pubB64}\n` +
          `       To authorize: shepaw-* peers add ${pubB64} --label "<device name>"\n` +
          `       Or issue an enrollment code: shepaw-* enroll --label "<device name>"`,
      );
      closeWith(WS_CLOSE.PEER_NOT_AUTHORIZED, 'peer not authorized');
      return;
    }
    sws.authorizedPeer = authorized;

    // Build msg2 payload with our authoritative agent identity.
    const msg2PayloadObj = {
      agentId: this.agentId,
      serverVersion: SERVER_VERSION_STRING,
    };
    const msg2Payload = Buffer.from(JSON.stringify(msg2PayloadObj), 'utf-8');

    let msg2Bytes: Uint8Array;
    try {
      msg2Bytes = noise.writeHandshake2(msg2Payload);
    } catch (err) {
      if (err instanceof NoiseHandshakeError) {
        closeWith(WS_CLOSE.HANDSHAKE_FAILED, 'hs2 write failed');
      } else {
        closeWith(WS_CLOSE.HANDSHAKE_FAILED, 'hs2 error');
      }
      return;
    }

    // Send msg2 as a plaintext handshake frame (noiseSession NOT yet attached
    // to ws, so wsSend would try to encrypt — we send directly here).
    const framed = encodeFrame({ t: 'hs', payload: msg2Bytes });
    await new Promise<void>((resolve, reject) => {
      sws.send(framed, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Activate the session — future wsSend calls will encrypt.
    sws.noiseSession = noise;
    clearTimeout(handshakeTimer);

    // eslint-disable-next-line no-console
    console.log(
      `[ACP] Noise handshake completed; authorized peer: ${authorized.fingerprint} (${authorized.label || 'unlabeled'})`,
    );
  }

  private async onWsMessage(
    ws: WebSocket,
    raw: string,
  ): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await wsSend(
        ws,
        jsonrpcResponse(null, { error: { code: -32700, message: 'Parse error' } }),
      );
      return;
    }

    const method = typeof data.method === 'string' ? data.method : undefined;
    const msgId = data.id as string | number | undefined;
    const params = (data.params as Record<string, unknown> | undefined) ?? {};

    // v2.1: `peer.unregister` is a notification (no id) sent by the app when
    // it deletes the agent record locally. The peer identity comes from the
    // session's authorizedPeer (unforgeable), not from params.
    if (method === 'peer.unregister' && msgId === undefined) {
      await this.handlePeerUnregister(ws);
      return;
    }

    // Request from app: has both id and method.
    if (msgId !== undefined && method !== undefined) {
      // v2.1: authorization was decided at the handshake. There is no
      // `auth.authenticate` fallback — token-based auth is gone entirely.

      if (method === 'ping') {
        await wsSend(ws, jsonrpcResponse(msgId, { result: { pong: true } }));
        return;
      }

      switch (method) {
        case 'agent.chat':
          await this.handleChatDispatch(ws, msgId, params);
          return;
        case 'agent.cancelTask':
          await this.handleCancelTask(ws, msgId, params);
          return;
        case 'agent.submitResponse':
          await this.handleSubmitResponse(ws, msgId, params);
          return;
        case 'agent.rollback':
          await this.handleRollback(ws, msgId, params);
          return;
        case 'agent.getCard':
          await this.handleGetCard(ws, msgId);
          return;
        case 'agent.requestFileData':
          await this.onRequestFileData(ws, msgId, params);
          return;
        default:
          await wsSend(
            ws,
            jsonrpcResponse(msgId, {
              error: { code: -32601, message: `Method not found: ${method}` },
            }),
          );
          return;
      }
    }

    // Response to one of our hub.* requests: has id but no method.
    if (msgId !== undefined && method === undefined) {
      const deferred = this.pendingHubRequests.get(String(msgId));
      if (deferred !== undefined && !deferred.settled) {
        const error = data.error as JsonRpcErrorObject | undefined;
        if (error !== undefined) {
          deferred.reject(new Error(`Hub request failed: ${error.message ?? JSON.stringify(error)}`));
        } else {
          deferred.resolve(data.result);
        }
      }
    }
  }

  // ── peer self-unregister ───────────────────────────────────────

  /**
   * Handle `peer.unregister`: the app is requesting its own revocation, e.g.
   * because the user deleted the agent record on the phone. Remove the
   * authorized-peer entry matching this session's static public key, reload
   * the allowlist (which also updates any other sessions the peer might have
   * open), then close this session.
   *
   * Security: the peer identity is the one we pinned at handshake time
   * (`sws.authorizedPeer`), never something the RPC caller can fake. We
   * refuse if the session didn't make it through the authorization gate
   * — that should be impossible since the handshake closes 4405 otherwise,
   * but we defend in depth.
   */
  private async handlePeerUnregister(ws: WebSocket): Promise<void> {
    const sws = ws as ShepawWebSocket;
    const peer = sws.authorizedPeer;
    if (peer === undefined) {
      sws.v2Closing = true;
      try {
        ws.close(WS_CLOSE.PEER_NOT_AUTHORIZED, 'peer not authorized');
      } catch {
        /* ignore */
      }
      return;
    }
    const removed = removePeerByFingerprint(this.peers.path, peer.fingerprint);
    // eslint-disable-next-line no-console
    console.log(
      `[ACP] peer.unregister: ${peer.fingerprint} (${peer.label || 'unlabeled'}) removed=${removed}`,
    );
    // Reload immediately rather than waiting for fs.watch, so the close we're
    // about to send is the last thing this session does.
    this.reloadPeers();
    sws.v2Closing = true;
    try {
      ws.close(WS_CLOSE.UNREGISTERED, 'unregistered');
    } catch {
      /* ignore */
    }
  }

  // ── chat ───────────────────────────────────────────────────────

  private async handleChatDispatch(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : randomUUID();
    const sessionId = typeof params.session_id === 'string' ? params.session_id : taskId;
    const message = typeof params.message === 'string' ? params.message : '';
    const isHistorySupplement = params.history_supplement === true;

    if (!message && !isHistorySupplement) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32602, message: "Missing 'message' parameter" },
        }),
      );
      return;
    }

    // Acknowledge.
    await wsSend(ws, jsonrpcResponse(msgId, { result: { task_id: taskId, status: 'accepted' } }));

    // Restore session history from the app, if provided.
    const appHistory: ConversationMessage[] | undefined = Array.isArray(params.history)
      ? params.history
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              (m.content as string).length > 0,
          )
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
      : undefined;
    if (!this.convMgr.hasSession(sessionId) && appHistory !== undefined && appHistory.length > 0) {
      this.convMgr.initializeSession(sessionId, appHistory);
    }

    // Handle history supplement.
    if (isHistorySupplement) {
      const add: ConversationMessage[] = Array.isArray(params.additional_history)
        ? params.additional_history
            .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
            .filter(
              (m) =>
                (m.role === 'user' || m.role === 'assistant') &&
                typeof m.content === 'string' &&
                (m.content as string).length > 0,
            )
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
        : [];
      if (add.length > 0) this.convMgr.prependHistory(sessionId, add);
      const msgs = this.convMgr.getMessages(sessionId);
      if (msgs.length > 0 && msgs.at(-1)?.role === 'assistant') msgs.pop();
    } else if (message) {
      this.convMgr.addUserMessage(sessionId, message);
    }

    const abortController = new AbortController();
    this.activeTasks.set(taskId, abortController);

    const ctx = new TaskContext({
      ws,
      taskId,
      sessionId,
      pendingHubRequests: this.pendingHubRequests,
      pendingResponses: this.pendingResponses,
    });

    // Run lifecycle in a detached task so the WS reader keeps flowing.
    void this.runChatTask(ctx, message, params, appHistory, abortController.signal);
  }

  private async runChatTask(
    ctx: TaskContext,
    message: string,
    params: Record<string, unknown>,
    appHistory: ConversationMessage[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const { taskId, sessionId } = ctx;
    const kwargs: ChatKwargs = {
      session_id: sessionId,
      history: appHistory,
      messages: this.convMgr.getMessages(sessionId),
      attachments: params.attachments,
      system_prompt: typeof params.system_prompt === 'string' ? params.system_prompt : this.systemPrompt,
      group_context: params.group_context,
      ui_component_version:
        typeof params.ui_component_version === 'string' ? params.ui_component_version : undefined,
      user_id: typeof params.user_id === 'string' ? params.user_id : '',
      message_id: typeof params.message_id === 'string' ? params.message_id : '',
      is_history_supplement: params.history_supplement === true,
      params,
    };

    try {
      await ctx.started();

      await this.onChat(ctx, message, kwargs);

      await ctx.sendTextFinal();
      await ctx.completed();
    } catch (err) {
      if (signal.aborted || err instanceof TaskCancelledError) {
        await ctx.error('Task cancelled', -32008);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.error(msg, -32603);
      }
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  // ── cancel ─────────────────────────────────────────────────────

  private async handleCancelTask(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : '';
    const ctrl = this.activeTasks.get(taskId);
    if (ctrl !== undefined) {
      ctrl.abort();
      // Abort any pending waitForResponse / hubRequest so the task exits quickly.
      for (const d of this.pendingResponses.values()) {
        if (!d.settled) d.reject(new TaskCancelledError());
      }
      for (const d of this.pendingHubRequests.values()) {
        if (!d.settled) d.reject(new TaskCancelledError());
      }
      await wsSend(
        ws,
        jsonrpcResponse(msgId, { result: { task_id: taskId, status: 'cancelled' } }),
      );
    } else {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32003, message: `Task not found: ${taskId}` },
        }),
      );
    }
  }

  // ── submitResponse (UI component reply from the app) ───────────

  private async handleSubmitResponse(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : '';
    const responseData = (params.response_data as Record<string, unknown> | undefined) ?? {};

    await wsSend(
      ws,
      jsonrpcResponse(msgId, { result: { task_id: taskId, status: 'received' } }),
    );

    for (const idKey of ['confirmation_id', 'select_id', 'upload_id', 'form_id'] as const) {
      const componentId = responseData[idKey];
      if (typeof componentId === 'string' && componentId.length > 0) {
        const deferred = this.pendingResponses.get(componentId);
        if (deferred !== undefined && !deferred.settled) {
          deferred.resolve(responseData);
        }
        break;
      }
    }
  }

  // ── rollback ───────────────────────────────────────────────────

  private async handleRollback(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof params.session_id === 'string' ? params.session_id : '';
    const messageId = typeof params.message_id === 'string' ? params.message_id : '';
    this.convMgr.rollback(sessionId);
    await wsSend(
      ws,
      jsonrpcResponse(msgId, { result: { status: 'ok', message_id: messageId } }),
    );
  }

  // ── getCard ────────────────────────────────────────────────────

  private async handleGetCard(ws: WebSocket, msgId: string | number): Promise<void> {
    const card = this.getAgentCard();
    await wsSend(ws, jsonrpcResponse(msgId, { result: card }));
  }

  // ── banner ─────────────────────────────────────────────────────

  protected printStartupBanner(host: string, port: number): void {
    const displayHost = host === '0.0.0.0' || host === '::' || host === '' ? 'localhost' : host;
    const fp = this.identity.fingerprint;
    const peerCount = this.peers.peers.length;
    // Shepaw requires #fp=<fingerprint>&pk=<base64pubkey> on every pairing URL
    // — LAN included — because the client-side Noise IK handshake needs the
    // responder's full static public key upfront. The fingerprint is a
    // commitment (first 8 bytes of sha256(pubkey)); the full key is needed so
    // the IK initiator can encrypt its first message to the responder.
    // v2.1 drops the token query param: authentication is now per-peer
    // public-key allowlist (see authorized_peers.json).
    //
    // IMPORTANT: base64 contains `+`, `/`, `=` which are NOT safe in URL
    // fragments parsed as application/x-www-form-urlencoded (`+` becomes a
    // space). We percent-encode those three chars so clients that split the
    // fragment with standard URI helpers (Dart `Uri.splitQueryString`,
    // JS `URLSearchParams`) round-trip cleanly back to the original base64.
    const pkB64 = Buffer.from(this.identity.staticPublicKey).toString('base64');
    const pkEncoded = encodeURIComponent(pkB64);
    const banner = [
      '='.repeat(60),
      `  ${this.name} (ACP Agent Server)`,
      '='.repeat(60),
      `  Agent ID:         ${this.agentId}`,
      `  Fingerprint:      ${fp}`,
      `  Identity:         ${this.identity.path}`,
      `  Authorized peers: ${peerCount}`,
      `  Peers file:       ${this.peers.path}`,
      `  History:          ${this.convMgr.maxHistory} turns per session`,
      '-'.repeat(60),
      `  ACP WS:           ws://${displayHost}:${port}/acp/ws?agentId=${this.agentId}#fp=${fp}&pk=${pkEncoded}`,
      `  Health:           http://${displayHost}:${port}/health`,
      '='.repeat(60),
    ];
    if (peerCount === 0) {
      banner.push(
        '  ⚠ No peers authorized. Run `<gateway> peers add <pubkey>` to accept connections.',
        '     Get the pubkey from your Shepaw app\'s "Add remote agent" screen.',
        '='.repeat(60),
      );
    }
    // eslint-disable-next-line no-console
    console.log(banner.join('\n'));
  }

  // silence unused-import lint warning when we don't actually emit these
  protected _unused(): void {
    void jsonrpcNotification;
    void createDeferred;
  }
}
