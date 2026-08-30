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
  type AgentCard,
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
  type ResumePromptSetParams,
  type ResumeRebuildParams,
  type ResumeSummarySetParams,
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
import { storeBackendConfigured } from './shepaw-cli-shim.js';
import { resolveStoreClient } from './shepaw-cli.js';
import { sha256Hex } from './store-tools.js';
import {
  buildFallbackResume,
  buildResumeForAgent,
  extractResumeCapabilities,
  extractResumeSummary,
  isResumeRebuildForced,
  loadAgentResume,
  loadAgentResumeMarkdown,
  mergeResumeWithPrevious,
  normalizeResumePrompt,
  persistAgentResume,
  preserveAiSummary,
  readResumeFromStore,
  renderResumeMarkdown,
  renderSummaryOnlyResumeMd,
  replaceResumeSummarySection,
  resolveResumePersistenceDir,
  resolveResumePrompt,
  resumePromptFingerprint,
  resumeStoreUri,
  writeResumeToStore,
  type AgentResume,
  type AgentResumeInput,
} from './workspace-resume.js';

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
  private readonly engineDisplayName: string;
  private readonly subprocess: AcpSubprocess;
  private readonly sessionStore: SessionStore;
  private readonly sessionHistoryCache = new SessionHistoryCache();

  /** Last active Shepaw session — used for model picker when no session in params. */
  private lastShepawSessionId: string | undefined;

  /** Workspace-grounded self-description, built in init() (fallback until then). */
  private resume: AgentResume;
  /** Live custom-resume-prompt override (agent.resume.promptSet); env is the
   * spawn-time fallback. undefined = no prompt in effect. */
  private resumePromptOverride: string | undefined;

  /** sha256 of the pouch resume.md at the gateway's own last write — lets the
   * per-turn adoption skip unchanged documents (external edit = different sha). */
  private lastResumeSha: string | undefined;

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
    this.engineDisplayName = spec.displayName;
    // Constructor-time fallback resume — pure, no I/O. Replaced in init().
    this.resume = buildFallbackResume(this.buildResumeInput());
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
    // Workspace resume: derive once, then reuse the persisted landing result.
    // Only a first run (no persisted resume), a forced rebuild env flag, or an
    // explicit agent.resume.rebuild RPC re-derives. Best-effort — a failure
    // must never take the gateway down, so we keep the constructor fallback.
    const persistDir = resolveResumePersistenceDir(process.env);
    const loaded =
      persistDir !== null && !isResumeRebuildForced(process.env)
        ? await loadAgentResume(persistDir, this.agentId)
        : null;
    if (loaded !== null) {
      this.resume = loaded;
      log('workspace resume loaded from %s (agent %s)', persistDir, this.agentId);
      // Ensure the pouch copy exists at the fixed location — covers a migrated
      // agent / cleared pouch without forcing a re-scan. Best-effort.
      if (storeBackendConfigured(process.env)) {
        try {
          const client = await resolveStoreClient(process.env, fetch);
          if (client !== undefined) {
            const uri = resumeStoreUri(client.device, this.agentId);
            const existing = await readResumeFromStore(client, uri);
            if (existing === null && persistDir !== null) {
              const localMd = await loadAgentResumeMarkdown(
                persistDir,
                this.agentId,
              );
              if (localMd !== null) {
                await writeResumeToStore(client, this.agentId, localMd);
                log(
                  'workspace resume mirrored to %s (agent %s)',
                  uri,
                  this.agentId,
                );
              }
            }
          }
        } catch (err) {
          log(
            'workspace resume store mirror failed: %s',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } else {
      try {
        await this.rebuildResume();
      } catch (err) {
        log(
          'workspace resume build failed: %s',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
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

    // Resume is NOT part of the conversation context — it lives in the pouch
    // and is read on demand.

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
      const pouchDeviceId = resolveStoreDeviceIdFromEnv(process.env);
      const pouchCard = buildStorePouchCard({
        deviceId: pouchDeviceId,
        workspaceUri: (process.env.SHEPAW_WORKSPACE_URI ?? '').trim() || undefined,
        resumeUri: pouchDeviceId ? resumeStoreUri(pouchDeviceId, this.agentId) : undefined,
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

    // Turn end: the agent may have rewritten its own resume.md in the pouch
    // this turn (`store write` on the card-advertised URI). Adopt unconditionally
    // — the sha256 guard inside makes an unchanged document cost one meta call,
    // and this removes the old keyword gate that missed silent self-edits.
    // The gateway's own resume writes record `lastResumeSha`, so its own
    // rebuilds are skipped here. Notify the app afterwards so it can pick up
    // the fresh bio (She's roster reads from the app DB, not the pouch).
    if (!isGroupTurn(groupContext)) {
      const adopted = await this.adoptExternalResumeEdits().catch(() => false);
      if (adopted) {
        void this.notifyResumeChanged();
      }
    }
  }

  /**
   * Push `agent.resume.changed` to all connected app clients so they re-pull
   * the resume (card bio / pouch resume.md) without waiting for a rebuild or
   * reconnect. Best-effort — failures are ignored.
   */
  private async notifyResumeChanged(): Promise<void> {
    try {
      await this.broadcastNotification('agent.resume.changed', {
        agent_id: this.agentId,
      });
    } catch {
      /* best-effort */
    }
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

  /** Agent card enriched with the workspace-grounded resume. */
  override getAgentCard(): AgentCard {
    return {
      ...super.getAgentCard(),
      description: this.resume.summary,
      capabilities: [...this.resume.capabilities],
      version: this.resume.version,
    };
  }

  /** Resume summary for the CLI banner / embedders. */
  get resumeSummary(): string {
    return this.resume.summary;
  }

  /** Narrow struct passed to workspace-resume (keeps the module decoupled). */
  private buildResumeInput(): AgentResumeInput {
    return {
      agentId: this.agentId,
      fingerprint: this.identity.fingerprint,
      engineId: this.engineId,
      engineDisplayName: this.engineDisplayName,
      agentName: this.name,
      cwd: this.cwd,
      resumePrompt: this.effectiveResumePrompt(),
    };
  }

  /**
   * The custom resume prompt currently in effect: a live override (set via
   * `agent.resume.promptSet`) wins, else the spawn-time env fallback.
   */
  private effectiveResumePrompt(): string | undefined {
    return normalizeResumePrompt(this.resumePromptOverride ?? resolveResumePrompt(process.env));
  }

  /**
   * Re-derive the workspace resume now (scan + merge + persist). Used by
   * init() on a first run / forced rebuild and by the `agent.resume.rebuild`
   * RPC. Auto sections are refreshed from a fresh scan; the previous document's
   * "自我补充 / Self Notes" section is preserved. The result lands in the pouch
   * store at the fixed location (`store://files/<device>/<agentId>/resume.md`)
   * when a backend is configured; local persistence stays as the fallback.
   * Best-effort — a store failure must never take the gateway down.
   */
  async rebuildResume(): Promise<AgentResume> {
    const input = this.buildResumeInput();
    const { resume, profile } = await buildResumeForAgent(input);
    this.resume = resume;
    const persistDir = resolveResumePersistenceDir(process.env);

    if (storeBackendConfigured(process.env)) {
      try {
        const client = await resolveStoreClient(process.env, fetch);
        if (client !== undefined) {
          const uri = resumeStoreUri(client.device, this.agentId);
          const previousMd =
            (await readResumeFromStore(client, uri)) ??
            (persistDir !== null
              ? await loadAgentResumeMarkdown(persistDir, this.agentId)
              : null);
          const md =
            previousMd !== null
              ? mergeResumeWithPrevious(input, profile, resume, previousMd)
              : renderResumeMarkdown(input, profile, resume);
          // An AI-polished Summary (stamped with the prompt hash) survives a
          // deterministic rebuild while the prompt stays the same — the
          // operator asked for that wording; capabilities still refresh.
          const finalMd =
            input.resumePrompt !== undefined && previousMd !== null
              ? replaceResumeSummarySection(
                  md,
                  preserveAiSummary(
                    previousMd,
                    resume.summary,
                    resumePromptFingerprint(input.resumePrompt),
                  ),
                )
              : md;
          await writeResumeToStore(client, this.agentId, finalMd);
          // Record the sha of our own write so per-turn adoption skips
          // documents the gateway itself just produced.
          this.lastResumeSha = await sha256Hex(new TextEncoder().encode(finalMd));
          log('workspace resume synced to %s (agent %s)', uri, this.agentId);
        }
      } catch (err) {
        log(
          'workspace resume store sync failed: %s',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (persistDir !== null) {
      await persistAgentResume(resume, { dir: persistDir, input, profile });
    }
    return resume;
  }

  /**
   * ACP `agent.resume.rebuild` — external trigger to re-derive the workspace
   * resume on a running gateway. An optional `prompt` param updates the
   * custom resume prompt before the rebuild so the hub can push config and
   * regenerate in one round trip. Returns the fresh card (description/bio
   * updated immediately for getCard consumers).
   */
  override async onResumeRebuild(params?: ResumeRebuildParams): Promise<AgentCard> {
    if (params?.prompt !== undefined) {
      this.resumePromptOverride = normalizeResumePrompt(params.prompt);
    }
    await this.rebuildResume();
    return this.getAgentCard();
  }

  /**
   * ACP `agent.resume.promptSet` — set or clear the custom resume prompt on a
   * running gateway without rebuilding. An empty/missing prompt clears the
   * override (falling back to the spawn-time env, if any). Returns the card
   * unchanged — the resume text itself is untouched until the next rebuild
   * or AI polish.
   */
  override async onResumePromptSet(params: ResumePromptSetParams): Promise<AgentCard> {
    this.resumePromptOverride = normalizeResumePrompt(params.prompt);
    return this.getAgentCard();
  }

  /**
   * ACP `agent.resume.summarySet` — write a new resume Summary directly,
   * bypassing any chat turn. This is the AI-polish write path: the hub lets
   * the agent *generate* the text in a chat turn, but the write itself lands
   * here via RPC so no Bash tool call (and therefore no permission approval)
   * is ever involved. The document in the pouch is patched in place — only
   * `## Summary` changes, gateway-derived sections and Self Notes stay — and
   * the live card adopts the text immediately.
   */
  override async onResumeSummarySet(params: ResumeSummarySetParams): Promise<AgentCard> {
    const summary = params.summary.trim();
    if (summary.length === 0) {
      throw new Error('summary must be a non-empty string');
    }
    if (!storeBackendConfigured(process.env)) {
      throw new Error('no store backend configured — cannot persist resume summary');
    }
    const client = await resolveStoreClient(process.env, fetch);
    if (client === undefined) {
      throw new Error('no store backend configured — cannot persist resume summary');
    }
    const uri = resumeStoreUri(client.device, this.agentId);
    const existing = await readResumeFromStore(client, uri);
    if (existing === null) {
      // No document yet — derive once so the Summary lands on top of the
      // gateway-generated sections instead of a bare stub.
      await this.rebuildResume();
    }
    const current = (await readResumeFromStore(client, uri)) ?? renderSummaryOnlyResumeMd('', summary);
    const md = replaceResumeSummarySection(current, summary);
    await writeResumeToStore(client, this.agentId, md);
    // Record our own write's sha so per-turn adoption skips it.
    this.lastResumeSha = await sha256Hex(new TextEncoder().encode(md));
    this.resume = { ...this.resume, summary };
    await this.notifyResumeChanged();
    return this.getAgentCard();
  }

  /**
   * Close the "edit my own resume via chat" loop: after the agent rewrites
   * resume.md in the pouch (`store write` on the card-advertised URI), pull
   * the document back and adopt its Summary / Capabilities into the live
   * card — no rebuild, no restart, the edit the user asked for wins verbatim.
   *
   * Cheap-guarded by the store's sha256 so an unchanged document costs one
   * meta call per chat turn. Best-effort: any failure is logged and ignored.
   * Returns true when a new document was actually adopted (callers use that
   * to decide whether to notify the app).
   */
  private async adoptExternalResumeEdits(): Promise<boolean> {
    if (!storeBackendConfigured(process.env)) return false;
    try {
      const client = await resolveStoreClient(process.env, fetch);
      if (client === undefined) return false;
      const uri = resumeStoreUri(client.device, this.agentId);
      const meta = await client.meta({ uri });
      if (!meta.ok) return false;
      const sha = (meta.data as { meta?: { sha256?: unknown } } | null | undefined)?.meta?.sha256;
      const shaHex = typeof sha === 'string' ? sha : undefined;
      if (shaHex !== undefined && shaHex === this.lastResumeSha) return false;

      const md = await readResumeFromStore(client, uri);
      if (md === null) return false;
      this.lastResumeSha = shaHex;
      const summary = extractResumeSummary(md);
      const capabilities = extractResumeCapabilities(md);
      if (summary === null && capabilities === null) return false;
      this.resume = {
        ...this.resume,
        ...(summary !== null ? { summary } : {}),
        ...(capabilities !== null ? { capabilities } : {}),
      };
      log(
        'external resume edit adopted from %s (summary=%s caps=%d)',
        uri,
        summary !== null,
        capabilities?.length ?? 0,
      );
      return true;
    } catch (err) {
      log(
        'external resume adoption failed: %s',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
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
