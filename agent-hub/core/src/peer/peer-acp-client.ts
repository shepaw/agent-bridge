/**
 * Persistent ACP client to a local instance, reused across chat turns for one
 * (peer, agent) pair.
 *
 * Replaces the one-shot-per-chat approach: one WebSocket + Noise session is
 * kept open and all `agent.chat` turns for that pair ride on it, keyed by
 * `task_id`. A stable `session_id` (per pair, or the phone's) preserves
 * multi-turn context and keeps the agent's `acpSessionCount` from growing per
 * turn. Tool-call approvals (`ui.actionConfirmation`) are routed to the
 * in-flight turn's `onApproval` and the verdict sent back as
 * `agent.submitResponse` on the same WS.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  decodeFrame,
  encodeFrame,
  NoiseSession,
  NOISE_PROLOGUE,
} from 'shepaw-acp-sdk';
import type { AgentIdentity } from 'shepaw-acp-sdk';
import type { InstanceConfig } from '../config.js';

export interface ApprovalRequest {
  readonly confirmationId: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
  readonly toolKind?: string;
  readonly toolCallId?: string;
}

export interface AcpChatHandlers {
  onChunk: (content: string) => void;
  onDone: (fullContent: string, metadata?: Record<string, unknown>) => void;
  onError: (message: string) => void;
  onApproval: (req: ApprovalRequest) => Promise<{ id: string; label?: string }>;
  /** Relays `ui.messageMetadata` (collapsible thinking/tool sections). */
  onMetadata?: (metadata: Record<string, unknown>) => void;
}

export interface AcpChatRequest {
  readonly message: string;
  readonly sessionId?: string;
  readonly shouldCancel: () => boolean;
}

interface InflightTurn {
  handlers: AcpChatHandlers;
  accumulated: string;
  resolve: () => void;
  cancelTimer: NodeJS.Timeout;
  /** In-flight phone approvals relayed for this turn (async-confirmation agents). */
  pendingApprovals: number;
  /** Set when `task.completed` arrives before approvals finish. */
  completedPayload?: { content: string; metadata?: Record<string, unknown> };
}

export class PeerAcpClient {
  private ws: WebSocket | undefined;
  private session: NoiseSession | undefined;
  private connecting: Promise<void> | undefined;
  private readonly inflight = new Map<string, InflightTurn>();
  /** Pending JSON-RPC requests (id → resolver) for agent.commands.list etc. */
  private readonly pendingRequests = new Map<number, (result: Record<string, unknown> | undefined) => void>();
  private rpcId = 1;
  private closed = false;
  /** Stable session id for this (peer, agent) pair — preserves multi-turn context. */
  private readonly defaultSessionId: string;

  constructor(
    private readonly peerIdentity: AgentIdentity,
    private readonly instance: InstanceConfig,
    private readonly instanceIdentity: AgentIdentity,
    private readonly log: (line: string) => void,
  ) {
    this.defaultSessionId = `peer_${peerIdentity.fingerprint}_${instance.id}`;
  }

  /**
   * Run one chat turn on the persistent connection. Opens the WS + Noise
   * handshake on first use. Resolves when the turn ends (task.completed /
   * task.error). Throws on connection/handshake failure.
   */
  async chat(req: AcpChatRequest, handlers: AcpChatHandlers): Promise<void> {
    await this.ensureConnected();
    const taskId = randomUUID();
    const sessionId = req.sessionId ?? this.defaultSessionId;

    const cancelTimer = setInterval(() => {
      if (req.shouldCancel() && this.inflight.has(taskId)) {
        try {
          this.send({ jsonrpc: '2.0', id: this.rpcId++, method: 'agent.cancelTask', params: { task_id: taskId } });
        } catch { /* ignore */ }
      }
    }, 300);

    const turn: InflightTurn = {
      handlers,
      accumulated: '',
      resolve: () => {},
      cancelTimer,
      pendingApprovals: 0,
    };
    this.inflight.set(taskId, turn);

    this.send({
      jsonrpc: '2.0',
      id: this.rpcId++,
      method: 'agent.chat',
      params: {
        task_id: taskId,
        session_id: sessionId,
        message: req.message,
        user_id: 'peer-service',
        ui_component_version: 'v2',
      },
    });

    return new Promise<void>((resolve) => {
      turn.resolve = resolve;
    });
  }

