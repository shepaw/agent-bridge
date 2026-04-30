/**
 * CodeBuddy Code as a Shepaw ACP agent.
 *
 * Wraps `@tencent-ai/agent-sdk`'s `query()` and routes:
 *   - Assistant text blocks → `ui.textContent` (streaming)
 *   - Tool use blocks → a `ui.messageMetadata` header + a `ui.textContent` summary
 *   - `canUseTool` callback → async-confirmation flow:
 *       1. On cache miss, `canUseTool` fires `ui.actionConfirmation`,
 *          records a `PendingMarker` (persisted to disk), and returns
 *          `deny` immediately so the SDK turn ends naturally.
 *       2. The Shepaw app closes / user walks away — no open state to hold.
 *       3. When the user taps Allow/Deny later, a new `agent.chat` arrives.
 *          `onChat` sees the pending marker, populates `ApprovalCache`
 *          with the verdict, and re-runs `query()` with `--resume`.
 *       4. On the resume turn, `canUseTool` hits the cache and returns
 *          immediately — the tool actually executes.
 *   - `AskUserQuestion` → fire `ui.form` and AWAIT the user's form
 *     submission (still blocking; async version is a follow-up).
 *   - Captured `session_id` from `SystemMessage` → SessionStore for resume.
 *   - `agent.cancelTask` → AbortController.abort() propagates into
 *     canUseTool and clears any pending marker.
 */

import {
  query,
  type Options,
  type Message,
  type SystemMessage,
  type AssistantMessage,
} from '@tencent-ai/agent-sdk';
import {
  ACPAgentServer,
  ApprovalCache,
  type ApprovalCacheOptions,
  classifyApprovalMessage,
  FormAnswerStage,
  makeCanUseTool,
  PatternRuleStore,
  type PatternRuleStoreOptions,
  PendingConfirmations,
  PendingMarkerStore,
  type PendingMarkerOptions,
  resolvePendingApproval,
  SessionStore,
  type SessionStoreOptions,
  summarizeToolInput,
  type ChannelTunnelConfig,
  type ChatKwargs,
  type TaskContext,
} from 'shepaw-acp-sdk';

import { log } from './debug.js';

/** Gateway directory name — keeps our on-disk state isolated from the Claude bridge. */
const GATEWAY_DIR_NAME = 'shepaw-cb-gateway';
const AGENT_DISPLAY_NAME = 'CodeBuddy';

/**
 * Signature subset of `@tencent-ai/agent-sdk`'s `query` that the
 * gateway actually consumes. Exposed as an option so tests and the
 * `--mock` CLI flag can swap in a scripted implementation without
 * needing a real CodeBuddy API key.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => AsyncIterable<unknown>;

/**
 * Shepaw's form-submission messages start with this marker, regardless
 * of locale. Everything after the prefix is a flat "<label>: <value>"
 * blob; we forward it verbatim as the `answers._raw` field on
 * AskUserQuestion's `updatedInput`.
 */
const FORM_SUBMISSION_PREFIX = 'Form submitted:';

