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
  SessionHistoryMessage,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionInfo,
  SessionsListParams,
  SessionsListResult,
  TaskContext,
} from 'shepaw-acp-sdk';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent, SessionStore, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { ResolvedShepawBridgeConfig } from './config.js';

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
  private readonly selection: ModelSelection | undefined;
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

    const defaultModel = ctx.get('agentDefaultModel') as
      | { currentSelection(): ModelSelection }
      | undefined;
    this.selection = defaultModel?.currentSelection();
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

  /** Create the DSH agent for a Shepaw session id, or reuse a live one. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const id = SessionId(sessionId);
    const live = this.agents.get(id);
    if (live !== undefined) return live;

    const sel =
      this.config.provider !== undefined && this.config.model !== undefined
        ? { provider: this.config.provider, model: this.config.model }
        : this.selection;

    const { agent } = await this.agents.create({
      sessionId: id,
      meta: { cwd: this.config.cwd },
      agentOptions: sel !== undefined ? { provider: sel.provider, model: sel.model } : {},
      setup:
        sel !== undefined
          ? (agentCtx) => {
              installModelSelection(agentCtx, { current: sel, assembled: undefined });
            }
          : undefined,
    });
    return agent;
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
