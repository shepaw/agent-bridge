/**
 * Claude Code as a Shepaw ACP agent.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` and routes:
 *   - Assistant text blocks → `ui.textContent` (streaming)
 *   - Tool use blocks → a `ui.messageMetadata` header + a `ui.textContent` summary
 *   - `canUseTool` callback → `ui.actionConfirmation` (or `ui.singleSelect`
 *     for `AskUserQuestion`); reply collected via `agent.submitResponse`
 *   - Captured `session_id` from `SDKSystemMessage` → SessionStore for resume
 *   - `agent.cancelTask` → AbortController.abort() on the active query
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

import { log } from './debug.js';
import { makeCanUseTool, type MakeCanUseToolOptions } from './permission.js';
import { SessionStore, type SessionStoreOptions } from './session-store.js';
import { summarizeToolInput } from './tool-summary.js';

export interface ClaudeCodeAgentOptions {
  /** Display name of this agent in the Shepaw card. Default 'Claude Code'. */
  name?: string;
  /** Auth token required by the Shepaw app. Empty string disables auth. Default ''. */
  token?: string;
  /** Agent id. Auto-generated if not provided. */
  agentId?: string;
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
  /** Per-tool approval & question timeouts. See MakeCanUseToolOptions. */
  permissionOptions?: MakeCanUseToolOptions;
  /** Override session-store persistence path. */
  sessionStoreOptions?: SessionStoreOptions;
  /**
   * When set, the gateway opens a reverse tunnel to the Shepaw Channel
   * Service so your phone can reach it from the public internet.
   */
  tunnelConfig?: ChannelTunnelConfig;
}

export class ClaudeCodeAgent extends ACPAgentServer {
  private readonly cfg: Required<
    Pick<ClaudeCodeAgentOptions, 'cwd' | 'permissionMode'>
  > &
    Pick<
      ClaudeCodeAgentOptions,
      'model' | 'maxTurns' | 'allowedTools' | 'systemPrompt' | 'permissionOptions'
    >;
  private readonly sessionStore: SessionStore;

  constructor(opts: ClaudeCodeAgentOptions = {}) {
    super({
      name: opts.name ?? 'Claude Code',
      token: opts.token ?? '',
      agentId: opts.agentId,
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
      permissionOptions: opts.permissionOptions,
    };
    this.sessionStore = new SessionStore(opts.sessionStoreOptions);
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

    const resumeId = this.sessionStore.get(ctx.sessionId);
    if (resumeId) log.gateway('resume sdk session %s for shepaw session %s', resumeId, ctx.sessionId);

    const systemPrompt = this.cfg.systemPrompt ? this.cfg.systemPrompt : undefined;

    const options: Options = {
      cwd: this.cfg.cwd,
      abortController,
      canUseTool: makeCanUseTool(ctx, this.cfg.permissionOptions),
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
    const stream = query({
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
