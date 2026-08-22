/**
 * Unified ACP proxy gateway.
 *
 * Bridges Shepaw App (Shepaw ACP v2.1 over WebSocket) to any industry-standard
 * ACP agent subprocess (Claude Code, CodeBuddy, Codex, etc.).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  ACPAgentServer,
  SessionStore,
  type AgentRuntimeStatus,
  type ChannelTunnelConfig,
  type ChannelMailboxConfig,
  type ChatKwargs,
  type CommandsListParams,
  type CommandsListResult,
  type ModelsListParams,
  type ModelsListResult,
  type ModelsSetCurrentParams,
  type ModelsSetCurrentResult,
  type ModesListParams,
  type ModesListResult,
  type ModesSetCurrentParams,
  type ModesSetCurrentResult,
  type SessionHistoryParams,
  type SessionHistoryResult,
  type SessionInfo,
  type SessionsListParams,
  type SessionsListResult,
  type SessionStoreOptions,
  type SlashCommandInfo,
  type TaskContext,
} from 'shepaw-acp-sdk';

import { AcpSubprocess } from './acp-subprocess.js';
import { createHubFanoutHandler } from './hub-fanout.js';
import { tryLoadDiskHistory } from './disk-history/index.js';
import { ensureHistoryCreatedAt } from './history-created-at.js';
import { SessionHistoryCache } from './session-history-cache.js';
import {
  resolveEngineSpec,
  type AcpEngineSpec,
} from './engines.js';
import { PermissionPolicy, loadPolicyFromEnv } from './permission/policy.js';
import { preparePromptFromAttachments } from './prompt-attachments.js';
import { log } from './debug.js';
import {
  writeStoreWriteContext,
} from './store-write-context.js';
import {
  buildGroupTaskContextBlock,
  groupStoreWriteScope,
  isGroupTurn,
} from './group-context.js';
import {
  buildStorePouchCard,
  pouchCardEnabled,
  prependStorePouchCard,
  resolveStoreDeviceIdFromEnv,
} from './store-pouch-card.js';

const GATEWAY_DIR_NAME = 'shepaw-acp-proxy-gateway';

export interface AcpProxyAgentOptions {
  /** Engine id (built-in or custom). */
  engine: string;
  /** Override upstream spawn spec (custom engines from Hub). */
  engineSpec?: AcpEngineSpec;
  name?: string;
  peersPath?: string;
  enrollmentsPath?: string;
  identityPath?: string;
  /** Working directory passed to session/new. */
  cwd?: string;
  /** Extra absolute workspace roots (ACP additionalDirectories). */
  additionalDirectories?: readonly string[];
  sessionStoreOptions?: SessionStoreOptions;
  tunnelConfig?: ChannelTunnelConfig;
  /** Shared-device channel mailbox (no per-instance reverse tunnel). */
  mailboxConfig?: ChannelMailboxConfig;
  /** Extra env vars forwarded to the ACP agent subprocess. */
  agentEnv?: Record<string, string | undefined>;
  /** Inject a custom subprocess manager (tests). */
  subprocess?: AcpSubprocess;
  /** Override hub fan-out hook (tests). */
  onPeerEnrolled?: (event: import('shepaw-acp-sdk').PeerEnrolledEvent) => void;
  /** Tool-call approval policy. Defaults to one built from PAW_ACP_APPROVAL_* env. */
  policy?: PermissionPolicy;
}

export class AcpProxyAgent extends ACPAgentServer {
  private readonly cwd: string;
  private readonly additionalDirectories: readonly string[];
  private readonly engineId: string;
  private readonly subprocess: AcpSubprocess;
  private readonly sessionStore: SessionStore;
  private readonly sessionHistoryCache = new SessionHistoryCache();

  /** Last active Shepaw session — used for model picker when no session in params. */
  private lastShepawSessionId: string | undefined;

  /** Sessions that already received the device pouch card (once per Shepaw session). */
  private readonly pouchCardSessions = new Set<string>();

