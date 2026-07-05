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
  type ChatKwargs,
  type CommandsListParams,
  type CommandsListResult,
  type ModelsListParams,
  type ModelsListResult,
  type ModelsSetCurrentParams,
  type ModelsSetCurrentResult,
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
import {
  resolveEngineSpec,
  type AcpEngineSpec,
} from './engines.js';
import { PermissionPolicy, loadPolicyFromEnv } from './permission/policy.js';

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
  sessionStoreOptions?: SessionStoreOptions;
  tunnelConfig?: ChannelTunnelConfig;
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
  private readonly subprocess: AcpSubprocess;
  private readonly sessionStore: SessionStore;

  /** Last active Shepaw session — used for model picker when no session in params. */
  private lastShepawSessionId: string | undefined;

  constructor(opts: AcpProxyAgentOptions) {
    const spec = opts.engineSpec ?? resolveEngineSpec(opts.engine);

    super({
      name: opts.name ?? spec.defaultAgentName,
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      identityPath: opts.identityPath,
      tunnelConfig: opts.tunnelConfig,
      onPeerEnrolled: opts.onPeerEnrolled ?? createHubFanoutHandler(),
    });

    this.cwd = opts.cwd ?? process.cwd();
    this.subprocess =
      opts.subprocess ??
      new AcpSubprocess({
        spec,
        cwd: this.cwd,
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
    await this.subprocess.start();
  }

  override async onChat(ctx: TaskContext, message: string, kwargs: ChatKwargs): Promise<void> {
    const shepawSessionId = kwargs.session_id ?? ctx.sessionId;
    this.lastShepawSessionId = shepawSessionId;
    const signal = this.activeTasks.get(ctx.taskId)?.signal ?? new AbortController().signal;

    await this.subprocess.runPromptTurn(
      shepawSessionId,
      message,
      { taskCtx: ctx, signal },
      {
        getStoredAcpSessionId: (id) => this.sessionStore.get(id),
        onAcpSessionId: (id, acpId) => this.sessionStore.set(id, acpId),
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
    const upstream = await this.subprocess.listSessions(params.cwd, {
      preserveUpstreamIds: this.sessionStore.allSdkSessionIds(),
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
      };
    });
    return { sessions };
  }

  override async onSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const sessionId = params.session_id;
    if (sessionId.length === 0) return { messages: [] };
    // The app sends the same id it chats with; map it to the upstream agent
    // session id (pre-seeded / recorded in the SessionStore). Falls back to the
    // id itself for adopted-verbatim sessions.
    const upstreamId = this.sessionStore.get(sessionId) ?? sessionId;
    const messages = await this.subprocess.loadSessionTranscript(upstreamId);
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
