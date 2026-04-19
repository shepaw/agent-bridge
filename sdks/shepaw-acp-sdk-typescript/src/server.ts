/**
 * ACP Agent Server base class.
 *
 * Wire-compatible with `shepaw_acp_sdk.server.ACPAgentServer`. Subclasses
 * override `onChat()` to implement agent logic. Everything else — WebSocket
 * routing, authentication, heartbeat, task lifecycle, conversation history,
 * hub request tracking — is handled automatically.
 *
 * Minimal example:
 * ```ts
 * class EchoAgent extends ACPAgentServer {
 *   async onChat(ctx: TaskContext, message: string) {
 *     await ctx.sendText(`You said: ${message}`);
 *   }
 * }
 *
 * await new EchoAgent({ name: 'Echo', token: 'secret' }).run({ port: 8080 });
 * ```
 */

import { createServer as createHttpServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

import { ConversationManager } from './conversation.js';
import { jsonrpcNotification, jsonrpcResponse } from './jsonrpc.js';
import {
  createDeferred,
  Deferred,
  TaskContext,
  wsSend,
} from './task-context.js';
import type { ChannelTunnelConfig } from './tunnel.js';
import { TunnelClient } from './tunnel.js';
import type {
  AgentCard,
  ChatKwargs,
  ConversationMessage,
  JsonRpcErrorObject,
  JsonRpcResponse,
} from './types.js';
import { DEFAULT_CAPABILITIES, DEFAULT_PROTOCOLS } from './types.js';

/** Thrown internally when a task is cancelled via `agent.cancelTask`. */
export class TaskCancelledError extends Error {
  override readonly name = 'TaskCancelledError';
  constructor() {
    super('Task cancelled');
  }
}

// ── public types ────────────────────────────────────────────────────

export interface ACPAgentServerOptions {
  name?: string;
  /** Auth token. Empty string means no auth required. */
  token?: string;
  agentId?: string;
  description?: string;
  systemPrompt?: string;
  /** Max conversation turns kept per session. Default 20. */
  maxHistory?: number;
  /**
   * When true, `<<<directive>>>` blocks in saved assistant replies are replaced
   * with human-readable summaries. Default true.
   */
  cleanDirectivesInHistory?: boolean;
  /**
   * Optional Channel Service tunnel. When provided, `run()` additionally
   * establishes a reverse-tunnel to the Channel Service so the agent is
   * reachable from the public internet. Can also be set via `runWithTunnel`.
   */
  tunnelConfig?: ChannelTunnelConfig;
}

export interface RunOptions {
  host?: string;
  port?: number;
}

// ── directive cleanup for history ───────────────────────────────────

const ACP_DIRECTIVE_BLOCK_RE = /<<<directive\s*\n([\s\S]*?)\n>>>/g;

function cleanReplyForHistory(fullReply: string): string {
  return fullReply.replace(ACP_DIRECTIVE_BLOCK_RE, (match, body: string) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(body).trim()) as Record<string, unknown>;
    } catch {
      return match;
    }

    const dtype = typeof payload.type === 'string' ? payload.type : 'unknown';
    const parts: string[] = [];

    for (const key of ['prompt', 'title', 'reason'] as const) {
      const val = payload[key];
      if (typeof val === 'string' && val.length > 0) {
        parts.push(val);
        break;
      }
    }

    for (const key of ['actions', 'options', 'fields'] as const) {
      const items = payload[key];
      if (Array.isArray(items) && items.length > 0) {
        const labels = items
          .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
          .map((i) => (typeof i.label === 'string' ? i.label : '?'));
        if (labels.length > 0) {
          parts.push(labels.join(', '));
        }
        break;
      }
    }

    const filename = payload.filename;
    if (typeof filename === 'string') parts.push(filename);

    const detail = parts.length > 0 ? ': ' + parts.join(' | ') : '';
    return `[Directive ${dtype}${detail}]`;
  });
}

// ── ACPAgentServer ──────────────────────────────────────────────────

export class ACPAgentServer {
  readonly name: string;
  readonly token: string;
  readonly agentId: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly cleanDirectivesInHistory: boolean;
  readonly convMgr: ConversationManager;