  constructor(opts: AcpProxyAgentOptions) {
    const spec = opts.engineSpec ?? resolveEngineSpec(opts.engine);

    super({
      name: opts.name ?? spec.defaultAgentName,
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      identityPath: opts.identityPath,
      tunnelConfig: opts.tunnelConfig,
      mailboxConfig: opts.mailboxConfig,
      onPeerEnrolled: opts.onPeerEnrolled ?? createHubFanoutHandler(),
    });

    this.cwd = opts.cwd ?? process.cwd();
    this.additionalDirectories = opts.additionalDirectories ?? [];
    this.engineId = spec.id;
    this.subprocess =
      opts.subprocess ??
      new AcpSubprocess({
        spec,
        cwd: this.cwd,
        additionalDirectories: this.additionalDirectories,
        env: opts.agentEnv,
        policy: opts.policy ?? new PermissionPolicy(loadPolicyFromEnv()),
        agentDisplayName: opts.name ?? spec.defaultAgentName,
      });
    this.sessionStore = new SessionStore({
      gatewayDirName: GATEWAY_DIR_NAME,
      ...opts.sessionStoreOptions,
    });
  }

  async init(): Promise<void> {
    await this.sessionStore.load();
    try {
      writeStoreWriteContext({
        agent_id: this.agentId,
        owner: this.agentId,
      });
    } catch {
      /* non-fatal */
    }
    await this.subprocess.start();
    // Make the binding contract visible in hub agent.log (DEBUG may be off):
    // after ACP (re)start we rely on sessions.json to resume, never silently
    // invent a second upstream session for an already-bound app conversation.
    console.error(
      `[acp-proxy] SessionStore ready: ${this.sessionStore.establishedSdkSessionIds().size} established binding(s), ` +
        `${this.sessionStore.orphanedSdkSessionIds().size} orphaned`,
    );
  }

  override async onChat(ctx: TaskContext, message: string, kwargs: ChatKwargs): Promise<void> {
    const shepawSessionId = kwargs.session_id ?? ctx.sessionId;
    this.lastShepawSessionId = shepawSessionId;
    this.sessionHistoryCache.invalidate(shepawSessionId);

    // Group-task turns: artifacts land in the group runtime
    // (`runtime/<group>/<group>/artifacts/…`) so the whole group sees them.
    // Otherwise keep the member-scoped runtime (`runtime/<agent>/<session>/…`).
    const groupContext = kwargs.group_context;
    try {
      if (isGroupTurn(groupContext)) {
        const scope = groupStoreWriteScope(groupContext, this.agentId);
        writeStoreWriteContext({
          agent_id: scope.agentId,
          owner: scope.owner,
          channel: scope.channel,
        });
      } else {
        writeStoreWriteContext({
          agent_id: this.agentId,
          owner: this.agentId,
          channel: shepawSessionId,
        });
      }
    } catch (err) {
      log(
        'store write context update failed: %s',
        err instanceof Error ? err.message : String(err),
      );
    }

    const signal = this.activeTasks.get(ctx.taskId)?.signal ?? new AbortController().signal;

    // Peer / app attachments arrive as path refs (or small base64). Resolve
    // outside the project cwd and pass ContentBlocks into Cursor.
    const prepared = preparePromptFromAttachments(
      message,
      kwargs.attachments,
    );
    if (prepared.materialized.length > 0) {
      log(
        'onChat attachments=%d paths=%s',
        prepared.materialized.length,
        prepared.materialized.map((m) => m.absPath).join(', '),
      );
    }

    let blocks = prepared.blocks;
    if (
      pouchCardEnabled(process.env) &&
      !this.pouchCardSessions.has(shepawSessionId)
    ) {
      const pouchCard = buildStorePouchCard({
        deviceId: resolveStoreDeviceIdFromEnv(process.env),
        workspaceUri: (process.env.SHEPAW_WORKSPACE_URI ?? '').trim() || undefined,
        hostCardMarkdown: (process.env.SHEPAW_SCOPE_CARD ?? '').trim() || undefined,
      });
      // Group-task turn: append the group context block (roster, own role,
      // shared workspace URI) once per session so the upstream agent knows
      // it is working inside a group chat.
      const groupBlock = isGroupTurn(groupContext)
        ? buildGroupTaskContextBlock(groupContext)
        : null;
      const combined = groupBlock ? `${pouchCard}\n\n${groupBlock}` : pouchCard;
      blocks = prependStorePouchCard(blocks, combined);
      this.pouchCardSessions.add(shepawSessionId);
      log(
        'injected device pouch card for session %s%s',
        shepawSessionId,
        groupBlock ? ' (group-task context)' : '',
      );
    }

    await this.subprocess.runPromptTurn(
      shepawSessionId,
      blocks,
      { taskCtx: ctx, signal },
      {
        getStoredAcpSessionId: (id) => this.sessionStore.get(id),
        onAcpSessionId: (id, acpId) => {
          this.sessionStore.set(id, acpId);
          void this.sessionStore.flush();
        },
        priorHistory: kwargs.history,
        // Group-task turns inject the group-tools MCP (dispatch/finish/mention)
        // into the upstream session.
        groupContext: isGroupTurn(groupContext) ? groupContext : undefined,
        onRestoreFailed: (id) => {
          this.sessionStore.delete(id);
        },
        onAbandonedAcpSessionId: (acpId) => {
          this.sessionStore.markOrphaned(acpId);
        },
      },
    );
  }