export interface CodeBuddyCodeAgentOptions {
  /** Display name of this agent in the Shepaw card. Default 'CodeBuddy Code'. */
  name?: string;
  /**
   * Override the authorized-peers allowlist path. Defaults to the SDK
   * resolution order (`SHEPAW_PEERS_PATH` env var, XDG, or `~/.config/`).
   */
  peersPath?: string;
  /**
   * Override the enrollments (pairing-code) store path. Defaults to the SDK
   * resolution order (`SHEPAW_ENROLLMENTS_PATH` env var, XDG, or `~/.config/`).
   * The file is auto-created as empty; tokens are minted via the `enroll`
   * CLI subcommand and consumed on first handshake.
   */
  enrollmentsPath?: string;
  /** Working directory for CodeBuddy Code. Default `process.cwd()`. */
  cwd?: string;
  /** CodeBuddy model id (e.g. 'deepseek-v3.1'). */
  model?: string;
  /**
   * Auth environment passed to the SDK. The `ck_…` API keys issued by
   * the China-facing console require `'internal'`; the default
   * `'external'` will reject them with a 401 from
   * `https://copilot.tencent.com`. Falls back to the
   * `CODEBUDDY_INTERNET_ENVIRONMENT` env var if unset.
   */
  environment?: Options['environment'];
  /** Custom endpoint URL (overrides `environment`). */
  endpoint?: string;
  /** Cap on agentic turns per chat. */
  maxTurns?: number;
  /** Optional allowlist of tool names. Empty → all tools allowed (with approval). */
  allowedTools?: string[];
  /**
   * Permission mode passed to the Agent SDK. Default 'default', which means
   * the SDK will call our `canUseTool` for every tool that isn't auto-approved.
   */
  permissionMode?: Options['permissionMode'];
  /** Extra system prompt prepended to the default. */
  systemPrompt?: string;
  /** Tuning for the approval cache (how long a granted approval stays valid). */
  approvalCacheOptions?: ApprovalCacheOptions;
  /** Override session-store persistence path. */
  sessionStoreOptions?: SessionStoreOptions;
  /** Override pending-marker persistence path (async-confirmation state). */
  pendingMarkerOptions?: PendingMarkerOptions;
  /**
   * Override the "Allow All Similar" pattern-rule store paths. When
   * unset we derive both session-rules and global-rules paths from
   * `GATEWAY_DIR_NAME`.
   */
  patternRuleStoreOptions?: PatternRuleStoreOptions;
  /**
   * When set, the gateway opens a reverse tunnel to the Shepaw Channel
   * Service so your phone can reach it from the public internet.
   */
  tunnelConfig?: ChannelTunnelConfig;
  /**
   * Override the `query()` implementation. Default: the real `query`
   * from `@tencent-ai/agent-sdk`. Used by tests and the `--mock` CLI
   * flag to exercise the full pipeline without calling the CodeBuddy API.
   */
  queryFn?: QueryFn;
}

export class CodeBuddyCodeAgent extends ACPAgentServer {
  private readonly cfg: Required<
    Pick<CodeBuddyCodeAgentOptions, 'cwd' | 'permissionMode'>
  > &
    Pick<
      CodeBuddyCodeAgentOptions,
      'model' | 'maxTurns' | 'allowedTools' | 'systemPrompt' | 'environment' | 'endpoint'
    >;
  private readonly sessionStore: SessionStore;
  private readonly queryFn: QueryFn;
  private readonly approvalCache: ApprovalCache;
  private readonly pendingConfirmations = new PendingConfirmations();
  private readonly pendingMarkerStore: PendingMarkerStore;
  private readonly patternRuleStore: PatternRuleStore;
  /**
   * Single-shot staging for AskUserQuestion form answers. When the user
   * submits a form, `onChat` writes the answers here; on the next
   * `--resume` turn, `canUseTool` for AskUserQuestion consumes and returns
   * them as `updatedInput` so the SDK sees the tool "successfully executed".
   */
  private readonly formAnswers = new FormAnswerStage();

  constructor(opts: CodeBuddyCodeAgentOptions = {}) {
    super({
      name: opts.name ?? 'CodeBuddy Code',
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      description:
        'Bridge CodeBuddy Code to Shepaw — approve tool calls from your phone',
      systemPrompt: opts.systemPrompt ?? '',
      tunnelConfig: opts.tunnelConfig,
    });
    this.cfg = {
      cwd: opts.cwd ?? process.cwd(),
      permissionMode: opts.permissionMode ?? 'default',
      model: opts.model,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
      environment:
        opts.environment ??
        (process.env.CODEBUDDY_INTERNET_ENVIRONMENT as Options['environment'] | undefined),
      endpoint: opts.endpoint,
    };
    this.sessionStore = new SessionStore(opts.sessionStoreOptions ?? { gatewayDirName: GATEWAY_DIR_NAME });
    this.queryFn = opts.queryFn ?? (query as unknown as QueryFn);
    this.approvalCache = new ApprovalCache(opts.approvalCacheOptions);
    this.pendingMarkerStore = new PendingMarkerStore(
      opts.pendingMarkerOptions ?? { gatewayDirName: GATEWAY_DIR_NAME },
    );
    this.patternRuleStore = new PatternRuleStore(
      opts.patternRuleStoreOptions ?? { gatewayDirName: GATEWAY_DIR_NAME },
    );
  }

