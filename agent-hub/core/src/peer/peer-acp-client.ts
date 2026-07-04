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
  onApproval: (req: ApprovalRequest) => Promise<string>;
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
}

export class PeerAcpClient {
  private ws: WebSocket | undefined;
  private session: NoiseSession | undefined;
  private connecting: Promise<void> | undefined;
  private readonly inflight = new Map<string, InflightTurn>();
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

    const turn: InflightTurn = { handlers, accumulated: '', resolve: () => {}, cancelTimer };
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

  /** Close the persistent connection and fail all in-flight turns. */
  close(): void {
    this.closed = true;
    this.failAll('peer connection closed');
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
    this.session = undefined;
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
      if (obj.id !== undefined) return; // ack response
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
      if (method === 'ui.actionConfirmation' && turn !== undefined) {
        const confirmationId = params.confirmation_id as string | undefined;
        if (confirmationId === undefined) return;
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
          .then((selected) => {
            this.send({
              jsonrpc: '2.0', id: this.rpcId++, method: 'agent.submitResponse',
              params: { task_id: taskId, response_data: { confirmation_id: confirmationId, selected_action_id: selected ?? '' } },
            });
          })
          .catch(() => {
            this.send({
              jsonrpc: '2.0', id: this.rpcId++, method: 'agent.submitResponse',
              params: { task_id: taskId, response_data: { confirmation_id: confirmationId, selected_action_id: '' } },
            });
          });
        return;
      }
      if (method === 'task.completed' && turn !== undefined) {
        clearInterval(turn.cancelTimer);
        const meta = params as Record<string, unknown>;
        turn.handlers.onDone(turn.accumulated, meta);
        this.inflight.delete(taskId);
        turn.resolve();
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

  private send(obj: Record<string, unknown>): void {
    if (this.ws === undefined || this.session === undefined || this.ws.readyState !== this.ws.OPEN) return;
    const ct = this.session.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
    this.ws.send(encodeFrame({ t: 'data', payload: ct }));
  }
}