  override async onCommandsList(_params: CommandsListParams): Promise<CommandsListResult> {
    await this.subprocess.ensureCommandsWarm();
    const commands: SlashCommandInfo[] = this.subprocess.availableCommands.map((cmd) => ({
      name: cmd.name.startsWith('/') ? cmd.name.slice(1) : cmd.name,
      description: cmd.description ?? '',
      source: 'sdk' as const,
    }));

    return { commands };
  }

  override async onSessionsList(params: SessionsListParams): Promise<SessionsListResult> {
    // Register disposable warmup ids before session/list so Cursor ghosts from
    // commands/model warm-up are filtered for both Hub Dashboard and app sync.
    await this.subprocess.ensureCommandsWarm();
    const upstream = await this.subprocess.listSessions(params.cwd, {
      preserveUpstreamIds: this.sessionStore.establishedSdkSessionIds(),
      orphanedUpstreamIds: this.sessionStore.orphanedSdkSessionIds(),
    });
    const sessions: SessionInfo[] = upstream.map((s) => {
      // If the app already has a mapping to this upstream session, surface it
      // under the app's own session id so it reuses the existing local channel
      // instead of adopting a second (crossing) one.
      const knownShepawId = this.sessionStore.findShepawIdBySdkId(s.sessionId);
      const sessionId = knownShepawId ?? s.sessionId;
      // For a not-yet-known session the app adopts the upstream id verbatim.
      // Pre-seed the mapping (id → same upstream id) so the first chat on this
      // adopted id goes through getOrCreateSession → tryRestoreSession and
      // RESUMES the real upstream session (rather than spawning an empty one),
      // which is exactly what prevents "session crossing".
      if (knownShepawId === undefined) {
        this.sessionStore.set(sessionId, s.sessionId);
      }
      return {
        session_id: sessionId,
        title: s.title ?? undefined,
        updated_at: s.updatedAt ?? undefined,
        cwd: s.cwd,
        ...(Array.isArray(s.additionalDirectories) && s.additionalDirectories.length > 0
          ? { additional_directories: s.additionalDirectories }
          : this.additionalDirectories.length > 0
            ? { additional_directories: [...this.additionalDirectories] }
            : {}),
      };
    });
    return { sessions };
  }

  override async onSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const sessionId = params.session_id;
    if (sessionId.length === 0) return { messages: [] };

