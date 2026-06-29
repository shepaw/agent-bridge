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
  type ChannelTunnelConfig,
  type ChatKwargs,
  type CommandsListParams,
  type CommandsListResult,
  type ModelsListParams,
  type ModelsListResult,
  type ModelsSetCurrentParams,
  type ModelsSetCurrentResult,
  type SessionStoreOptions,
  type SlashCommandInfo,
  type TaskContext,
} from 'shepaw-acp-sdk';

import { AcpSubprocess } from './acp-subprocess.js';
import {
  type AcpEngineId,
  getEngineSpec,
  isAcpEngineId,
} from './engines.js';

const GATEWAY_DIR_NAME = 'shepaw-acp-proxy-gateway';

export interface AcpProxyAgentOptions {
  /** Which upstream ACP agent to spawn. */
  engine: AcpEngineId;
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
}

export class AcpProxyAgent extends ACPAgentServer {
  private readonly cwd: string;
  private readonly subprocess: AcpSubprocess;
  private readonly sessionStore: SessionStore;

  /** Last active Shepaw session — used for model picker when no session in params. */
  private lastShepawSessionId: string | undefined;

  constructor(opts: AcpProxyAgentOptions) {
    if (!isAcpEngineId(opts.engine)) {
      throw new Error(`Unknown ACP engine: ${String(opts.engine)}`);
    }

    const spec = getEngineSpec(opts.engine);
    super({
      name: opts.name ?? spec.defaultAgentName,
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      identityPath: opts.identityPath,
      tunnelConfig: opts.tunnelConfig,
    });

    this.cwd = opts.cwd ?? process.cwd();
    this.subprocess =
      opts.subprocess ??
      new AcpSubprocess({
        spec,
        cwd: this.cwd,
        env: opts.agentEnv,
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
    const commands: SlashCommandInfo[] = this.subprocess.availableCommands.map((cmd) => ({
      name: cmd.name.startsWith('/') ? cmd.name.slice(1) : cmd.name,
      description: cmd.description ?? '',
      source: 'sdk' as const,
    }));

    return { commands };
  }

  override async onModelsList(_params: ModelsListParams): Promise<ModelsListResult> {
    return this.subprocess.modelsList();
  }

  override async onModelsSetCurrent(params: ModelsSetCurrentParams): Promise<ModelsSetCurrentResult> {
    return this.subprocess.setModel(params.model, this.lastShepawSessionId);
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

export { isAcpEngineId, listEngineIds, ACP_ENGINES } from './engines.js';
export type { AcpEngineId } from './engines.js';