  /**
   * Submit a tool-call verdict when the in-band turn handler is gone (deferred
   * client approval after hub/phone restart). Requires the original task_id.
   */
  async submitDeferredApproval(
    taskId: string,
    confirmationId: string,
    selected: { id: string; label?: string },
  ): Promise<boolean> {
    return this.submitResponseToAgent(taskId, confirmationId, selected);
  }

  /**
   * Deliver `agent.submitResponse` to the local ACP agent. Reconnects if the
   * WS dropped mid-turn — a silent no-op here leaves Cursor on [pending]
   * forever after the user already tapped Allow.
   */
  private async submitResponseToAgent(
    taskId: string,
    confirmationId: string,
    selected: { id: string; label?: string },
  ): Promise<boolean> {
    try {
      await this.ensureConnected();
    } catch (err) {
      this.log(
        `submitResponse ensureConnected failed task=${taskId} ` +
        `confirmation=${confirmationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    this.log(
      `submitResponse task=${taskId} confirmation=${confirmationId} ` +
      `selected=${selected.id} label=${selected.label ?? ''}`,
    );
    const ok = this.send({
      jsonrpc: '2.0',
      id: this.rpcId++,
      method: 'agent.submitResponse',
      params: {
        task_id: taskId,
        response_data: {
          confirmation_id: confirmationId,
          selected_action_id: selected.id,
          ...(selected.label !== undefined && selected.label.length > 0
            ? { selected_action_label: selected.label }
            : {}),
        },
      },
    });
    if (!ok) {
      this.log(
        `submitResponse DROPPED (ws not open) task=${taskId} confirmation=${confirmationId}`,
      );
    }
    return ok;
  }

  /** Close the persistent connection and fail all in-flight turns. */
  close(): void {
    this.closed = true;
    this.failAll('peer connection closed');
    for (const r of this.pendingRequests.values()) r(undefined);
    this.pendingRequests.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    this.session = undefined;
  }

  /**
   * Fetch the agent's slash commands via `agent.commands.list` on the
   * persistent WS. Resolves with the commands array (empty on failure/timeout).
   */
  async commands(): Promise<unknown[]> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise<unknown[]>((resolve) => {
      // Generous timeout: on a cold subprocess this now warms the command
      // cache via a throwaway session/new (spawn + handshake + a short
      // notification wait), which can take longer than a simple RPC round trip.
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve([]);
      }, 15_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        const commands = result?.commands;
        resolve(Array.isArray(commands) ? commands : []);
      });
      this.send({ jsonrpc: '2.0', id, method: 'agent.commands.list', params: {} });
    });
  }

  /**
   * Fetch the agent's known sessions via `agent.sessions.list` on the
   * persistent WS. Resolves with the sessions array (empty on failure/timeout
   * or when the underlying agent can't enumerate sessions).
   */
  async sessions(): Promise<unknown[]> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise<unknown[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve([]);
      }, 8_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        const sessions = result?.sessions;
        resolve(Array.isArray(sessions) ? sessions : []);
      });
      this.send({ jsonrpc: '2.0', id, method: 'agent.sessions.list', params: {} });
    });
  }

  /**
   * Fetch a session's replayed transcript via `agent.sessions.history`.
   * Resolves with the messages array (empty on failure/timeout or when the
   * agent can't replay). History replay can be slow, hence the longer timeout.
   */
  async sessionHistory(sessionId: string): Promise<unknown[]> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise<unknown[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve([]);
      }, 40_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        const messages = result?.messages;
        resolve(Array.isArray(messages) ? messages : []);
      });
      this.send({
        jsonrpc: '2.0',
        id,
        method: 'agent.sessions.history',
        params: { session_id: sessionId },
      });
    });
  }

  /**
   * Fetch upstream model options via `agent.models.list`.
   * Resolves with `{ models, current }` (empty on failure/timeout).
   */
  async modelsList(sessionId?: string): Promise<{ models: unknown[]; current?: string }> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve({ models: [] });
      }, 15_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        const models = result?.models;
        const current = result?.current;
        resolve({
          models: Array.isArray(models) ? models : [],
          current: typeof current === 'string' ? current : undefined,
        });
      });
      const params: Record<string, unknown> = {};
      if (sessionId !== undefined && sessionId.length > 0) params.session_id = sessionId;
      this.send({ jsonrpc: '2.0', id, method: 'agent.models.list', params });
    });
  }

  /**
   * Switch the upstream model via `agent.models.setCurrent`.
   * Returns the result object on success, or `null` on failure/timeout.
   */
  async modelsSetCurrent(
    model: string,
    sessionId?: string,
  ): Promise<{ model: string; display_name?: string } | null> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(null);
      }, 15_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        if (result === undefined) {
          resolve(null);
          return;
        }
        const m = result.model;
        resolve({
          model: typeof m === 'string' ? m : model,
          display_name: typeof result.display_name === 'string' ? result.display_name : undefined,
        });
      });
      const params: Record<string, unknown> = { model };
      if (sessionId !== undefined && sessionId.length > 0) params.session_id = sessionId;
      this.send({ jsonrpc: '2.0', id, method: 'agent.models.setCurrent', params });
    });
  }

  // ── internals ────────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('client closed');
    if (this.ws !== undefined && this.ws.readyState === this.ws.OPEN && this.session !== undefined) return;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const url = `ws://127.0.0.1:${this.instance.port}/acp/ws`;
    const session = NoiseSession.initiator({
      staticPublicKey: this.peerIdentity.staticPublicKey,
      staticPrivateKey: this.peerIdentity.staticPrivateKey,
      remoteStaticPublicKey: this.instanceIdentity.staticPublicKey,
      prologue: NOISE_PROLOGUE,
    });
    const ws = new WebSocket(url);

    // Open + send msg1.
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        const msg1Payload = JSON.stringify({ agentId: this.instanceIdentity.agentId, clientVersion: 'shepaw-hub-peer/1.0' });
        ws.send(encodeFrame({ t: 'hs', payload: session.writeHandshake1(Buffer.from(msg1Payload, 'utf-8')) }));
        resolve();
      });
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`ws closed before open (code ${code})`)));
    });

    // Wait for msg2 (10s timeout).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('agent handshake timeout (no msg2)')); }, 10_000);
      const onMsg = (data: WebSocket.RawData): void => {
        try {
          const frame = decodeFrame(data.toString('utf-8'));
          if (frame.t !== 'hs') { clearTimeout(timer); reject(new Error(`expected hs frame, got ${frame.t}`)); return; }
          session.readHandshake2(frame.payload);
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve();
        } catch (err) { clearTimeout(timer); ws.off('message', onMsg); reject(err); }
      };
      ws.on('message', onMsg);
    });

    this.ws = ws;
    this.session = session;
    ws.on('message', (data) => this.onMessage(data));
    ws.once('close', () => this.onTransportGone());
    ws.once('error', () => this.onTransportGone());
    this.log(`acp client connected to ${this.instance.id} (${this.instance.port})`);
  }

  private onMessage(data: WebSocket.RawData): void {
    if (this.session === undefined) return;
    try {
      const frame = decodeFrame(data.toString('utf-8'));
      if (frame.t !== 'data') return;
      const obj = JSON.parse(Buffer.from(this.session.decrypt(frame.payload)).toString('utf-8')) as Record<string, unknown>;
      const method = obj.method as string | undefined;
      if (process.env.SHEPAW_PEER_DEBUG === '1') {
        this.log(`acp notify: method=${method ?? '?'} id=${obj.id ?? '-'} task=${(obj.params as Record<string, unknown> | undefined)?.task_id ?? '-'}`);
      }
      if (obj.id !== undefined) {
        // Response to one of our requests (agent.chat ack, agent.commands.list,
        // etc.). Route to the pending resolver; agent.chat acks have no
        // registered resolver and are dropped (the turn is tracked by task_id).
        if (method === undefined) {
          const resolver = this.pendingRequests.get(obj.id as number);
          if (resolver !== undefined) {
            this.pendingRequests.delete(obj.id as number);
            resolver(obj.result as Record<string, unknown> | undefined);
          }
        }
        return;
      }
      const params = (obj.params as Record<string, unknown> | undefined) ?? {};
      const taskId = params.task_id as string | undefined;
      // Every notification we route is task-scoped; ignore anything without one.
      if (taskId === undefined) return;
      const turn = this.inflight.get(taskId);

      if (method === 'ui.textContent') {
        const content = (params.content as string | undefined) ?? '';
        if (params.is_final !== true && content.length > 0 && turn !== undefined) {
          turn.accumulated += content;
          turn.handlers.onChunk(content);
        }
        return;
      }
      if (method === 'ui.messageMetadata' && turn !== undefined) {
        // Strip task_id — peer clients key by request_id, not ACP task_id.
        const { task_id: _taskId, ...meta } = params;
        turn.handlers.onMetadata?.(meta);
        return;
      }
      if (method === 'ui.actionConfirmation' && turn !== undefined) {
        const confirmationId = params.confirmation_id as string | undefined;
        if (confirmationId === undefined) return;
        turn.pendingApprovals += 1;
        this.log(
          `ui.actionConfirmation task=${taskId} confirmation=${confirmationId} ` +
          `actions=${Array.isArray(params.actions) ? params.actions.length : 0} ` +
          `pendingApprovals=${turn.pendingApprovals}`,
        );
        const actions = Array.isArray(params.actions)
          ? (params.actions as Array<Record<string, unknown>>).map((a) => ({
              id: String(a.id ?? ''),
              label: typeof a.label === 'string' ? a.label : undefined,
              style: typeof a.style === 'string' ? a.style : undefined,
            }))
          : [];
        const extra = (params.extra as Record<string, unknown> | undefined) ?? {};
        void turn.handlers
          .onApproval({
            confirmationId,
            taskId,
            prompt: (params.prompt as string | undefined) ?? '',
            actions,
            toolKind: typeof extra.tool_kind === 'string' ? extra.tool_kind : undefined,
            toolCallId: typeof extra.tool_call_id === 'string' ? extra.tool_call_id : undefined,
          })
          .then(async (selected) => {
            this.log(
              `ui.actionConfirmation resolved task=${taskId} confirmation=${confirmationId} ` +
              `selected=${selected.id ?? ''} label=${selected.label ?? ''}`,
            );
            await this.submitResponseToAgent(taskId, confirmationId, selected);
          })
          .catch(async () => {
            await this.submitResponseToAgent(taskId, confirmationId, { id: '' });
          })
          .finally(() => {
            turn.pendingApprovals = Math.max(0, turn.pendingApprovals - 1);
            this.maybeFinishTurn(taskId, turn);
          });
        return;
      }
      if (method === 'task.completed' && turn !== undefined) {
        const meta = params as Record<string, unknown>;
        turn.completedPayload = { content: turn.accumulated, metadata: meta };
        this.maybeFinishTurn(taskId, turn);
        return;
      }
      if (method === 'task.error' && turn !== undefined) {
        clearInterval(turn.cancelTimer);
        turn.handlers.onError((params.message as string | undefined) ?? 'agent error');
        this.inflight.delete(taskId);
        turn.resolve();
        return;
      }
    } catch (err) {
      // Decrypt/parse failure — often a Noise counter desync or a malformed
      // frame. Log so silent drops don't hide approval-stream bugs.
      this.log(`acp frame drop: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Async-confirmation agents end the SDK turn (`task.completed`) while the
   * phone approval is still in flight. Defer `onDone` until every relayed
   * approval for this turn settles so the app keeps `sendChat` open.
   */
  private maybeFinishTurn(taskId: string, turn: InflightTurn): void {
    if (turn.pendingApprovals > 0) {
      this.log(
        `task defer finish task=${taskId} pendingApprovals=${turn.pendingApprovals}`,
      );
      return;
    }
    if (turn.completedPayload === undefined) return;
    clearInterval(turn.cancelTimer);
    const { content, metadata } = turn.completedPayload;
    turn.handlers.onDone(content, metadata);
    this.inflight.delete(taskId);
    turn.resolve();
  }

  private onTransportGone(): void {
    this.ws = undefined;
    this.session = undefined;
    this.connecting = undefined;
    this.failAll('acp connection closed');
  }

  private failAll(message: string): void {
    for (const turn of this.inflight.values()) {
      clearInterval(turn.cancelTimer);
      try { turn.handlers.onError(message); } catch { /* ignore */ }
      turn.resolve();
    }
    this.inflight.clear();
  }

  private send(obj: Record<string, unknown>): boolean {
    if (this.ws === undefined || this.session === undefined || this.ws.readyState !== this.ws.OPEN) {
      return false;
    }
    const ct = this.session.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
    this.ws.send(encodeFrame({ t: 'data', payload: ct }));
    return true;
  }
}