  private httpServer: HttpServer | undefined;
  private wsServer: WebSocketServer | undefined;
  private tunnelConfig: ChannelTunnelConfig | undefined;
  private tunnelClient: TunnelClient | undefined;
  /** shepaw session_id → AbortController for the running task (one per session). */
  protected readonly activeTasks = new Map<string, AbortController>();
  private readonly pendingHubRequests = new Map<string, Deferred<unknown>>();
  private readonly pendingResponses = new Map<string, Deferred<Record<string, unknown>>>();

  constructor(opts: ACPAgentServerOptions = {}) {
    this.name = opts.name ?? 'ACP Agent';
    this.token = opts.token ?? '';
    this.agentId = opts.agentId ?? `acp_agent_${randomUUID().slice(0, 8)}`;
    this.description = opts.description ?? `ACP Agent: ${this.name}`;
    this.systemPrompt = opts.systemPrompt ?? 'You are a helpful AI assistant.';
    this.cleanDirectivesInHistory = opts.cleanDirectivesInHistory ?? true;
    this.convMgr = new ConversationManager({ maxHistory: opts.maxHistory ?? 20 });
    this.tunnelConfig = opts.tunnelConfig;
  }

  // ── override points ────────────────────────────────────────────

  /**
   * Handle an incoming chat message. Override with your agent logic.
   *
   * The lifecycle around `onChat` is:
   *   - `ctx.started()` is sent automatically before the call
   *   - your `onChat` runs
   *   - `ctx.sendTextFinal()` is sent automatically after it returns
   *   - `ctx.completed()` is sent automatically after that
   *
   * If `onChat` throws, `ctx.error(...)` is sent instead of the two trailing events.
   */
  async onChat(ctx: TaskContext, message: string, _kwargs: ChatKwargs): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }

  /** Return the agent card (override to customise). */
  getAgentCard(): AgentCard {
    return {
      agent_id: this.agentId,
      name: this.name,
      description: this.description,
      version: '1.0.0',
      capabilities: [...DEFAULT_CAPABILITIES],
      supported_protocols: [...DEFAULT_PROTOCOLS],
    };
  }

  /**
   * Handle `agent.requestFileData`. Override to implement binary file transfer.
   * Default: respond with method-not-found.
   */
  async onRequestFileData(
    ws: WebSocket,
    msgId: string | number,
    _params: Record<string, unknown>,
  ): Promise<void> {
    await wsSend(
      ws,
      jsonrpcResponse(msgId, {
        error: { code: -32601, message: 'requestFileData not supported by this agent' },
      }),
    );
  }

  // ── saving replies ─────────────────────────────────────────────

  /** Save an assistant reply to conversation history (optionally cleaning directives). */
  saveReplyToHistory(sessionId: string, reply: string): void {
    if (!reply) return;
    const cleaned = this.cleanDirectivesInHistory ? cleanReplyForHistory(reply) : reply;
    this.convMgr.addAssistantMessage(sessionId, cleaned);
  }

  // ── server lifecycle ───────────────────────────────────────────

  async run(opts: RunOptions = {}): Promise<void> {
    const host = opts.host ?? '0.0.0.0';
    const port = opts.port ?? 8080;

    const { httpServer, wsServer } = this.createServer();
    this.httpServer = httpServer;
    this.wsServer = wsServer;

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });

    this.printStartupBanner(host, port);

    if (this.tunnelConfig !== undefined) {
      this.tunnelClient = new TunnelClient({
        config: this.tunnelConfig,
        localHost: host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host,
        localPort: port,
      });
      await this.tunnelClient.start();
      const publicUrl = this.tunnelConfig.getPublicEndpoint({
        token: this.token,
        agentId: this.agentId,
      });
      // eslint-disable-next-line no-console
      console.log(`  Public WS: ${publicUrl}`);
      // eslint-disable-next-line no-console
      console.log('='.repeat(60));
    }
  }

  /**
   * Start the agent and open a reverse tunnel to the Shepaw Channel Service
   * so the agent is reachable from the public internet.
   */
  async runWithTunnel(tunnelConfig: ChannelTunnelConfig, opts: RunOptions = {}): Promise<void> {
    this.tunnelConfig = tunnelConfig;
    await this.run(opts);
  }

  /** Stop the server. Closes all WS connections and the underlying HTTP server. */
  async close(): Promise<void> {
    // Cancel all running tasks.
    for (const ctrl of this.activeTasks.values()) ctrl.abort();
    this.activeTasks.clear();

    if (this.tunnelClient !== undefined) {
      await this.tunnelClient.stop().catch(() => undefined);
      this.tunnelClient = undefined;
    }

    if (this.wsServer) {
      await new Promise<void>((resolve) => {
        this.wsServer!.close(() => resolve());
      });
      this.wsServer = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }
  }

  /**
   * Build the HTTP+WebSocket server without starting it. Useful for tests
   * that want to listen on an ephemeral port.
   */
  createServer(): { httpServer: HttpServer; wsServer: WebSocketServer } {
    const httpServer = createHttpServer(this.handleHttpRequest.bind(this));
    const wsServer = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/acp/ws') {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          this.handleWebSocket(ws, req).catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[ACP] WebSocket handler error:', err);
          });
        });
      } else {
        socket.destroy();
      }
    });

    return { httpServer, wsServer };
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  // ── WebSocket handler ──────────────────────────────────────────

  private async handleWebSocket(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    // eslint-disable-next-line no-console
    console.log(`[ACP] New WebSocket connection from ${remote}`);

    let authenticated = false;
    const authHeader = String(req.headers.authorization ?? '');
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (this.token && token === this.token) {
        // eslint-disable-next-line no-console
        console.log('[ACP] Pre-authenticated via Authorization header');
        authenticated = true;
      } else if (!this.token) {
        // eslint-disable-next-line no-console
        console.log('[ACP] No token required (server token is empty)');
        authenticated = true;
      }
    } else if (!this.token) {
      authenticated = true;
    }

    ws.on('message', (data) => {
      this.onWsMessage(ws, data.toString('utf-8'), (v) => {
        authenticated = v;
      }, () => authenticated).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[ACP] Message handler error:', err);
      });
    });

    ws.on('close', () => {
      for (const ctrl of this.activeTasks.values()) ctrl.abort();
      this.activeTasks.clear();
      for (const d of this.pendingHubRequests.values()) d.reject(new Error('Connection closed'));
      this.pendingHubRequests.clear();
      for (const d of this.pendingResponses.values()) d.reject(new Error('Connection closed'));
      this.pendingResponses.clear();
      // eslint-disable-next-line no-console
      console.log('[ACP] WebSocket connection closed');
    });
  }

  private async onWsMessage(
    ws: WebSocket,
    raw: string,
    setAuthenticated: (v: boolean) => void,
    isAuthenticated: () => boolean,
  ): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await wsSend(
        ws,
        jsonrpcResponse(null, { error: { code: -32700, message: 'Parse error' } }),
      );
      return;
    }

    const method = typeof data.method === 'string' ? data.method : undefined;
    const msgId = data.id as string | number | undefined;
    const params = (data.params as Record<string, unknown> | undefined) ?? {};

    // Request from app: has both id and method.
    if (msgId !== undefined && method !== undefined) {
      if (method === 'auth.authenticate') {
        const [ok, resp] = this.handleAuth(msgId, params);
        if (ok) setAuthenticated(true);
        await wsSend(ws, resp);
        return;
      }

      if (method === 'ping') {
        await wsSend(ws, jsonrpcResponse(msgId, { result: { pong: true } }));
        return;
      }

      if (!isAuthenticated()) {
        await wsSend(
          ws,
          jsonrpcResponse(msgId, {
            error: { code: -32000, message: 'Not authenticated' },
          }),
        );
        return;
      }

      switch (method) {
        case 'agent.chat':
          await this.handleChatDispatch(ws, msgId, params);
          return;
        case 'agent.cancelTask':
          await this.handleCancelTask(ws, msgId, params);
          return;
        case 'agent.submitResponse':
          await this.handleSubmitResponse(ws, msgId, params);
          return;
        case 'agent.rollback':
          await this.handleRollback(ws, msgId, params);
          return;
        case 'agent.getCard':
          await this.handleGetCard(ws, msgId);
          return;
        case 'agent.requestFileData':
          await this.onRequestFileData(ws, msgId, params);
          return;
        default:
          await wsSend(
            ws,
            jsonrpcResponse(msgId, {
              error: { code: -32601, message: `Method not found: ${method}` },
            }),
          );
          return;
      }
    }

    // Response to one of our hub.* requests: has id but no method.
    if (msgId !== undefined && method === undefined) {
      const deferred = this.pendingHubRequests.get(String(msgId));
      if (deferred !== undefined && !deferred.settled) {
        const error = data.error as JsonRpcErrorObject | undefined;
        if (error !== undefined) {
          deferred.reject(new Error(`Hub request failed: ${error.message ?? JSON.stringify(error)}`));
        } else {
          deferred.resolve(data.result);
        }
      }
    }
  }

  // ── auth ───────────────────────────────────────────────────────

  private handleAuth(msgId: string | number, params: Record<string, unknown>): [boolean, JsonRpcResponse] {
    const token = typeof params.token === 'string' ? params.token : '';
    if (!this.token) {
      return [true, jsonrpcResponse(msgId, { result: { status: 'authenticated' } })];
    }
    if (token === this.token) {
      return [true, jsonrpcResponse(msgId, { result: { status: 'authenticated' } })];
    }
    return [
      false,
      jsonrpcResponse(msgId, {
        error: { code: -32000, message: 'Authentication failed' },
      }),
    ];
  }

  // ── chat ───────────────────────────────────────────────────────

  private async handleChatDispatch(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : randomUUID();
    const sessionId = typeof params.session_id === 'string' ? params.session_id : taskId;
    const message = typeof params.message === 'string' ? params.message : '';
    const isHistorySupplement = params.history_supplement === true;

    if (!message && !isHistorySupplement) {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32602, message: "Missing 'message' parameter" },
        }),
      );
      return;
    }

    // Acknowledge.
    await wsSend(ws, jsonrpcResponse(msgId, { result: { task_id: taskId, status: 'accepted' } }));

    // Restore session history from the app, if provided.
    const appHistory: ConversationMessage[] | undefined = Array.isArray(params.history)
      ? params.history
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .filter(
            (m) =>
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              (m.content as string).length > 0,
          )
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
      : undefined;
    if (!this.convMgr.hasSession(sessionId) && appHistory !== undefined && appHistory.length > 0) {
      this.convMgr.initializeSession(sessionId, appHistory);
    }

    // Handle history supplement.
    if (isHistorySupplement) {
      const add: ConversationMessage[] = Array.isArray(params.additional_history)
        ? params.additional_history
            .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
            .filter(
              (m) =>
                (m.role === 'user' || m.role === 'assistant') &&
                typeof m.content === 'string' &&
                (m.content as string).length > 0,
            )
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }))
        : [];
      if (add.length > 0) this.convMgr.prependHistory(sessionId, add);
      const msgs = this.convMgr.getMessages(sessionId);
      if (msgs.length > 0 && msgs.at(-1)?.role === 'assistant') msgs.pop();
    } else if (message) {
      this.convMgr.addUserMessage(sessionId, message);
    }

    const abortController = new AbortController();
    this.activeTasks.set(taskId, abortController);

    const ctx = new TaskContext({
      ws,
      taskId,
      sessionId,
      pendingHubRequests: this.pendingHubRequests,
      pendingResponses: this.pendingResponses,
    });

    // Run lifecycle in a detached task so the WS reader keeps flowing.
    void this.runChatTask(ctx, message, params, appHistory, abortController.signal);
  }

  private async runChatTask(
    ctx: TaskContext,
    message: string,
    params: Record<string, unknown>,
    appHistory: ConversationMessage[] | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const { taskId, sessionId } = ctx;
    const kwargs: ChatKwargs = {
      session_id: sessionId,
      history: appHistory,
      messages: this.convMgr.getMessages(sessionId),
      attachments: params.attachments,
      system_prompt: typeof params.system_prompt === 'string' ? params.system_prompt : this.systemPrompt,
      group_context: params.group_context,
      ui_component_version:
        typeof params.ui_component_version === 'string' ? params.ui_component_version : undefined,
      user_id: typeof params.user_id === 'string' ? params.user_id : '',
      message_id: typeof params.message_id === 'string' ? params.message_id : '',
      is_history_supplement: params.history_supplement === true,
      params,
    };

    try {
      await ctx.started();

      await this.onChat(ctx, message, kwargs);

      await ctx.sendTextFinal();
      await ctx.completed();
    } catch (err) {
      if (signal.aborted || err instanceof TaskCancelledError) {
        await ctx.error('Task cancelled', -32008);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.error(msg, -32603);
      }
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  // ── cancel ─────────────────────────────────────────────────────

  private async handleCancelTask(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : '';
    const ctrl = this.activeTasks.get(taskId);
    if (ctrl !== undefined) {
      ctrl.abort();
      // Abort any pending waitForResponse / hubRequest so the task exits quickly.
      for (const d of this.pendingResponses.values()) {
        if (!d.settled) d.reject(new TaskCancelledError());
      }
      for (const d of this.pendingHubRequests.values()) {
        if (!d.settled) d.reject(new TaskCancelledError());
      }
      await wsSend(
        ws,
        jsonrpcResponse(msgId, { result: { task_id: taskId, status: 'cancelled' } }),
      );
    } else {
      await wsSend(
        ws,
        jsonrpcResponse(msgId, {
          error: { code: -32003, message: `Task not found: ${taskId}` },
        }),
      );
    }
  }

  // ── submitResponse (UI component reply from the app) ───────────

  private async handleSubmitResponse(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : '';
    const responseData = (params.response_data as Record<string, unknown> | undefined) ?? {};

    await wsSend(
      ws,
      jsonrpcResponse(msgId, { result: { task_id: taskId, status: 'received' } }),
    );

    for (const idKey of ['confirmation_id', 'select_id', 'upload_id', 'form_id'] as const) {
      const componentId = responseData[idKey];
      if (typeof componentId === 'string' && componentId.length > 0) {
        const deferred = this.pendingResponses.get(componentId);
        if (deferred !== undefined && !deferred.settled) {
          deferred.resolve(responseData);
        }
        break;
      }
    }
  }

  // ── rollback ───────────────────────────────────────────────────

  private async handleRollback(
    ws: WebSocket,
    msgId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = typeof params.session_id === 'string' ? params.session_id : '';
    const messageId = typeof params.message_id === 'string' ? params.message_id : '';
    this.convMgr.rollback(sessionId);
    await wsSend(
      ws,
      jsonrpcResponse(msgId, { result: { status: 'ok', message_id: messageId } }),
    );
  }

  // ── getCard ────────────────────────────────────────────────────

  private async handleGetCard(ws: WebSocket, msgId: string | number): Promise<void> {
    const card = this.getAgentCard();
    await wsSend(ws, jsonrpcResponse(msgId, { result: card }));
  }

  // ── banner ─────────────────────────────────────────────────────

  protected printStartupBanner(host: string, port: number): void {
    const banner = [
      '='.repeat(60),
      `  ${this.name} (ACP Agent Server)`,
      '='.repeat(60),
      `  Agent ID:  ${this.agentId}`,
      `  Auth:      ${this.token ? 'Token required' : 'No auth'}`,
      `  History:   ${this.convMgr.maxHistory} turns per session`,
      '-'.repeat(60),
      `  ACP WS:    ws://${host === '0.0.0.0' ? 'localhost' : host}:${port}/acp/ws`,
      `  Health:    http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/health`,
      '='.repeat(60),
    ];
    // eslint-disable-next-line no-console
    console.log(banner.join('\n'));
  }

  // silence unused-import lint warning when we don't actually emit these
  protected _unused(): void {
    void jsonrpcNotification;
  }
}