  async init(): Promise<void> {
    await this.sessionStore.load();
    await this.pendingMarkerStore.load();
    await this.patternRuleStore.load();
  }

  override getAgentCard() {
    return {
      agent_id: this.agentId,
      name: this.name,
      description: this.description,
      version: '0.1.0',
      capabilities: [
        'chat',
        'streaming',
        'code_editing',
        'file_operations',
        'bash_execution',
        'interactive_messages',
        // Signals to the Shepaw app that this agent supports the
        // async-confirmation flow (deny-and-resume) rather than the
        // legacy blocking model. Older agents lacking this capability
        // force the app back onto `taskCompleter`-based awaiting.
        'async_confirmation',
      ],
      supported_protocols: ['acp'],
    };
  }

  override async onChat(
    ctx: TaskContext,
    message: string,
    _kwargs: ChatKwargs,
  ): Promise<void> {
    // Decision matrix when a new agent.chat message arrives:
    //
    //  pending?                     message kind            action
    //  ───────────────────────────  ─────────────────────   ─────────────────────────────
    //  MARKER(tool_use)             verdict=allow           cache(allow), drop marker,
    //                                                       --resume with synthetic
    //                                                       "retry it" prompt
    //  MARKER(tool_use)             verdict=deny            cache(deny), drop marker,
    //                                                       --resume with synthetic
    //                                                       "don't retry" prompt
    //  MARKER(AskUserQuestion)      "Form submitted: …"     stage answers, drop marker,
    //                                                       --resume with synthetic
    //                                                       "user answered" prompt
    //  MARKER(AskUserQuestion)      verdict=allow           treat as empty form submission
    //                                                       (user typed "allow" — we have
    //                                                       no answers to stage, so drop
    //                                                       the marker and fall through)
    //  MARKER(AskUserQuestion)      verdict=deny            drop marker, --resume with
    //                                                       "user declined to answer"
    //  MARKER(*)                    anything else           leave marker; treat as a
    //                                                       fresh user message
    //  NONE                         anything                open a new query() as usual
    //
    // Invariant: at most one MARKER per session. The legacy
    // `pendingConfirmations` in-flight tracker is no longer used by
    // production flows — kept only as a safety net in case a tool still
    // holds a blocking wait somewhere.

    const abortController =
      this.activeTasks.get(ctx.taskId) ?? new AbortController();

    const isFormSubmission = message.trimStart().startsWith(FORM_SUBMISSION_PREFIX);
    // `classifyApprovalMessage` returns `{verdict, scope}`. Scope
    // decides between one-shot cache ('once') and pattern-rule
    // ('pattern') writes inside `resolvePendingApproval`; `verdict` is
    // also needed below for the legacy blocking-fallback branch.
    const classification = isFormSubmission ? undefined : classifyApprovalMessage(message);
    const verdict = classification?.verdict;

    // ── async-confirmation path: pendingMarker + verdict/form submission ──
    // Delegated to the SDK so both agent implementations share a single
    // decision matrix and a single logging format. The call is a no-op
    // when there's no pending marker for this session.
    const { promptMessage } = resolvePendingApproval({
      sessionId: ctx.sessionId,
      message,
      isFormSubmission,
      formSubmissionPrefix: FORM_SUBMISSION_PREFIX,
      classification,
      approvalCache: this.approvalCache,
      pendingMarker: this.pendingMarkerStore,
      patternRules: this.patternRuleStore,
      formAnswers: this.formAnswers,
    });

    // ── legacy AskUserQuestion blocking path (unchanged) ──
    const hasPending = this.pendingConfirmations.size(ctx.sessionId) > 0;
    if (hasPending) {
      if (verdict === 'allow' || verdict === 'deny') {
        const resolved = this.pendingConfirmations.resolveAll(ctx.sessionId, verdict);
        for (const p of resolved) {
          this.approvalCache.set(
            ctx.sessionId,
            p.toolName,
            p.input,
            verdict,
            p.displayPrompt,
            message,
          );
        }
        log.gateway(
          'resolved %d pending form confirmation(s) as %s (session=%s); skipping new query',
          resolved.length,
          verdict,
          ctx.sessionId,
        );
        return;
      }

      if (isFormSubmission) {
        const resolved = this.pendingConfirmations.resolveAllWith(
          ctx.sessionId,
          (p) => ({
            behavior: 'allow',
            updatedInput: {
              ...p.input,
              answers: { _raw: message.slice(FORM_SUBMISSION_PREFIX.length).trim() },
            },
          }),
        );
        log.gateway(
          'resolved %d pending form submission(s) (session=%s); skipping new query',
          resolved,
          ctx.sessionId,
        );
        return;
      }

      const stale = this.pendingConfirmations.resolveAll(ctx.sessionId, 'deny');
      if (stale.length > 0) {
        log.gateway(
          'denied %d stale pending form confirmation(s) to unblock prior SDK turn (session=%s)',
          stale.length,
          ctx.sessionId,
        );
      }
    }

    const resumeId = this.sessionStore.get(ctx.sessionId);
    if (resumeId) log.gateway('resume sdk session %s for shepaw session %s', resumeId, ctx.sessionId);

    const systemPrompt = this.cfg.systemPrompt ? this.cfg.systemPrompt : undefined;

    const options: Options = {
      cwd: this.cfg.cwd,
      abortController,
      canUseTool: makeCanUseTool(ctx, {
        sessionId: ctx.sessionId,
        cache: this.approvalCache,
        pending: this.pendingConfirmations,
        pendingMarker: this.pendingMarkerStore,
        patternRules: this.patternRuleStore,
        formAnswers: this.formAnswers,
        agentDisplayName: AGENT_DISPLAY_NAME,
      }),
      permissionMode: this.cfg.permissionMode,
    };
    if (this.cfg.model !== undefined) options.model = this.cfg.model;
    if (this.cfg.maxTurns !== undefined) options.maxTurns = this.cfg.maxTurns;
    if (this.cfg.allowedTools && this.cfg.allowedTools.length > 0) {
      options.allowedTools = this.cfg.allowedTools;
    }
    if (resumeId !== undefined) options.resume = resumeId;
    if (systemPrompt !== undefined) options.systemPrompt = systemPrompt;
    if (this.cfg.environment !== undefined) options.environment = this.cfg.environment;
    if (this.cfg.endpoint !== undefined) options.endpoint = this.cfg.endpoint;

    // canUseTool requires streaming input mode — wrap the prompt as an async iterable.
    const stream = this.queryFn({
      prompt: asyncUserPrompt(promptMessage),
      options,
    });

    for await (const msg of stream as AsyncIterable<Message>) {
      if (abortController.signal.aborted) break;
      await this.handleSdkMessage(ctx, msg);
    }
  }

