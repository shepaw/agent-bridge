/**
 * CodeBuddy Code as a Shepaw ACP agent.
 *
 * Wraps `@tencent-ai/agent-sdk`'s `query()` and routes:
 *   - Assistant text blocks → `ui.textContent` (streaming)
 *   - Tool use blocks → a `ui.messageMetadata` header + a `ui.textContent` summary
 *   - `canUseTool` callback → `ui.actionConfirmation` (or `ui.form`
 *     for `AskUserQuestion`); reply collected via `agent.submitResponse`
 *   - Captured `session_id` from `SystemMessage` → SessionStore for resume
 *   - `agent.cancelTask` → AbortController.abort() on the active query
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
  type ChannelTunnelConfig,
  type ChatKwargs,
  type TaskContext,
} from 'shepaw-acp-sdk';

import {
  ApprovalCache,
  type ApprovalCacheOptions,
  PendingApprovals,
} from './approval-cache.js';
import { classifyApprovalMessage } from './approval-keywords.js';
import { log } from './debug.js';
import { makeCanUseTool } from './permission.js';
import { SessionStore, type SessionStoreOptions } from './session-store.js';
import { summarizeToolInput } from './tool-summary.js';

/**
 * Signature subset of `@tencent-ai/agent-sdk`'s `query` that the
 * gateway actually consumes. Exposed as an option so tests and the
 * `--mock` CLI flag can swap in a scripted implementation without
 * needing a real CodeBuddy API key.
 *
 * The iterable yields `unknown` rather than `Message` so scripted
 * fakes can produce the small subset of fields the gateway reads
 * (`type`, `subtype`, `message.content`, `session_id`) without
 * satisfying the full schema.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => AsyncIterable<unknown>;

export interface CodeBuddyCodeAgentOptions {
  /** Display name of this agent in the Shepaw card. Default 'CodeBuddy Code'. */
  name?: string;
  /** Auth token required by the Shepaw app. Empty string disables auth. Default ''. */
  token?: string;
  /** Agent id. Auto-generated if not provided. */
  agentId?: string;
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
  private readonly pendingApprovals = new PendingApprovals();

  constructor(opts: CodeBuddyCodeAgentOptions = {}) {
    super({
      name: opts.name ?? 'CodeBuddy Code',
      token: opts.token ?? '',
      agentId: opts.agentId,
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
    // Re-use the same AbortController the base class created for this task so
    // that `agent.cancelTask` → `abortController.abort()` stops the SDK query.
    // `ACPAgentServer` exposes it via the `activeTasks` map (protected).
    const abortController = this.activeTasks.get(ctx.taskId) ?? new AbortController();

    // If this message looks like an approval/deny reply, apply the verdict
    // to EVERY pending confirmation in this session — not just the most
    // recent one. A single CodeBuddy turn can fire multiple tool_use
    // blocks (e.g. three `git diff` variants), and we'd rather not make
    // the user tap Allow N times for what they meant as one decision.
    // The upcoming SDK turn's `canUseTool` lookups then all hit the
    // cache and proceed without re-prompting.
    const verdict = classifyApprovalMessage(message);
    if (verdict !== undefined) {
      const pendings = this.pendingApprovals.popAll(ctx.sessionId);
      for (const pending of pendings) {
        this.approvalCache.set(
          ctx.sessionId,
          pending.toolName,
          pending.input,
          verdict,
          pending.displayPrompt,
          message,
        );
      }
      if (pendings.length > 0) {
        log.gateway(
          'recorded %s verdict for %d pending approval(s) (session=%s)',
          verdict,
          pendings.length,
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
        pending: this.pendingApprovals,
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
      prompt: asyncUserPrompt(message),
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
