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
import { hostname } from 'node:os';
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
import { MailboxClient, createMailboxStreamSink } from './mailbox.js';
import type { ChannelMailboxConfig } from './mailbox.js';
import { GrantSyncClient } from './grant-sync.js';
import { NoiseHandshakeError, NoiseSession, NoiseTransportError } from './noise.js';
import type { AuthorizedPeer, AuthorizedPeers } from './peers.js';
import { openJson, sealJson } from './sealbox.js';
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
  AgentRuntimeStatus,
  ChatKwargs,
  CommandsChangedParams,
  CommandsListParams,
  CommandsListResult,
  ConversationMessage,
  JsonRpcErrorObject,
  ModelsListParams,
  ModelsListResult,
  ModelsSetCurrentParams,
  ModelsSetCurrentResult,
  ModesListParams,
  ModesListResult,
  ModesSetCurrentParams,
  ModesSetCurrentResult,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionsListParams,
  SessionsListResult,
  SlashCommandInfo,
  ChatToolDef,
  GroupChatContext,
  GroupChatMember,
  ResumePromptSetParams,
  ResumeRebuildParams,
  ResumeSummarySetParams,
} from './types.js';
import { DEFAULT_CAPABILITIES, DEFAULT_PROTOCOLS, deriveBusyLevel } from './types.js';
import type { SlashProviders } from './slash/types.js';
import { SlashCommandRegistry } from './slash/registry.js';

import type { ShepawWebSocket } from './task-context.js';

// ── v2 handshake constants ─────────────────────────────────────────

/** How long a connected client has to send a valid handshake frame. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Our version of the v2 msg 2 server-side payload. */
const SERVER_VERSION_STRING = 'acp-sdk/2.1';

/**
 * Validate raw `agent.chat` params.tools into an opaque tool-def array.
 * Non-array / non-object entries are dropped; absent → undefined.
 */