  private async handleSdkMessage(ctx: TaskContext, msg: Message): Promise<void> {
    if (msg.type === 'system') {
      const system = msg as SystemMessage;
      if (system.subtype === 'init' && system.session_id) {
        this.sessionStore.set(ctx.sessionId, system.session_id);
      }
      return;
    }

    if (msg.type === 'assistant') {
      const assistant = msg as AssistantMessage;
      const content = assistant.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const b = block as { type: string; text?: string; name?: string; input?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          await ctx.sendText(b.text);
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const toolName = b.name;
          const input = (b.input ?? {}) as Record<string, unknown>;
          const summary = summarizeToolInput(toolName, input);
          await ctx.sendMessageMetadata({
            collapsible: true,
            collapsibleTitle: `Tool: ${toolName}`,
            autoCollapse: true,
          });
          await ctx.sendText(`\n\`${toolName}\`: ${summary}\n`);
        }
      }
      return;
    }

    if (msg.type === 'result') {
      const result = msg as { type: 'result'; subtype: string; num_turns?: number; total_cost_usd?: number; duration_ms?: number };
      log.gateway(
        'result subtype=%s turns=%s cost=%s duration=%sms',
        result.subtype,
        result.num_turns ?? 0,
        result.total_cost_usd ?? 0,
        result.duration_ms ?? 0,
      );
      return;
    }

    // Everything else (stream events, hook callbacks, etc.) is ignored for v0.
  }
}

async function* asyncUserPrompt(message: string) {
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: message,
    },
    parent_tool_use_id: null,
    session_id: '',
  } as never; // UserMessage has additional optional fields; shape is permissive.
}
