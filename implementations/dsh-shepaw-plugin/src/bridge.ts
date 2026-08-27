/**
 * Shepaw ↔ DeepSeek Harness (DSH) bridge.
 *
 * Runs the Shepaw ACP v2.1 server (WebSocket + Noise, per-device pubkey
 * allowlist) inside a DSH process and routes each Shepaw `agent.chat` into a
 * DSH Agent via the `ctx.agents` registry. DSH's durable session event log is
 * streamed back to the Shepaw app as `ui.textContent` deltas.
 *
 * Every `@deepseek-ai/*` import is a peer dependency resolved from the host DSH
 * installation — the plugin must never bundle its own copy of cordis/dsh.
 */

import { ACPAgentServer, TaskCancelledError } from 'shepaw-acp-sdk';
import type {
  ChannelMailboxConfig,
  ModelInfo,
  ModelsListParams,
  ModelsListResult,
  ModelsSetCurrentParams,
  ModelsSetCurrentResult,
  ModeInfo,
  ModesListParams,
  ModesListResult,
  ModesSetCurrentParams,
  ModesSetCurrentResult,
  SessionHistoryMessage,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionInfo,
  SessionsListParams,
  SessionsListResult,
  TaskContext,
} from 'shepaw-acp-sdk';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentRegistry, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent, SessionStore, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { ResolvedShepawBridgeConfig } from './config.js';
import {
  decodeModelValue,
  displayNameForModel,
  encodeModelValue,
  resolveCatalogModelValue,
} from './model-wire.js';

/** Text deltas visible to the end user (skip reasoning deltas). */
function extractTextDelta(chunk: StreamChunk): string {
  return chunk.type === 'text-delta' ? chunk.text : '';
}