    const cached = this.sessionHistoryCache.get(sessionId);
    if (cached !== undefined) return { messages: cached };

    // The app sends the same id it chats with; map it to the upstream agent
    // session id (pre-seeded / recorded in the SessionStore). Falls back to the
    // id itself for adopted-verbatim sessions.
    const upstreamId = this.sessionStore.get(sessionId) ?? sessionId;

    // Prefer durable engine stores that already carry per-message timestamps.
    const fromDisk = await tryLoadDiskHistory(this.engineId, upstreamId, this.cwd);
    if (fromDisk !== null && fromDisk.length > 0) {
      const messages = ensureHistoryCreatedAt(fromDisk);
      log(
        'session history from disk engine=%s session=%s messages=%d',
        this.engineId,
        upstreamId,
        messages.length,
      );
      this.sessionHistoryCache.set(sessionId, messages);
      return { messages };
    }

    // Resolve session-level updated_at so history normalization can anchor
    // messages that the engine does not stamp individually.
    let sessionUpdatedAt: string | undefined;
    try {
      const listed = await this.subprocess.listSessions(undefined, {
        preserveUpstreamIds: this.sessionStore.establishedSdkSessionIds(),
        orphanedUpstreamIds: this.sessionStore.orphanedSdkSessionIds(),
      });
      const match = listed.find((s) => {
        const knownShepawId = this.sessionStore.findShepawIdBySdkId(s.sessionId);
        const id = knownShepawId ?? s.sessionId;
        return id === sessionId || s.sessionId === upstreamId;
      });
      sessionUpdatedAt = match?.updatedAt ?? undefined;
    } catch {
      // Non-fatal — ensureHistoryCreatedAt falls back without an anchor.
    }

    const messages = await this.subprocess.loadSessionTranscript(upstreamId, {
      sessionUpdatedAt,
    });
    this.sessionHistoryCache.set(sessionId, messages);
    return { messages };
  }

  override async onModelsList(params: ModelsListParams): Promise<ModelsListResult> {
    await this.subprocess.ensureCommandsWarm();
    return this.subprocess.modelsList(params.session_id);
  }

  override async onModelsSetCurrent(params: ModelsSetCurrentParams): Promise<ModelsSetCurrentResult> {
    const sessionId = params.session_id ?? this.lastShepawSessionId;
    return this.subprocess.setModel(params.model, sessionId);
  }

  override async onModesList(params: ModesListParams): Promise<ModesListResult> {
    await this.subprocess.ensureCommandsWarm();
    return this.subprocess.modesList(params.session_id);
  }

  override async onModesSetCurrent(params: ModesSetCurrentParams): Promise<ModesSetCurrentResult> {
    const sessionId = params.session_id ?? this.lastShepawSessionId;
    return this.subprocess.setMode(params.mode, sessionId);
  }

  override getRuntimeStatus(): AgentRuntimeStatus {
    return {
      ...super.getRuntimeStatus(),
      ...this.subprocess.getRuntimeSnapshot(),
    };
  }

  /** Gracefully tear down the upstream ACP subprocess. */
  async shutdown(): Promise<void> {
    await this.subprocess.stop();
  }

  /** Resolved gateway state directory for CLI messaging. */
  static defaultConfigDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg !== undefined && xdg.length > 0) {
      return join(xdg, GATEWAY_DIR_NAME);
    }
    return join(homedir(), '.config', GATEWAY_DIR_NAME);
  }
}

export {
  ACP_ENGINES,
  BUILTIN_ENGINE_IDS,
  getBuiltinEngineSpec,
  getEngineSpec,
  isAcpEngineId,
  isBuiltinEngineId,
  listBuiltinEngineIds,
  listEngineIds,
  resolveEngineSpec,
} from './engines.js';
export type { AcpEngineId, AcpEngineSpec, BuiltinEngineId, ResolveEngineSpecOptions } from './engines.js';
export { formatShellCommand, parseShellCommand } from './command-line.js';