function normalizeTools(raw: unknown): ChatToolDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChatToolDef[] = [];
  for (const item of raw) {
    if (typeof item === 'object' && item !== null) {
      out.push(item as ChatToolDef);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate the raw `agent.chat` group_context into a typed
 * [GroupChatContext]. Non-object / missing group_id → undefined (DM turn).
 */
function normalizeGroupContext(raw: unknown): GroupChatContext | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const gc = raw as Record<string, unknown>;
  const groupId = typeof gc.group_id === 'string' ? gc.group_id : undefined;
  if (!groupId || groupId.length === 0) return undefined;
  return {
    group_id: groupId,
    group_name:
      typeof gc.group_name === 'string' ? gc.group_name : undefined,
    group_description:
      typeof gc.group_description === 'string'
        ? gc.group_description
        : undefined,
    member_count: typeof gc.member_count === 'number' ? gc.member_count : undefined,
    members: Array.isArray(gc.members)
      ? (gc.members as GroupChatMember[])
      : undefined,
    is_first_message: gc.is_first_message === true ? true : undefined,
    message_version:
      typeof gc.message_version === 'string' ? gc.message_version : undefined,
    orchestration_tools: gc.orchestration_tools,
    workspace_uri:
      typeof gc.workspace_uri === 'string' ? gc.workspace_uri : undefined,
  };
}

/** Debounce window for fs.watch-triggered allowlist reloads. */
const PEERS_RELOAD_DEBOUNCE_MS = 100;

/** Thrown internally when a task is cancelled via `agent.cancelTask`. */
export class TaskCancelledError extends Error {
  override readonly name = 'TaskCancelledError';
  constructor() {
    super('Task cancelled');
  }
}

/**
 * Replay state for one chat task — survives the client connection that
 * started it. This is what makes `agent.taskResume` possible: the accumulated
 * text stream (UTF-16 code units, byte-aligned with what the client received),
 * the last metadata frame, outstanding tool-call confirmations, and the
 * terminal result are all buffered here while the live `route` comes and goes.
 */
interface TaskReplayEntry {
  readonly sessionId: string;
  /** Concatenated non-final `ui.textContent` contents — the resume delta source. */
  accumulated: string;
  /** Last `ui.messageMetadata` params (client splitter/diversion state). */
  lastMetadata?: Record<string, unknown>;
  status: 'streaming' | 'done' | 'error';
  /** `task.completed` / `task.error` params for terminal replay. */
  terminalParams?: Record<string, unknown>;
  terminalAt?: number;
  /**
   * Outstanding `ui.actionConfirmation`s by confirmation_id. `delivered`
   * tracks whether a live route acked the push — on rebind only UNDELIVERED
   * cards are re-emitted, so a client that already showed the card never
   * gets a duplicate.
   */
  readonly pendingConfirmations: Map<string, { params: Record<string, unknown>; delivered: boolean }>;
  /** Live push route; undefined while detached (client away). */
  route?: ShepawWebSocket;
  /** Last tap time — zombie sweep base. */
  updatedAt: number;
  /** Set when accumulated hit the cap — resume answers 'lost' (gap = corrupt). */
  overflowed: boolean;
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
  /** Agent's self-description / resume. Defaults to `description`. */
  bio?: string;
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
  /**
   * Channel mailbox / grant-sync credentials without owning a reverse tunnel.
   * Hub device-level tunnels use this so each instance can drain inbox while
   * the gateway router holds the single device tunnel.
   */
  mailboxConfig?: ChannelMailboxConfig;
  /**
   * Called after a peer is promoted into the allowlist via enrollment.
   * Hub uses this to fan-out the device to every managed agent.
   */
  onPeerEnrolled?: (event: PeerEnrolledEvent) => void;
  /**
   * Max concurrent chat tasks across all sessions. Default 5.
   * When at capacity, `agent.chat` returns `{status:'busy'}` and the caller
   * should leave a sealed message in the channel mailbox.
   * Set to 0 to disable the gate (unlimited, legacy behaviour).
   */
  maxConcurrency?: number;
}

/** Fired when an enrollment token is consumed and the peer is authorized. */
export interface PeerEnrolledEvent {
  readonly publicKeyB64: string;
  readonly label: string;
  readonly code: string;
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
  readonly bio: string;
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
  /**
   * Live WS connections. Informational only — a connection dropping no longer
   * tears down tasks or waiters; their per-task replay entries detach and the
   * work keeps running until a client re-attaches via `agent.taskResume`.
   */
  private openConnections = 0;
  /** Set when the HTTP server starts listening — used for uptime in /status. */
  private startedAtMs = 0;
  private tunnelConfig: ChannelTunnelConfig | undefined;
  private mailboxConfig: ChannelMailboxConfig | undefined;
  private tunnelClient: TunnelClient | undefined;
  private mailboxClient: MailboxClient | undefined;
  private mailboxTimer: NodeJS.Timeout | undefined;
  private mailboxBusy = false;
  /** message_id values already processed (skip duplicate mail_waiting). */
  private readonly processedMailIds = new Set<string>();
  /** message_id values currently running (dedup concurrent wake + poller). */
  private readonly inFlightMailIds = new Set<string>();
  /** mail_waiting hints arrived while a drain was already in flight. */
  private readonly pendingMailHints = new Set<string>();
  private grantSync: GrantSyncClient | undefined;
  private grantTimer: NodeJS.Timeout | undefined;
  private readonly maxConcurrency: number;
  private peersWatcher: FSWatcher | undefined;
  private peersReloadTimer: NodeJS.Timeout | undefined;
  private readonly onPeerEnrolledHook: ((event: PeerEnrolledEvent) => void) | undefined;
  /** shepaw session_id → AbortController for the running task (one per session). */
  protected readonly activeTasks = new Map<string, AbortController>();
  private readonly pendingHubRequests = new Map<string, Deferred<unknown>>();
  private readonly pendingResponses = new Map<string, Deferred<Record<string, unknown>>>();
  /**
   * submitResponse that arrived before waitForResponse registered the waiter
   * (peer loopback race), or for a component whose waiter was already torn
   * down. Retained per task — not dropped after 2s — so a verdict that races
   * ahead of, or outlives, its waiter is still consumable by a later
   * `waitForResponse` for the same component id. Entries carry the task they
   * belong to (so a reused id across tasks can't cross-contaminate) and are
   * discarded when the owning task finishes.
   */
  private readonly earlyResponses = new Map<string, { taskId: string; data: Record<string, unknown> }>();
  /**
   * Per-session FIFO queue tail. Each `handleChatDispatch` call chains onto
   * the previous promise for the same sessionId so that concurrent `agent.chat`
   * calls (e.g. multiple simultaneous "Allow All Similar" taps) are serialized
   * and never race against the underlying SDK session lock.
   */
  private readonly chatQueues = new Map<string, Promise<void>>();

  /**
   * Per-task replay buffer — the disconnect-resume backbone. Every chat task
   * gets an entry; outbound events are tapped into it (accumulated text, last
   * metadata, outstanding confirmations, terminal result) and the live push
   * route can be re-bound to a NEW connection via `agent.taskResume`. A client
   * disconnect therefore never kills agent work: the turn keeps running
   * (detached) and a reconnecting client resumes from `known_length`.
   */
  private readonly taskReplay = new Map<string, TaskReplayEntry>();

  /** Terminal (done/error) replay entries stay resumable this long. */
  private static readonly TASK_REPLAY_TTL_MS = 25 * 60 * 1000;
  /** Per-task accumulated-text cap; beyond it resume answers 'lost'. */
  private static readonly TASK_REPLAY_MAX_UNITS = 4_000_000;

  private readonly taskReplayReaper: NodeJS.Timeout;

  /**
   * Optional slash-command registry. When set, the default
   * `onSlashCommand` dispatches to its handlers and `onCommandsList`
   * surfaces them in the shepaw `/` palette. Concrete agents install
   * this in their constructor (see `implementations/**\/commands`).
   */
  protected slashRegistry?: SlashCommandRegistry<unknown>;

  /**
   * Injected capability providers consumed by SDK-shipped slash handlers
   * (`/model`, `/status`, `/mcp`, `/permissions`). Agents populate only
   * the providers they can implement; handlers gracefully degrade when
   * a provider is absent.
   */
  protected slashProviders: SlashProviders = {};

  constructor(opts: ACPAgentServerOptions = {}) {
    this.name = opts.name ?? 'ACP Agent';
    this.identity = loadOrCreateIdentity({ path: opts.identityPath });
    this.agentId = this.identity.agentId;
    this.peers = loadOrCreatePeers({ path: opts.peersPath });
    this.enrollmentsPath = resolveEnrollmentsPath(opts.enrollmentsPath);
    this.description = opts.description ?? `ACP Agent: ${this.name}`;
    this.bio = opts.bio ?? this.description;
    this.systemPrompt = opts.systemPrompt ?? 'You are a helpful AI assistant.';
    this.cleanDirectivesInHistory = opts.cleanDirectivesInHistory ?? true;
    this.convMgr = new ConversationManager({ maxHistory: opts.maxHistory ?? 20 });
    this.tunnelConfig = opts.tunnelConfig;
    this.mailboxConfig = opts.mailboxConfig;
    this.onPeerEnrolledHook = opts.onPeerEnrolled;
    // 0 = unlimited (legacy); default 5
    this.maxConcurrency = opts.maxConcurrency ?? 5;
    this.taskReplayReaper = setInterval(() => this.reapTaskReplay(), 60_000);
    this.taskReplayReaper.unref?.();
  }

  /** Sweep terminal/zombie replay entries past their TTL. */
  private reapTaskReplay(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.taskReplay) {
      if (entry.terminalAt !== undefined) {
        if (now - entry.terminalAt > ACPAgentServer.TASK_REPLAY_TTL_MS) {
          this.taskReplay.delete(taskId);
        }
        continue;
      }
      // Zombie guard: not terminal and no running task — the process would
      // have to crash mid-turn for this to matter, but never leak the map.
      if (!this.activeTasks.has(taskId) && now - entry.updatedAt > ACPAgentServer.TASK_REPLAY_TTL_MS) {
        this.taskReplay.delete(taskId);
      }
    }
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

  /**
   * Runtime metrics for Hub supervision (`GET /status`).
   * Override in gateway implementations to attach upstream-specific fields.
   */
  getRuntimeStatus(): AgentRuntimeStatus {
    const activeTasks = this.activeTasks.size;
    return {
      uptimeMs: this.startedAtMs > 0 ? Date.now() - this.startedAtMs : 0,
      activeTasks,
      connectedClients: this.wsServer?.clients.size ?? 0,
      busyLevel: deriveBusyLevel(activeTasks),
      capacity: this.maxConcurrency,
    };
  }

  /** Return the agent card (override to customise). */
  getAgentCard(): AgentCard {
    return {
      agent_id: this.agentId,
      name: this.name,
      description: this.description,
      bio: this.bio,
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

  /**
   * Return the list of slash commands this agent supports.
   *
   * Default behavior: if a `slashRegistry` is set, returns its registered
   * handlers as `scope: 'builtin', source: 'sdk'` entries so the shepaw
   * "/" palette surfaces them automatically.
   *
   * Subclasses commonly override to MERGE this with filesystem-scanned
   * frontmatter (e.g. `.claude/commands/`) + SDK init's `slash_commands`:
   *
   *   override async onCommandsList(p) {
   *     const base = await super.onCommandsList(p);
   *     const scanned = ... ;
   *     return { commands: dedup([...base.commands, ...scanned]) };
   *   }
   */
  async onCommandsList(_params: CommandsListParams): Promise<CommandsListResult> {
    if (!this.slashRegistry) return { commands: [] };
    return {
      commands: this.slashRegistry.listPrimary().map((h) => ({
        name: h.name,
        description: h.description,
        argument_hint: h.argumentHint,
        scope: 'builtin',
        source: 'sdk',
      })),
    };
  }

  /**
   * Return the conversation sessions this agent knows about so the app can
   * mirror the agent's real session list (and avoid "session crossing").
   *
   * Default behavior: `{ sessions: [] }` — the base SDK has no notion of
   * enumerable sessions. Proxy/agent implementations that CAN enumerate
   * sessions (e.g. an ACP proxy over an agent that supports `session/list`)
   * override this to return the real list. Agents that can't enumerate
   * should keep returning `[]` (the app degrades gracefully).
   */
  async onSessionsList(_params: SessionsListParams): Promise<SessionsListResult> {
    return { sessions: [] };
  }

  /**
   * Return a session's replayed transcript (oldest → newest) so the app can
   * lazily backfill chat history when opening a synced remote session.
   *
   * Default: `{ messages: [] }`. Proxy implementations over an agent that can
   * `session/load`-replay override this to return the real transcript.
   */
  async onSessionHistory(_params: SessionHistoryParams): Promise<SessionHistoryResult> {
    return { messages: [] };
  }

  /**
   * Hook called before `onChat` whenever the user message starts with a "/".
   *
   * Default behavior: if a `slashRegistry` is set, look up by `command`
   * and dispatch. Handlers that match return `true` (we skip onChat);
   * unmatched commands return `false` (fall through to the LLM — this
   * is the correct behavior for commands like `/compact` or `/plan`
   * that the SDK/CLI handles at a lower layer).
   *
   * Return `true` to signal the command was handled; the server will send
   * `sendTextFinal` + `completed` around it exactly like onChat, but will
   * NOT call onChat afterwards — the agent skips the LLM entirely.
   *
   * Return `false` (or let the default no-op run) to fall through to the
   * normal onChat flow, exactly as if the hook didn't exist.
   *
   * Arguments:
   *   - `command`: the word immediately after "/" (e.g. "model" for "/model list")
   *   - `args`: everything after the first whitespace, trimmed (e.g. "list")
   *   - `raw`: the full trimmed message including the leading "/"
   *
   * Subclasses that want ad-hoc command interception (without the registry)
   * can still override this method directly.
   */
  async onSlashCommand(
    ctx: TaskContext,
    command: string,
    args: string,
    raw: string,
    kwargs: ChatKwargs,
  ): Promise<boolean> {
    if (!this.slashRegistry?.has(command)) return false;
    const argTokens = args.trim() === '' ? [] : args.trim().split(/\s+/);
    return this.slashRegistry.dispatch(ctx, command, argTokens, raw, kwargs as unknown as Record<string, unknown>, {
      cfg: (this as unknown as { cfg?: unknown }).cfg,
      providers: this.slashProviders,
      registerFormHandler: (id, fn) => this.registerFormHandler(id, fn),
    });
  }

  /**
   * Return the list of models the underlying SDK exposes (from
   * `query.supportedModels()` or equivalent). The default returns an empty
   * list — agents that don't expose models leave this alone.
   */
  async onModelsList(_params: ModelsListParams): Promise<ModelsListResult> {
    return { models: [] };
  }

  /**
   * Switch the currently-selected model for this agent. Subsequent `onChat`
   * calls should use the new model. The default throws — agents without a
   * runtime model switch should not advertise model listing either.
   */
  async onModelsSetCurrent(_p: ModelsSetCurrentParams): Promise<ModelsSetCurrentResult> {
    throw new Error('agent.models.setCurrent not supported by this agent');
  }

  /**
   * Native ACP session / permission modes (auto, plan, acceptEdits, …).
   * Default is an empty list — agents that don't expose modes leave this alone.
   */
  async onModesList(_params: ModesListParams): Promise<ModesListResult> {
    return { modes: [] };
  }

  /**
   * Switch the current session mode. Subsequent turns should use the new mode.
   * Default throws — agents without a runtime mode switch should not advertise
   * a non-empty `onModesList` either.
   */
  async onModesSetCurrent(_p: ModesSetCurrentParams): Promise<ModesSetCurrentResult> {
    throw new Error('agent.modes.setCurrent not supported by this agent');
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
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? 8080;

    const { httpServer, wsServer } = this.createServer();
    this.httpServer = httpServer;
    this.wsServer = wsServer;

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        this.startedAtMs = Date.now();
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
        // 连接即注册：握手携带 agent 身份，channel 服务端 upsert 注册记录。
        agentInfo: {
          agentId: this.agentId,
          agentFp: this.identity.fingerprint,
          agentPubKey: Buffer.from(this.identity.staticPublicKey).toString('base64'),
          agentName: this.name,
          deviceId: hostname(),
          capacity: this.maxConcurrency > 0 ? this.maxConcurrency : undefined,
        },
        onControlMessage: (msg) => {
          if (msg.type === 'mail_waiting') {
            const messageId = typeof msg.message_id === 'string' ? msg.message_id : undefined;
            void this.drainMailbox(messageId ? { messageId } : undefined);
          } else if (msg.type === 'access_grant') {
            void this.syncGrants();
          }
        },
      });
      await this.tunnelClient.start();
      const publicUrl = this.tunnelConfig.getPublicEndpoint({
        agentId: this.agentId,
        fingerprint: this.identity.fingerprint,
        // The Noise IK initiator needs the responder's static public key
        // upfront to encrypt its first handshake message, so the paste URL
        // must carry it in the (client-only) fragment — same as the LAN
        // banner does for `ACP WS:` below.
        publicKey: this.identity.staticPublicKey,
      });
      // eslint-disable-next-line no-console
      console.log(`  Public WS: ${publicUrl}`);
      // eslint-disable-next-line no-console
      console.log('='.repeat(60));
    }
    this.startMailboxPoller();
    this.startGrantSync();
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
    this.chatQueues.clear();

    this.stopPeersWatcher();

    this.stopMailboxPoller();
    this.stopGrantSync();

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
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const url = parsed.pathname;
    if (url === '/health') {
      // Return agent identity info so clients can detect if the gateway was
      // re-keyed (identity.json deleted/replaced) and know to re-pair rather
      // than infinitely retrying with a stale public key.
      const pk = Buffer.from(this.identity.staticPublicKey).toString('base64');
      const body = JSON.stringify({
        status: 'ok',
        agentId: this.agentId,
        fingerprint: this.identity.fingerprint,
        publicKey: pk,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (url === '/status') {
      const body = JSON.stringify({
        status: 'ok',
        agentId: this.agentId,
        fingerprint: this.identity.fingerprint,
        runtime: this.getRuntimeStatus(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    if (url === '/mailbox/wake') {
      const messageId = parsed.searchParams.get('message_id') ?? '';
      void this.drainMailbox(messageId.length > 0 ? { messageId } : undefined);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: messageId || undefined }));
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
    try {
      this.onPeerEnrolledHook?.({
        publicKeyB64: pubB64,
        label,
        code: consumed.token.code,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[ACP] ${remote}: onPeerEnrolled hook failed:`, err);
    }
    return entry;
  }

  // ── WebSocket handler ──────────────────────────────────────────

  private async handleWebSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const sws = ws as ShepawWebSocket;
    // eslint-disable-next-line no-console
    console.log(`[ACP] New WebSocket connection from ${remote}`);
    this.openConnections += 1;

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
      this.openConnections = Math.max(0, this.openConnections - 1);
      // Detach this connection from every task route. Tasks keep RUNNING:
      // their output accumulates in the replay buffer and a reconnecting
      // client re-attaches via agent.taskResume. Approval waiters
      // (pendingResponses) and hub requests likewise stay — their own
      // timeouts are the backstop, and a verdict delivered after reconnect
      // resolves them. (The old behavior aborted everything on the LAST
      // close, which is what stranded agents on [pending] after a flap.)
      for (const entry of this.taskReplay.values()) {
        if (entry.route === (ws as ShepawWebSocket)) entry.route = undefined;
      }
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
        case 'agent.taskResume':
          await this.handleTaskResume(ws, msgId, params);
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
        case 'agent.resume.rebuild':
          await this.handleResumeRebuild(ws, msgId, params);
          return;
        case 'agent.resume.promptSet':
          await this.handleResumePromptSet(ws, msgId, params);
          return;
        case 'agent.resume.summarySet':
          await this.handleResumeSummarySet(ws, msgId, params);
          return;
        case 'agent.commands.list':
          await this.handleCommandsList(ws, msgId, params);
          return;
        case 'agent.sessions.list':
          await this.handleSessionsList(ws, msgId, params);
          return;
        case 'agent.sessions.history':
          await this.handleSessionHistory(ws, msgId, params);
          return;
        case 'agent.models.list':
          await this.handleModelsList(ws, msgId, params);
          return;
        case 'agent.models.setCurrent':
          await this.handleModelsSetCurrent(ws, msgId, params);
          return;
        case 'agent.modes.list':
          await this.handleModesList(ws, msgId, params);
          return;
        case 'agent.modes.setCurrent':
          await this.handleModesSetCurrent(ws, msgId, params);
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

    // 跨会话并发闸门：满员时回 busy，不入队、不占 activeTasks。
    // history_supplement 是轻量操作，不计入闸门。
    if (
      !isHistorySupplement &&
      this.maxConcurrency > 0 &&
      this.activeTasks.size >= this.maxConcurrency
    ) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          result: {
            task_id: taskId,
            status: 'busy',
            active: this.activeTasks.size,
            capacity: this.maxConcurrency,
          },
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

    // Replay entry + transport: every outbound frame for this task is tapped
    // into the buffer first, then pushed to the current live route (if any).
    // The route dies with its connection; the buffer keeps the turn resumable.
    const replayEntry: TaskReplayEntry = {
      sessionId,
      accumulated: '',
      status: 'streaming',
      pendingConfirmations: new Map(),
      route: ws as ShepawWebSocket,
      updatedAt: Date.now(),
      overflowed: false,
    };
    this.taskReplay.set(taskId, replayEntry);
    const transport = async (message: Record<string, unknown>): Promise<void> => {
      const tapped = this.tapTaskEvent(replayEntry, message);
      const route = replayEntry.route;
      if (route === undefined || route.v2Closing === true || route.readyState !== route.OPEN) {
        return;
      }
      try {
        await wsSend(route, message);
        if (tapped.confirmationId !== undefined) {
          const pc = replayEntry.pendingConfirmations.get(tapped.confirmationId);
          if (pc !== undefined) pc.delivered = true;
        }
      } catch {
        // Route died mid-send — detach; the buffer keeps the turn resumable.
        if (replayEntry.route === route) replayEntry.route = undefined;
      }
    };

    const ctx = new TaskContext({
      ws,
      taskId,
      sessionId,
      pendingHubRequests: this.pendingHubRequests,
      pendingResponses: this.pendingResponses,
      takeEarlyResponse: (id) => this.takeEarlyResponse(id, taskId),
      transport,
    });

    // Enqueue this task behind any already-running task for the same session.
    // This prevents concurrent agent.chat calls (e.g. multiple simultaneous
    // "Allow All Similar" taps) from racing on the underlying SDK session lock
    // and producing "Session … is already in use" errors.
    const prev = this.chatQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() =>
      this.runChatTask(ctx, message, params, appHistory, abortController.signal),
    );
    // Store a no-reject tail so the queue head never becomes a rejected promise
    // that would swallow subsequent entries.
    this.chatQueues.set(sessionId, next.then(() => undefined, () => undefined));
    // Detach so the WS reader keeps flowing.
    void next;
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
      group_context: normalizeGroupContext(params.group_context),
      tools: normalizeTools(params.tools),
      ui_component_version:
        typeof params.ui_component_version === 'string' ? params.ui_component_version : undefined,
      user_id: typeof params.user_id === 'string' ? params.user_id : '',
      message_id: typeof params.message_id === 'string' ? params.message_id : '',
      is_history_supplement: params.history_supplement === true,
      params,
    };

    try {
      await ctx.started();

      // Slash-command pre-interception: messages starting with "/" are first
      // offered to `onSlashCommand`. Concrete agents use this to short-circuit
      // commands like `/model` into interactive UIs (sendForm → setModel)
      // without the LLM round-trip. Returning `true` means "I handled it";
      // we skip onChat and fall through to the normal lifecycle wrap
      // (sendTextFinal + completed). Returning `false` means "not mine";
      // onChat runs as usual.
      const trimmed = message.trimStart();
      let handledBySlash = false;
      if (trimmed.startsWith('/')) {
        const space = trimmed.search(/\s/);
        const command = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).trim();
        const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
        if (command.length > 0) {
          handledBySlash = await this.onSlashCommand(ctx, command, args, trimmed, kwargs);
        }
      }

      if (!handledBySlash) {
        await this.onChat(ctx, message, kwargs);
      }

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
      this.discardEarlyResponsesForTask(taskId);
      // 有空位时优先消化信箱 backlog，避免实时流量饿死留言
      void this.drainMailbox();
    }
  }

  // ── channel mailbox ────────────────────────────────────────────

  private channelMailboxCreds(): ChannelMailboxConfig | undefined {
    if (this.tunnelConfig !== undefined) {
      return {
        serverUrl: this.tunnelConfig.serverUrl,
        channelId: this.tunnelConfig.channelId,
        secret: this.tunnelConfig.secret,
      };
    }
    return this.mailboxConfig;
  }

  private startMailboxPoller(): void {
    const creds = this.channelMailboxCreds();
    if (creds === undefined) return;
    this.mailboxClient = new MailboxClient({
      serverUrl: creds.serverUrl,
      channelId: creds.channelId,
      secret: creds.secret,
      agentId: this.agentId,
    });
    // 定时兜底：即使 mail_waiting 丢了也能消化 backlog
    this.mailboxTimer = setInterval(() => void this.drainMailbox(), 30_000);
    this.mailboxTimer.unref?.();
    void this.drainMailbox();
  }

  private stopMailboxPoller(): void {
    if (this.mailboxTimer !== undefined) {
      clearInterval(this.mailboxTimer);
      this.mailboxTimer = undefined;
    }
    this.mailboxClient = undefined;
  }

  private startGrantSync(): void {
    const creds = this.channelMailboxCreds();
    if (creds === undefined) return;
    this.grantSync = new GrantSyncClient({
      serverUrl: creds.serverUrl,
      channelId: creds.channelId,
      secret: creds.secret,
      agentId: this.agentId,
      peersPath: this.peers.path,
      onLog: (line) => console.log(line),
    });
    this.grantTimer = setInterval(() => void this.syncGrants(), 60_000);
    this.grantTimer.unref?.();
    void this.syncGrants();
  }

  private stopGrantSync(): void {
    if (this.grantTimer !== undefined) {
      clearInterval(this.grantTimer);
      this.grantTimer = undefined;
    }
    this.grantSync = undefined;
  }

  private async syncGrants(): Promise<void> {
    if (this.grantSync === undefined) return;
    try {
      await this.grantSync.syncOnce();
      // addPeer/removePeer rewrite the file; watcher reloads, but refresh eagerly.
      this.reloadPeers();
    } catch (err) {
      console.log(`[GrantSync] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Pull sealed inbound messages while we have capacity; run onChat offline;
   * seal reply to caller's static pubkey and deposit.
   *
   * When [hint.messageId] is set (mail_waiting metadata), skip if already
   * processed and claim that specific inbox row instead of the whole queue.
   */
  private async drainMailbox(hint?: { messageId?: string }): Promise<void> {
    const hintedId = hint?.messageId;
    if (hintedId !== undefined && hintedId.length > 0) {
      this.pendingMailHints.add(hintedId);
    }
    if (this.mailboxBusy || this.mailboxClient === undefined) return;
    if (this.maxConcurrency > 0 && this.activeTasks.size >= this.maxConcurrency) return;

    const takeHint = (): string | undefined => {
      const first = this.pendingMailHints.values().next().value as string | undefined;
      if (first !== undefined) this.pendingMailHints.delete(first);
      return first;
    };
    let targetId = takeHint();
    if (
      targetId !== undefined &&
      (this.processedMailIds.has(targetId) || this.inFlightMailIds.has(targetId))
    ) {
      targetId = undefined;
    }

    this.mailboxBusy = true;
    try {
      while (this.maxConcurrency <= 0 || this.activeTasks.size < this.maxConcurrency) {
        const batch =
          targetId !== undefined && targetId.length > 0
            ? await this.mailboxClient.claimPending(1, targetId)
            : await this.mailboxClient.claimPending(1);
        if (batch.length === 0) {
          if (targetId !== undefined) {
            targetId = takeHint();
            continue;
          }
          break;
        }
        for (const mail of batch) {
          await this.processMailboxItem(mail);
        }
        targetId = takeHint();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[Mailbox] drain failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.mailboxBusy = false;
      if (this.pendingMailHints.size > 0) {
        void this.drainMailbox();
      }
    }
  }

  private async processMailboxItem(mail: {
    id: string;
    message_id: string;
    request_id?: string;
    session_id: string;
    group_id?: string;
    caller_fp: string;
    ciphertext: string;
  }): Promise<void> {
    if (this.mailboxClient === undefined) return;

    if (this.processedMailIds.has(mail.message_id)) {
      await this.mailboxClient.ackInbound([mail.id]);
      return;
    }
    if (this.inFlightMailIds.has(mail.message_id)) {
      return;
    }
    this.inFlightMailIds.add(mail.message_id);

    try {
      await this.runMailboxItem(mail);
    } finally {
      this.inFlightMailIds.delete(mail.message_id);
    }
  }

  private async runMailboxItem(mail: {
    id: string;
    message_id: string;
    request_id?: string;
    session_id: string;
    group_id?: string;
    caller_fp: string;
    ciphertext: string;
  }): Promise<void> {
    if (this.mailboxClient === undefined) return;

    let payload: {
      message?: string;
      session_id?: string;
      message_id?: string;
      request_id?: string;
      group_id?: string;
      group_context?: unknown;
      history?: ConversationMessage[];
      caller_pubkey?: string;
    };
    try {
      payload = openJson(mail.ciphertext, this.identity.staticPrivateKey);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[Mailbox] decrypt failed for ${mail.id}: ${err instanceof Error ? err.message : String(err)}`);
      await this.mailboxClient.ackInbound([mail.id]); // 坏密文丢弃，避免死循环
      this.processedMailIds.add(mail.message_id);
      return;
    }

    const peer = this.peers.peers.find((p) => p.fingerprint === mail.caller_fp.toLowerCase());
    if (peer === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`[Mailbox] unknown caller_fp ${mail.caller_fp}, rejecting`);
      const callerPub = decodeMailboxCallerPub(payload.caller_pubkey);
      if (callerPub !== undefined) {
        try {
          const ciphertext = sealJson(
            {
              kind: 'chat',
              error: 'unauthorized',
              content: 'caller is not an authorized peer',
              is_final: true,
              ts: Date.now(),
            },
            callerPub,
          );
          await this.mailboxClient.depositReply({
            callerFp: mail.caller_fp,
            replyTo: mail.message_id,
            sessionId: mail.session_id,
            requestId: mail.request_id || mail.message_id,
            groupId: mail.group_id,
            kind: 'chat',
            messageId: `${mail.message_id}:error:unauthorized`,
            ciphertext,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[Mailbox] sealed unauthorized reply failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await this.mailboxClient.ackInbound([mail.id]);
      this.processedMailIds.add(mail.message_id);
      return;
    }

    const message = typeof payload.message === 'string' ? payload.message : '';
    if (!message) {
      await this.mailboxClient.ackInbound([mail.id]);
      this.processedMailIds.add(mail.message_id);
      return;
    }

    const sessionId = mail.session_id || payload.session_id || mail.message_id;
    const requestId =
      mail.request_id ||
      payload.request_id ||
      mail.message_id;
    const groupId = mail.group_id || payload.group_id;
    const taskId = `mailbox_${mail.message_id}`;
    const abortController = new AbortController();
    this.activeTasks.set(taskId, abortController);

    const mailboxStream = createMailboxStreamSink({
      client: this.mailboxClient,
      callerFp: mail.caller_fp,
      replyTo: mail.message_id,
      requestId,
      sessionId,
      groupId,
      sealJson,
      callerPublicKey: peer.publicKey,
    });

    const ctx = new TaskContext({
      ws: { readyState: 3 } as unknown as WebSocket, // CLOSED stub
      taskId,
      sessionId,
      pendingHubRequests: this.pendingHubRequests,
      pendingResponses: this.pendingResponses,
      mailboxStream,
    });

    try {
      if (!this.convMgr.hasSession(sessionId) && Array.isArray(payload.history) && payload.history.length > 0) {
        this.convMgr.initializeSession(sessionId, payload.history);
      }
      this.convMgr.addUserMessage(sessionId, message);

      const kwargs: ChatKwargs = {
        session_id: sessionId,
        history: payload.history,
        messages: this.convMgr.getMessages(sessionId),
        attachments: undefined,
        system_prompt: this.systemPrompt,
        group_context:
          normalizeGroupContext(payload.group_context) ??
          (groupId ? { group_id: groupId } : undefined),
        tools: undefined,
        ui_component_version: undefined,
        user_id: mail.caller_fp,
        message_id: mail.message_id,
        is_history_supplement: false,
        params: {},
      };
      await this.onChat(ctx, message, kwargs);
      const replyText = ctx.collectedText;

      if (replyText.length > 0) {
        this.convMgr.addAssistantMessage(sessionId, replyText);
        await mailboxStream.depositFinal(replyText);
      }
      await this.mailboxClient.ackInbound([mail.id]);
      this.processedMailIds.add(mail.message_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[Mailbox] process ${mail.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      // 不 ack → visibility timeout 后重试
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  // ── task replay / resume ───────────────────────────────────────

  /**
   * Tap an outbound frame into the task's replay buffer. Runs BEFORE the
   * live push so a dead route never loses an event. Only the frames a
   * reconnecting client needs are captured: text deltas, the latest metadata,
   * outstanding confirmations, and the terminal result. Returns the tapped
   * confirmation id so the transport can mark it delivered once the push
   * lands.
   */
  private tapTaskEvent(
    entry: TaskReplayEntry,
    message: Record<string, unknown>,
  ): { confirmationId?: string } {
    entry.updatedAt = Date.now();
    const method = message.method as string | undefined;
    const params = (message.params as Record<string, unknown> | undefined) ?? {};
    switch (method) {
      case 'ui.textContent': {
        if (params.is_final === true) return {};
        const content = params.content as string | undefined;
        if (content === undefined || content.length === 0) return {};
        if (entry.accumulated.length + content.length > ACPAgentServer.TASK_REPLAY_MAX_UNITS) {
          entry.overflowed = true;
          return {};
        }
        entry.accumulated += content;
        return {};
      }
      case 'ui.messageMetadata': {
        const { task_id: _taskId, ...meta } = params;
        entry.lastMetadata = meta;
        return {};
      }
      case 'ui.actionConfirmation': {
        const cid = params.confirmation_id as string | undefined;
        if (cid !== undefined) {
          entry.pendingConfirmations.set(cid, { params, delivered: false });
          return { confirmationId: cid };
        }
        return {};
      }
      case 'task.completed':
      case 'task.error':
        entry.status = method === 'task.completed' ? 'done' : 'error';
        entry.terminalParams = params;
        entry.terminalAt = Date.now();
        return {};
      default:
        return {};
    }
  }

  /**
   * `agent.taskResume` — re-attach a client to a task that kept running (or
   * finished) while its connection was away. Delta semantics mirror the hub's
   * peer-level turn resume: `known_length` is the client's received prefix of
   * the task's text stream; the response carries exactly the missing suffix
   * plus the current status. Live output after the resume flows on THIS
   * connection, and outstanding confirmations are re-emitted so approval
   * cards can be re-relayed.
   */
  private async handleTaskResume(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : '';
    const known = typeof params.known_length === 'number' ? params.known_length : 0;
    const entry = taskId.length > 0 ? this.taskReplay.get(taskId) : undefined;
    if (entry === undefined || entry.overflowed) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          result: { task_id: taskId, status: 'lost', message: 'task unknown or expired' },
        }),
      );
      return;
    }

    // Rebind BEFORE answering: chunks emitted between the response and the
    // rebind would otherwise be lost to the old (dead) route.
    entry.route = ws as ShepawWebSocket;

    const base = Math.max(0, Math.min(known, entry.accumulated.length));
    const delta = entry.accumulated.slice(base);
    if (entry.status === 'streaming') {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          result: {
            task_id: taskId,
            status: 'streaming',
            delta,
            ...(entry.lastMetadata !== undefined ? { stream_metadata: entry.lastMetadata } : {}),
          },
        }),
      );
    } else if (entry.status === 'done') {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          result: {
            task_id: taskId,
            status: 'done',
            delta,
            content: entry.accumulated,
            ...(entry.terminalParams !== undefined ? { metadata: entry.terminalParams } : {}),
          },
        }),
      );
    } else {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          result: {
            task_id: taskId,
            status: 'error',
            delta,
            message: (entry.terminalParams?.message as string | undefined) ?? 'agent error',
          },
        }),
      );
    }

    // Re-emit tool-call confirmations that never reached a client so the
    // (re-attached) client can relay the approval cards. Cards acked by a
    // previous route are NOT re-sent — the client is already showing them.
    for (const pending of entry.pendingConfirmations.values()) {
      if (pending.delivered) continue;
      try {
        await wsSend(ws, jsonrpcNotification('ui.actionConfirmation', pending.params));
        pending.delivered = true;
      } catch {
        if (entry.route === (ws as ShepawWebSocket)) entry.route = undefined;
        return;
      }
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
        // Resolved — stop re-emitting this card on future taskResume rebinds.
        for (const entry of this.taskReplay.values()) {
          entry.pendingConfirmations.delete(componentId);
        }
        const deferred = this.pendingResponses.get(componentId);
        if (deferred !== undefined && !deferred.settled) {
          deferred.resolve(responseData);
        } else {
          // Keep the verdict for this task so a reply that raced ahead of —
          // or outlived — its waitForResponse is not silently dropped (the
          // turn would otherwise stay on [pending] with no way to resolve).
          // Unlike the old 2s buffer, retention is bounded by the task's own
          // lifetime and discarded at teardown, so a genuinely slow review is
          // never lost to a short clock.
          // eslint-disable-next-line no-console
          console.warn(
            `[ACP] submitResponse: no waiter for ${idKey}=${componentId} ` +
            `task=${taskId} — buffering until task end`,
          );
          this.bufferEarlyResponse(componentId, taskId, responseData);
        }
        break;
      }
    }
  }

  /** Keep a no-waiter submitResponse for the owning task (see field doc). */
  private bufferEarlyResponse(
    componentId: string,
    taskId: string,
    responseData: Record<string, unknown>,
  ): void {
    this.earlyResponses.set(componentId, { taskId, data: responseData });
  }

  /**
   * Consume a buffered early submitResponse, if any, that belongs to the given
   * task. Task-scoped so a component id reused by a later task can never pick
   * up a stale verdict from its predecessor.
   */
  takeEarlyResponse(
    componentId: string,
    taskId: string,
  ): Record<string, unknown> | undefined {
    const early = this.earlyResponses.get(componentId);
    if (early === undefined || early.taskId !== taskId) return undefined;
    this.earlyResponses.delete(componentId);
    return early.data;
  }

  /** Drop early-submitResponse buffers belonging to a finished task. */
  private discardEarlyResponsesForTask(taskId: string): void {
    if (this.earlyResponses.size === 0) return;
    for (const [componentId, entry] of this.earlyResponses) {
      if (entry.taskId === taskId) this.earlyResponses.delete(componentId);
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

  /**
   * Handle `agent.resume.rebuild` — re-derive the agent's workspace resume.
   * Default implementation is a no-op that returns the current card; gateway
   * implementations override `onResumeRebuild` to actually re-scan.
   */
  private async handleResumeRebuild(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const card = await this.onResumeRebuild(params as ResumeRebuildParams | undefined);
      await wsSend(ws, jsonrpcResponse(msgId, { result: card }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  /**
   * Handle `agent.resume.promptSet` — set/clear the custom resume prompt on a
   * running agent without rebuilding. Empty/missing prompt clears.
   */
  private async handleResumePromptSet(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const card = await this.onResumePromptSet((params ?? {}) as ResumePromptSetParams);
      await wsSend(ws, jsonrpcResponse(msgId, { result: card }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  /**
   * Handle `agent.resume.summarySet` — replace the resume `## Summary` text
   * directly, no chat turn involved. Callers pass the new Summary; the
   * implementation writes it into resume.md and returns the fresh card.
   */
  private async handleResumeSummarySet(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const card = await this.onResumeSummarySet(
        ((params ?? {}) as unknown) as ResumeSummarySetParams,
      );
      await wsSend(ws, jsonrpcResponse(msgId, { result: card }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  /**
   * Override point for `agent.resume.rebuild`. Default: return the current
   * card unchanged. Rebuilding implementations must return the fresh card so
   * the caller can refresh its metadata immediately. An optional `prompt`
   * param carries the custom resume prompt to apply before the rebuild.
   */
  async onResumeRebuild(_params?: ResumeRebuildParams): Promise<AgentCard> {
    return this.getAgentCard();
  }

  /**
   * Override point for `agent.resume.promptSet`. Default: no-op returning the
   * current card. Prompt-aware implementations store the prompt (or clear it
   * on an empty value) and return the card unchanged — the resume text itself
   * is only rewritten on the next rebuild or AI polish.
   */
  async onResumePromptSet(_params: ResumePromptSetParams): Promise<AgentCard> {
    return this.getAgentCard();
  }

  /**
   * Override point for `agent.resume.summarySet`. Default: reject — only
   * resume-writing implementations can place the Summary. Implementations
   * must return the fresh card after adopting the text.
   */
  async onResumeSummarySet(_params: ResumeSummarySetParams): Promise<AgentCard> {
    throw new Error('agent.resume.summarySet is not supported by this agent');
  }

  private async handleCommandsList(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const listParams = (params ?? {}) as CommandsListParams;
      const result = await this.onCommandsList(listParams);
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'commands.list failed',
          },
        }),
      );
    }
  }

  private async handleSessionsList(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const listParams = (params ?? {}) as SessionsListParams;
      const result = await this.onSessionsList(listParams);
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'sessions.list failed',
          },
        }),
      );
    }
  }

  private async handleSessionHistory(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const raw = (params ?? {}) as Record<string, unknown>;
      const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
      const result = await this.onSessionHistory({ session_id: sessionId });
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'sessions.history failed',
          },
        }),
      );
    }
  }

  private async handleModelsList(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const p = (params ?? {}) as ModelsListParams;
      const result = await this.onModelsList(p);
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'models.list failed',
          },
        }),
      );
    }
  }

  private async handleModelsSetCurrent(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const raw = (params ?? {}) as Record<string, unknown>;
    const model = typeof raw.model === 'string' ? raw.model : '';
    if (model === '') {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32602, message: 'model parameter required' },
        }),
      );
      return;
    }
    try {
      const result = await this.onModelsSetCurrent({
        model,
        session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      });
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'models.setCurrent failed',
          },
        }),
      );
    }
  }

  private async handleModesList(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      const p = (params ?? {}) as ModesListParams;
      const result = await this.onModesList(p);
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'modes.list failed',
          },
        }),
      );
    }
  }

  private async handleModesSetCurrent(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const raw = (params ?? {}) as Record<string, unknown>;
    const mode = typeof raw.mode === 'string' ? raw.mode : '';
    if (mode === '') {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32602, message: 'mode parameter required' },
        }),
      );
      return;
    }
    try {
      const result = await this.onModesSetCurrent({
        mode,
        session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      });
      await wsSend(ws, jsonrpcResponse(msgId, { result }));
    } catch (err) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: {
            code: -32000,
            message: err instanceof Error ? err.message : 'modes.setCurrent failed',
          },
        }),
      );
    }
  }

  /**
   * Broadcast `agent.commands.changed` to all authenticated connections.
   *
   * Used by concrete agents (e.g. ClaudeCodeAgent) when their command source
   * changes — either because the Claude Agent SDK emitted a fresh `system/init`
   * with updated `slash_commands`, or because files under the agent's commands
   * directory were added / removed / modified.
   *
   * Per-client send failures are swallowed so one bad socket doesn't starve
   * the others.
   */
  protected async broadcastCommandsChanged(
    commands: SlashCommandInfo[],
  ): Promise<void> {
    await this.broadcastNotification('agent.commands.changed', {
      commands,
    } satisfies CommandsChangedParams as unknown as Record<string, unknown>);
  }

  /**
   * Broadcast a JSON-RPC notification to all authenticated connections.
   *
   * Generic counterpart to `broadcastCommandsChanged` — lets concrete agents
   * push their own push-style events (e.g. `agent.resume.changed`) without
   * reaching into the private ws server. Per-client send failures are
   * swallowed so one bad socket doesn't starve the others.
   */
  protected async broadcastNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (this.wsServer === undefined) return;
    const msg = jsonrpcNotification(method, params);
    for (const client of this.wsServer.clients) {
      const sws = client as ShepawWebSocket;
      if (sws.authorizedPeer === undefined) continue;
      try {
        await wsSend(client, msg);
      } catch {
        /* ignore per-client failure */
      }
    }
  }

  /**
   * Register a fire-and-forget handler to be invoked when the app submits
   * a response for the given `formId` via `agent.submitResponse`.
   *
   * Unlike `TaskContext.waitForResponse`, this does NOT block the caller.
   * The task that sent the form can (and should) complete normally —
   * `sendTextFinal` + `completed` fire, the UI unpins, and this handler
   * runs in the background whenever the user eventually submits.
   *
   * The handler runs outside any task lifecycle: the original task's
   * `TaskContext` is no longer live, so the handler should NOT try to
   * call `ctx.sendText` etc. It should only mutate agent-internal state
   * (e.g. flip `this.currentModel`).
   *
   * Returns a cancel function that removes the pending entry (e.g. if the
   * agent wants to tear down the form on a timeout).
   */
  protected registerFormHandler(
    formId: string,
    handler: (responseData: Record<string, unknown>) => void | Promise<void>,
  ): () => void {
    const deferred = createDeferred<Record<string, unknown>>();
    this.pendingResponses.set(formId, deferred);
    // Consume the promise asynchronously so this call doesn't block.
    void deferred.promise.then(
      async (data) => {
        try {
          await handler(data);
        } catch (err) {
          // Swallow — handler is background, there's no one to report to.
          // eslint-disable-next-line no-console
          console.error(`[form handler ${formId}]`, err);
        } finally {
          this.pendingResponses.delete(formId);
        }
      },
      () => {
        // Rejected (e.g. connection closed, task cancelled) — just clean up.
        this.pendingResponses.delete(formId);
      },
    );
    return () => {
      const existing = this.pendingResponses.get(formId);
      if (existing === deferred && !deferred.settled) {
        deferred.reject(new Error('Form handler cancelled'));
        this.pendingResponses.delete(formId);
      }
    };
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
      `  Status:           http://${displayHost}:${port}/status`,
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

function decodeMailboxCallerPub(raw: unknown): Uint8Array | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return new Uint8Array(buf);
  } catch {
    return undefined;
  }
  return undefined;
}
