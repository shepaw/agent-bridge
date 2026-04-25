/**
 * Claude Code as a Shepaw ACP agent.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` and routes:
 *   - Assistant text blocks → `ui.textContent` (streaming)
 *   - Tool use blocks → a `ui.messageMetadata` header + a `ui.textContent` summary
 *   - `canUseTool` callback → `ui.actionConfirmation` (or `ui.form` for
 *     `AskUserQuestion`), then BLOCKS until the user replies on their
 *     phone; the reply arrives as a new `agent.chat` message and
 *     `onChat` calls `pendingConfirmations.resolveAll(verdict)`, which
 *     unblocks the in-flight SDK turn. See the comment at the top of
 *     `onChat` for the full decision matrix.
 *   - Captured `session_id` from `SDKSystemMessage` → SessionStore for resume
 *   - `agent.cancelTask` → AbortController.abort() propagates into
 *     canUseTool's wait() and resolves any pending as deny
 */

import {
  query,
  type Options,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ACPAgentServer,
  type ChannelTunnelConfig,
  type ChatKwargs,
  type TaskContext,
} from 'shepaw-acp-sdk';

import {
  ApprovalCache,
  type ApprovalCacheOptions,
} from './approval-cache.js';
import { classifyApprovalMessage } from './approval-keywords.js';
import { log } from './debug.js';
import { makeCanUseTool } from './permission.js';
import { PendingConfirmations } from './pending-confirmations.js';
import { SessionStore, type SessionStoreOptions } from './session-store.js';
import { summarizeToolInput } from './tool-summary.js';

/**
 * Signature subset of `@anthropic-ai/claude-agent-sdk`'s `query` that the
 * gateway actually consumes. Exposed as an option so tests and the
 * `--mock` CLI flag can swap in a scripted implementation without
 * needing `ANTHROPIC_API_KEY`.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => AsyncIterable<unknown>;

/**
 * Shepaw's form-submission messages start with this marker. Everything
 * after the prefix is a flat "<label>: <value>" blob; we forward it
 * verbatim as the `answers._raw` field on AskUserQuestion's
 * `updatedInput`.
 */
const FORM_SUBMISSION_PREFIX = 'Form submitted:';

export interface ClaudeCodeAgentOptions {
  /** Display name of this agent in the Shepaw card. Default 'Claude Code'. */
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
  /** Working directory for Claude Code. Default `process.cwd()`. */
  cwd?: string;
  /** Claude model id (e.g. 'claude-opus-4-7'). */
  model?: string;
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
  /**
   * When set, the gateway opens a reverse tunnel to the Shepaw Channel
   * Service so your phone can reach it from the public internet.
   */
  tunnelConfig?: ChannelTunnelConfig;
  /**
   * Override the `query()` implementation. Default: the real `query`
   * from `@anthropic-ai/claude-agent-sdk`. Used by tests and the
   * `--mock` CLI flag to exercise the full pipeline without calling
   * the Claude API.
   */
  queryFn?: QueryFn;
}

export class ClaudeCodeAgent extends ACPAgentServer {
  private readonly cfg: Required<
    Pick<ClaudeCodeAgentOptions, 'cwd' | 'permissionMode'>
  > &
    Pick<
      ClaudeCodeAgentOptions,
      'model' | 'maxTurns' | 'allowedTools' | 'systemPrompt'
    >;
  private readonly sessionStore: SessionStore;
  private readonly queryFn: QueryFn;
  private readonly approvalCache: ApprovalCache;
  private readonly pendingConfirmations = new PendingConfirmations();

  constructor(opts: ClaudeCodeAgentOptions = {}) {
    super({
      name: opts.name ?? 'Claude Code',
      peersPath: opts.peersPath,
      enrollmentsPath: opts.enrollmentsPath,
      description:
        'Bridge Claude Code to Shepaw — approve tool calls from your phone',
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
    };
    this.sessionStore = new SessionStore(opts.sessionStoreOptions);
    this.queryFn = opts.queryFn ?? (query as unknown as QueryFn);
    this.approvalCache = new ApprovalCache(opts.approvalCacheOptions);
  }

  async init(): Promise<void> {
    await this.sessionStore.load();
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
    //  pending?   message kind            action
    //  ─────────  ─────────────────────   ────────────────────────────────
    //  YES        verdict=allow           resolveAll(allow); return (no query)
    //  YES        verdict=deny            resolveAll(deny);  return (no query)
    //  YES        "Form submitted: …"     resolveAll(allow with raw text
    //                                     in updatedInput.answers); return
    //  YES        anything else           resolveAll(deny) to unblock the
    //                                     stale SDK turn, then open a new
    //                                     query() for the user's message.
    //  NO         verdict=allow/deny      fall through to new query()
    //                                     (the verdict got dropped, but
    //                                     that's fine — nothing to resolve)
    //  NO         anything else           open a new query() as usual
    //
    // The invariant we maintain is that at most one SDK turn is live
    // per session, so the pending tracker shouldn't hold entries from
    // a previous query() beyond the next user message.

    const abortController =
      this.activeTasks.get(ctx.taskId) ?? new AbortController();

    const hasPending = this.pendingConfirmations.size(ctx.sessionId) > 0;
    const isFormSubmission = message.trimStart().startsWith(FORM_SUBMISSION_PREFIX);
    const verdict = isFormSubmission ? undefined : classifyApprovalMessage(message);

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
          'resolved %d pending confirmation(s) as %s (session=%s); skipping new query',
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
          'denied %d stale pending confirmation(s) to unblock prior SDK turn (session=%s)',
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

    // canUseTool requires streaming input mode — wrap the prompt as an async iterable.
    const stream = this.queryFn({
      prompt: asyncUserPrompt(message),
      options,
    });

    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      if (abortController.signal.aborted) break;
      await this.handleSdkMessage(ctx, msg);
    }
  }

  private async handleSdkMessage(ctx: TaskContext, msg: SDKMessage): Promise<void> {
    if (msg.type === 'system') {
      const system = msg as SDKSystemMessage;
      if (system.subtype === 'init' && system.session_id) {
        this.sessionStore.set(ctx.sessionId, system.session_id);
      }
      return;
    }

    if (msg.type === 'assistant') {
      const assistant = msg as SDKAssistantMessage;
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
  } as never; // SDKUserMessage has additional optional fields; shape is permissive.
}