/** Join the plain-text blocks of a message's content. */
function messageText(content: readonly ContentBlock[]): string {
  let out = '';
  for (const block of content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

interface ActiveTurn {
  taskCtx: TaskContext;
  agent: Agent;
}

/** Minimal `ctx.llm` surface used for model listing and validation. */
interface LlmCatalog {
  listProviders(): ReadonlyArray<{ id: string; name: string }>;
  listModels(provider: string): Promise<
    ReadonlyArray<{ id: string; name: string; description?: string }>
  >;
  resolveCallConfig(config: {
    provider: string;
    model: string;
  }): Promise<{ provider: string; model: string }>;
}

/** Minimal `ctx.permissionPresets` surface for App session-mode switching. */
interface PermissionPresetService {
  readonly names: readonly string[];
  readonly defaultPreset: string;
  current(events: readonly SessionEvent[]): string;
  optionOf(name: string): { value: string; name: string; description?: string };
  set(session: Session, name: string): void;
}

interface AgentDefaultModelService {
  currentSelection(): ModelSelection;
  saveSelection?(selection: ModelSelection): void;
}

/** Minimal `ctx.sessionPersistence` surface for cross-restart session resume. */
interface SessionPersistenceService {
  list(signal?: AbortSignal): Promise<ReadonlyArray<{ id: string; cwd?: string }>>;
}

/**
 * Build the Channel Service mailbox config from the Hub's shared-channel env
 * (`PAW_ACP_MAILBOX_*`). The hub router owns the single device tunnel; each
 * instance drains the shared inbox over loopback, so the app's one peer
 * pairing reaches this DSH instance too. Standalone LAN use leaves it unset.
 */
function resolveMailboxConfig(): ChannelMailboxConfig | undefined {
  const serverUrl = process.env.PAW_ACP_MAILBOX_SERVER_URL;
  const channelId = process.env.PAW_ACP_MAILBOX_CHANNEL_ID;
  const secret = process.env.PAW_ACP_MAILBOX_SECRET;
  return serverUrl && channelId && secret ? { serverUrl, channelId, secret } : undefined;
}

export class DshShepawBridge extends ACPAgentServer {
  private readonly agents: AgentRegistry;
  private readonly sessions: SessionStore;
  private readonly config: ResolvedShepawBridgeConfig;
  private readonly deploymentDefaultSelection: ModelSelection | undefined;
  /** Live DSH agent id → mutable model route (runtime App picker). */
  private readonly modelSelections = new Map<string, ModelSelectionRef>();
  /** Shepaw session id → model wire value chosen before the agent exists. */
  private readonly pendingModelBySession = new Map<string, string>();
  /** Shepaw session id → permission preset chosen before the agent exists. */
  private readonly pendingModeBySession = new Map<string, string>();
  /** Last App model choice without a session id (applies to the next create). */
  private pendingModelGlobal: string | undefined;
  /** DSH agent id → the Shepaw turn currently driving it (approval routing). */
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(
    private readonly ctx: Context,
    config: ResolvedShepawBridgeConfig,
  ) {
    super({
      name: config.name,
      identityPath: config.identityPath,
      peersPath: config.peersPath,
      enrollmentsPath: config.enrollmentsPath,
      maxConcurrency: config.maxConcurrency,
      mailboxConfig: resolveMailboxConfig(),
    });
    this.config = config;

    const agents = ctx.get('agents');
    const sessions = ctx.get('sessions');
    if (agents === undefined || sessions === undefined) {
      throw new Error('shepaw-bridge: ctx.agents / ctx.sessions are unavailable (inject mismatch)');
    }
    this.agents = agents;
    this.sessions = sessions;

    this.deploymentDefaultSelection = this.defaultModelService()?.currentSelection();
  }

  /**
   * One Shepaw chat turn → one DSH turn. The server wraps this with
   * `started()` before and `sendTextFinal()` + `completed()` after it returns,
   * or `error()` when it throws.
   */
  override async onChat(taskCtx: TaskContext, message: string): Promise<void> {
    const agent = await this.ensureAgent(taskCtx.sessionId);
    await agent.whenIdle();

    // Map Shepaw cancellation → DSH agent.cancel({ kind: 'user' }).
    const signal = this.activeTasks.get(taskCtx.taskId)?.signal;
    const onAbort = () => agent.cancel({ kind: 'user' });
    signal?.addEventListener('abort', onAbort, { once: true });

    const session = agent.session;
    const firstSeq = session.seq;
    this.activeTurns.set(agent.id, { taskCtx, agent });

    try {
      const stream = this.streamTurn(session, firstSeq, taskCtx);
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: message }],
          source: { kind: 'user' },
        }),
      );
      const reason = await stream;
      await agent.whenIdle();
      await this.sessions.flush(session).catch(() => undefined);

      if (reason.kind === 'error') {
        const failure = reason.error as { message?: string } | undefined;
        throw new Error(failure?.message ?? 'DeepSeek Harness turn failed');
      }
      // aborted/completed/max-tokens/blocked fall through. An aborted turn is
      // reported by runChatTask's signal.aborted branch as "Task cancelled".
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeTurns.delete(agent.id);
    }
  }

  /** List models from every registered DSH LLM provider route. */
  override async onModelsList(params: ModelsListParams): Promise<ModelsListResult> {
    const models = await this.buildModelCatalog();
    const current = this.currentModelWireValue(params.session_id);
    return { models, ...(current !== undefined ? { current } : {}) };
  }

  /** Switch the model route for a live session (or stash for the next create). */
  override async onModelsSetCurrent(params: ModelsSetCurrentParams): Promise<ModelsSetCurrentResult> {
    const catalog = await this.buildModelCatalog();
    const resolved = resolveCatalogModelValue(params.model, catalog);
    if (resolved === undefined) {
      throw new Error(`Unknown model: ${params.model}`);
    }

    const route = decodeModelValue(resolved);
    if (route === undefined) {
      throw new Error(`Invalid model value: ${resolved}`);
    }

    const llm = this.llmCatalog();
    if (llm !== undefined) {
      await llm.resolveCallConfig(route);
    }

    const agent = this.agentForShepawSession(params.session_id);
    if (agent === undefined) {
      this.rememberPendingModel(params.session_id, resolved);
    } else {
      this.selectionFor(agent).current = route;
      this.saveDefaultModelSelection(route);
    }

    const row = catalog.find((m) => m.value === resolved);
    return {
      model: resolved,
      ...(row !== undefined ? { display_name: row.display_name } : {}),
    };
  }

  /** List DSH permission presets (`read-only`, `workspace-write`, …). */
  override async onModesList(params: ModesListParams): Promise<ModesListResult> {
    const modes = this.buildModeCatalog();
    if (modes.length === 0) return { modes: [] };

    const agent = this.agentForShepawSession(params.session_id);
    const current =
      agent !== undefined
        ? this.effectivePermissionPreset(agent)
        : (this.pendingModeBySession.get(params.session_id ?? '') ??
          this.spawnPermissionMode() ??
          'workspace-write');

    return {
      modes,
      ...(current !== undefined && modes.some((m) => m.value === current) ? { current } : {}),
    };
  }

  /** Switch sandbox / approval preset for a live DSH session. */
  override async onModesSetCurrent(params: ModesSetCurrentParams): Promise<ModesSetCurrentResult> {
    const presets = this.permissionPresets();
    if (presets === undefined) {
      throw new Error('Permission presets are unavailable in this DSH deployment');
    }
    if (!presets.names.includes(params.mode)) {
      throw new Error(
        `Unknown permission preset: ${params.mode}. Available: ${presets.names.join(', ')}`,
      );
    }

    const agent = this.agentForShepawSession(params.session_id);
    if (agent === undefined) {
      if (params.session_id !== undefined && params.session_id.length > 0) {
        this.pendingModeBySession.set(params.session_id, params.mode);
      }
    } else {
      presets.set(agent.session, params.mode);
    }

    const opt = presets.optionOf(params.mode);
    return { mode: params.mode, display_name: opt.name };
  }

  /**
   * Approval answerer for DSH's `approval/request` waterfall. Routes the
   * question to the Shepaw turn currently driving that agent; delegates to
   * `next()` (DSH's default/fail-closed chain) when there is no active turn.
   */
  async decideApproval(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const turn = this.activeTurns.get(req.agent.id);
    if (turn === undefined) return next();

    const cid = await turn.taskCtx.sendActionConfirmation({
      prompt: req.reason ?? `Approve tool \`${req.toolName}\`?`,
      actions: [
        { label: 'Allow once', value: 'allowed-once', style: 'primary' },
        { label: 'Reject', value: 'rejected', style: 'danger' },
      ],
    });

    try {
      const resp = await turn.taskCtx.waitForResponse(cid, { timeoutMs: 5 * 60_000 });
      const chosen =
        resp['selected_action_id'] ?? resp['value'] ?? resp['action'] ?? resp['selected'];
      return chosen === 'allowed-once' ? 'allowed-once' : 'rejected';
    } catch (err) {
      if (err instanceof TaskCancelledError) return 'cancelled';
      return 'unavailable';
    }
  }

  /** Mirror DSH's live sessions into the app's session list. */
  override async onSessionsList(_params: SessionsListParams): Promise<SessionsListResult> {
    const sessions: SessionInfo[] = this.agents.list().map((agent) => ({
      session_id: String(agent.id),
      cwd: agent.session.header.cwd,
    }));
    return { sessions };
  }

  /** Replay a session's durable transcript (human prompts + assistant text). */
  override async onSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const agent = this.agents.get(SessionId(params.session_id));
    if (agent === undefined) return { messages: [] };

    const messages: SessionHistoryMessage[] = [];
    for (const event of agent.session.events) {
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        const text = messageText(event.data.content);
        if (text.length > 0) messages.push({ role: 'user', content: text });
      } else if (event.type === 'assistant/message') {
        const text = messageText(event.data.message.content);
        if (text.length > 0) messages.push({ role: 'agent', content: text });
      }
    }
    return { messages };
  }

  /** Create or resume the DSH agent for a Shepaw session id, or reuse a live one. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const id = SessionId(sessionId);
    const live = this.agents.get(id);
    if (live !== undefined) return live;

    const initialSelection = this.resolveInitialSelection(sessionId);
    const agentOptions =
      initialSelection !== undefined
        ? { provider: initialSelection.provider, model: initialSelection.model }
        : {};
    const setup = (agentCtx: { agent?: Agent }) => {
      this.installSelection(agentCtx, initialSelection);
    };

    const persistence = this.sessionPersistence();
    const stored =
      persistence !== undefined
        ? (await persistence.list()).find((header) => header.id === id)
        : undefined;

    if (stored !== undefined) {
      if (stored.cwd !== undefined && stored.cwd !== this.config.cwd) {
        throw new Error(
          `session "${sessionId}" is persisted at cwd "${stored.cwd}" but this instance uses "${this.config.cwd}"`,
        );
      }
      const { agent } = await this.agents.resume({
        resumeSessionId: id,
        agentOptions,
        setup,
      });
      return agent;
    }

    const { agent } = await this.agents.create({
      sessionId: id,
      meta: { cwd: this.config.cwd },
      agentOptions,
      setup,
    });

    this.applyInitialPermissionMode(sessionId, agent);
    return agent;
  }

  private defaultModelService(): AgentDefaultModelService | undefined {
    return this.ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined;
  }

  private llmCatalog(): LlmCatalog | undefined {
    return this.ctx.get('llm') as LlmCatalog | undefined;
  }

  private permissionPresets(): PermissionPresetService | undefined {
    return this.ctx.get('permissionPresets') as PermissionPresetService | undefined;
  }

  private sessionPersistence(): SessionPersistenceService | undefined {
    return this.ctx.get('sessionPersistence') as SessionPersistenceService | undefined;
  }

  private spawnPermissionMode(): string | undefined {
    const raw = process.env.DSH_PERMISSION_MODE?.trim();
    return raw !== undefined && raw.length > 0 ? raw : undefined;
  }

  private resolveInitialSelection(sessionId: string): ModelSelection | undefined {
    const pending =
      this.pendingModelBySession.get(sessionId) ?? this.pendingModelGlobal ?? undefined;
    if (pending !== undefined) {
      const route = decodeModelValue(pending);
      if (route !== undefined) return route;
    }

    if (this.config.provider !== undefined && this.config.model !== undefined) {
      return { provider: this.config.provider, model: this.config.model };
    }

    return this.deploymentDefaultSelection ?? this.defaultModelService()?.currentSelection();
  }

  /**
   * Attach a mutable model route to one agent (same pattern as dsh-host-apiproxy).
   * Subsequent App `agent.models.setCurrent` updates `selection.current`.
   */
  private installSelection(
    agentCtx: { agent?: Agent },
    initial: ModelSelection | undefined,
  ): void {
    const agent = agentCtx.agent;
    if (agent === undefined) return;

    let picked: ModelSelection | undefined = initial;
    const selection: ModelSelectionRef = {
      get current() {
        if (picked !== undefined) return picked;
        const logged = agent.session.requestHeader()?.config;
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort !== undefined
              ? { reasoningEffort: logged.reasoningEffort }
              : {}),
          };
        }
        return undefined;
      },
      set current(next: ModelSelection | undefined) {
        picked = next;
      },
      assembled: undefined,
    };

    installModelSelection(agent.ctx, selection);
    this.modelSelections.set(String(agent.id), selection);
  }

  private selectionFor(agent: Agent): ModelSelectionRef {
    const existing = this.modelSelections.get(String(agent.id));
    if (existing !== undefined) return existing;

    this.installSelection({ agent }, undefined);
    return this.modelSelections.get(String(agent.id))!;
  }

  private saveDefaultModelSelection(selection: ModelSelection): void {
    try {
      this.defaultModelService()?.saveSelection?.(selection);
    } catch {
      // Best-effort — session switch must still succeed without settings persistence.
    }
  }

  private rememberPendingModel(sessionId: string | undefined, value: string): void {
    if (sessionId !== undefined && sessionId.length > 0) {
      this.pendingModelBySession.set(sessionId, value);
    } else {
      this.pendingModelGlobal = value;
    }
  }

  private agentForShepawSession(sessionId?: string): Agent | undefined {
    if (sessionId !== undefined && sessionId.length > 0) {
      return this.agents.get(SessionId(sessionId));
    }
    return this.agents.list()[0];
  }

  private async buildModelCatalog(): Promise<ModelInfo[]> {
    const llm = this.llmCatalog();
    if (llm === undefined) return [];

    const models: ModelInfo[] = [];
    for (const provider of llm.listProviders()) {
      try {
        const listed = await llm.listModels(provider.id);
        for (const model of listed) {
          models.push({
            value: encodeModelValue(provider.id, model.id),
            display_name: displayNameForModel(provider.id, model.name, provider.name),
            description: model.description ?? '',
          });
        }
      } catch {
        // One failed provider must not hide the rest of the catalog.
      }
    }
    return models;
  }

  private currentModelWireValue(sessionId?: string): string | undefined {
    const agent = this.agentForShepawSession(sessionId);
    if (agent !== undefined) {
      const current = this.selectionFor(agent).current;
      if (current !== undefined) return encodeModelValue(current.provider, current.model);
    }

    const pending =
      (sessionId !== undefined ? this.pendingModelBySession.get(sessionId) : undefined) ??
      this.pendingModelGlobal;
    if (pending !== undefined) return pending;

    const fallback = this.resolveInitialSelection(sessionId ?? '');
    return fallback !== undefined
      ? encodeModelValue(fallback.provider, fallback.model)
      : undefined;
  }

  private buildModeCatalog(): ModeInfo[] {
    const presets = this.permissionPresets();
    if (presets === undefined) return [];

    return presets.names.map((name) => {
      const opt = presets.optionOf(name);
      return {
        value: opt.value,
        display_name: opt.name,
        description: opt.description ?? '',
      };
    });
  }

  private effectivePermissionPreset(agent: Agent): string | undefined {
    const presets = this.permissionPresets();
    if (presets === undefined) return this.spawnPermissionMode();

    const current = presets.current(agent.session.events);
    return current === 'custom' ? undefined : current;
  }

  private applyInitialPermissionMode(sessionId: string, agent: Agent): void {
    const presets = this.permissionPresets();
    if (presets === undefined) return;

    const mode =
      this.pendingModeBySession.get(sessionId) ??
      this.spawnPermissionMode() ??
      presets.defaultPreset;
    if (!presets.names.includes(mode)) return;

    presets.set(agent.session, mode);
  }

  /**
   * Stream one DSH turn back to Shepaw. Subscribes to the session event log,
   * forwards `assistant/chunk` text deltas, and resolves with the `turn/end`
   * reason once the turn started after `firstSeq` closes.
   */
  private streamTurn(
    session: Session,
    firstSeq: number,
    taskCtx: TaskContext,
  ): Promise<TurnEndReason> {
    return new Promise<TurnEndReason>((resolve) => {
      const off = this.ctx.on('session/event', (sess: Session, event: SessionEvent) => {
        if (sess !== session || event.seq < firstSeq) return;
        if (event.type === 'assistant/chunk') {
          const delta = extractTextDelta(event.data.chunk);
          if (delta.length > 0) void taskCtx.sendText(delta).catch(() => undefined);
        } else if (event.type === 'turn/end') {
          off();
          resolve(event.data.reason);
        }
      });
    });
  }
}
