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

/** Keep the hub→proxy WS alive across long approval waits (no traffic otherwise). */
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_ACK_TIMEOUT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** Verdict of a phone approval. `migrated` means the peer connection flapped
   * mid-approval — the hub keeps the record pending and delivers the phone's
   * tap via the deferred relay, so this turn must not relay anything itself. */
  onApproval: (req: ApprovalRequest) => Promise<{ id: string; label?: string; migrated?: boolean }>;
  /** Relays `ui.messageMetadata` (collapsible thinking/tool sections). */
  onMetadata?: (metadata: Record<string, unknown>) => void;
}

export interface AcpChatRequest {
  readonly message: string;
  readonly sessionId?: string;
  /**
   * Caller-allocated task id. The hub's peer-level turn registry owns the
   * request_id ↔ task_id mapping (needed for cross-connection turn resume and
   * cancel routing), so it must know the id BEFORE the turn starts.
   */
  readonly taskId: string;
  /** ACP-compatible attachment objects (base64 `data`, `file_name`, …). */
  readonly attachments?: ReadonlyArray<Record<string, unknown>>;
  /**
   * App transcript for this conversation. The proxy injects it only when it
   * has to session/new (restore failed); live/resumed sessions ignore it.
   */
  readonly history?: ReadonlyArray<{ role: string; content: string }>;
}

interface InflightTurn {
  handlers: AcpChatHandlers;
  accumulated: string;
  resolve: () => void;
  cancelTimer: NodeJS.Timeout;
  /** Set via cancelTurn — the 300ms cancelTimer polls this and forwards
   * `agent.cancelTask` to the proxy. Replaces the old shouldCancel closure so
   * cancel works from ANY live connection (peer-level turn registry routes
   * here by taskId). */
  cancelRequested: boolean;
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
  private heartbeat: NodeJS.Timeout | undefined;
  /**
   * Turns to reattach once the transport is back. A dropped hub→proxy WS no
   * longer kills in-flight turns: the proxy keeps running them (replay
   * buffer), so on reconnect each marked turn is resumed via agent.taskResume
   * with drop-prefix dedup. Only a 'lost' answer (proxy restarted) fails one.
   */
  private pendingResume: Set<string> | undefined;
  private resumeLoop: Promise<void> | undefined;

  /** Whether any chat turn is still running on this client. */
  get hasInflightTurns(): boolean {
    return this.inflight.size > 0;
  }

  /**
   * Request cancellation of a running turn. The 300ms cancelTimer forwards
   * `agent.cancelTask` to the proxy. Called via the peer-level turn registry
   * (works from any live connection — the registry owns request_id ↔ taskId).
   */
  cancelTurn(taskId: string): void {
    const turn = this.inflight.get(taskId);
    if (turn !== undefined) turn.cancelRequested = true;
  }

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
    const taskId = req.taskId ?? randomUUID();
    const sessionId = req.sessionId ?? this.defaultSessionId;

    const cancelTimer = setInterval(() => {
      const t = this.inflight.get(taskId);
      if (t !== undefined && t.cancelRequested) {
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
      cancelRequested: false,
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
        ...(req.attachments && req.attachments.length > 0
          ? { attachments: req.attachments }
          : {}),
        ...(req.history && req.history.length > 0 ? { history: req.history } : {}),
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
   * Re-attach to a task that kept running on the proxy while the hub was
   * away (restart/upgrade). Sends `agent.taskResume` with known_length=0 and
   * returns the proxy's buffered stream + status WITHOUT firing handlers for
   * the replayed part — the caller folds the delta into its own registry and
   * serves it via the resume response (live-routing it would double-deliver
   * to the app). For a still-running task the inflight turn IS registered
   * (with `accumulated` pre-seeded), so chunks / confirmations / completion
   * arriving after the resume response route to the handlers normally.
   */
  async reattachTurn(
    taskId: string,
    handlers: AcpChatHandlers,
  ): Promise<{
    status: 'streaming' | 'done' | 'error' | 'lost';
    /** Full buffered text stream (known_length=0 ⇒ whole stream). */
    delta: string;
    metadata?: Record<string, unknown>;
    content?: string;
    terminalMetadata?: Record<string, unknown>;
    message?: string;
  }> {
    if (this.inflight.has(taskId)) return { status: 'streaming', delta: '' };
    await this.ensureConnected();
    const id = this.rpcId++;
    const result = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(undefined);
      }, 15_000);
      this.pendingRequests.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!this.send({
        jsonrpc: '2.0',
        id,
        method: 'agent.taskResume',
        params: { task_id: taskId, known_length: 0 },
      })) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        resolve(undefined);
      }
    });
    if (result === undefined) {
      this.log(`reattach task=${taskId} → no response (timeout/send failure)`);
      return { status: 'lost', delta: '' };
    }
    const status = result.status as string | undefined;
    const delta = (result.delta as string | undefined) ?? '';
    const metadata = result.stream_metadata as Record<string, unknown> | undefined;

    if (status === 'streaming') {
      const cancelTimer = setInterval(() => {
        const t = this.inflight.get(taskId);
        if (t !== undefined && t.cancelRequested) {
          try {
            this.send({ jsonrpc: '2.0', id: this.rpcId++, method: 'agent.cancelTask', params: { task_id: taskId } });
          } catch { /* ignore */ }
        }
      }, 300);
      const turn: InflightTurn = {
        handlers,
        accumulated: delta,
        resolve: () => {},
        cancelTimer,
        cancelRequested: false,
        pendingApprovals: 0,
      };
      this.inflight.set(taskId, turn);
      this.log(`reattach task=${taskId} → streaming, buffered ${delta.length} units`);
      return { status: 'streaming', delta, ...(metadata !== undefined ? { metadata } : {}) };
    }
    if (status === 'done') {
      const content = (result.content as string | undefined) ?? delta;
      const terminalMetadata = result.metadata as Record<string, unknown> | undefined;
      this.log(`reattach task=${taskId} → done, ${content.length} units`);
      return {
        status: 'done',
        delta,
        content,
        ...(terminalMetadata !== undefined ? { terminalMetadata } : {}),
      };
    }
    if (status === 'error') {
      this.log(`reattach task=${taskId} → error`);
      return {
        status: 'error',
        delta,
        message: (result.message as string | undefined) ?? 'agent error',
      };
    }
    this.log(`reattach task=${taskId} → lost`);
    return { status: 'lost', delta: '' };
  }

  /**
   * Deliver `agent.submitResponse` to the local ACP agent. Reconnects if the
   * WS dropped mid-turn — a silent no-op here leaves Cursor on [pending]
   * forever after the user already tapped Allow. Retries a few times with a
   * fresh connection before giving up; callers must treat a `false` return
   * as "the agent will hang until its own timeout".
   */
  private async submitResponseToAgent(
    taskId: string,
    confirmationId: string,
    selected: { id: string; label?: string },
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Permanently closed (turn error / teardown) — retrying a dead client is
      // pointless: ensureConnected throws 'client closed' every time, and the
      // agent never gets the verdict. Fail fast; the deferred relay on a live
      // client owns recovery.
      if (this.closed) {
        this.log(
          `submitResponse skipped (client closed) task=${taskId} confirmation=${confirmationId}`,
        );
        return false;
      }
      try {
        await this.ensureConnected();
      } catch (err) {
        this.log(
          `submitResponse ensureConnected failed (attempt ${attempt}/3) task=${taskId} ` +
          `confirmation=${confirmationId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.resetTransport();
        if (attempt < 3) await sleep(500);
        continue;
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
      if (ok) return true;
      this.log(
        `submitResponse send failed (attempt ${attempt}/3, ws not open) ` +
        `task=${taskId} confirmation=${confirmationId}`,
      );
      this.resetTransport();
      if (attempt < 3) await sleep(500);
    }
    this.log(
      `submitResponse FAILED after 3 attempts task=${taskId} confirmation=${confirmationId} ` +
      `— the agent stays [pending] until its own approval timeout`,
    );
    return false;
  }

  /**
   * Drop the current transport WITHOUT failing in-flight turns (unlike
   * onTransportGone). Used between submitResponse retries so the next attempt
   * reconnects cleanly; the old socket's close event must not trigger failAll.
   * In-flight turns are marked for resume — the reconnect kicks the loop.
   */
  private resetTransport(): void {
    this.stopHeartbeat();
    this.markTurnsForResume();
    const ws = this.ws;
    this.ws = undefined;
    this.session = undefined;
    this.connecting = undefined;
    if (ws !== undefined) {
      ws.removeAllListeners();
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const id = this.rpcId++;
      // Register a no-op resolver so the pong ack isn't logged as unknown;
      // expire it if the pong never arrives so pendingRequests can't leak.
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
      }, HEARTBEAT_ACK_TIMEOUT_MS);
      this.pendingRequests.set(id, () => clearTimeout(timer));
      if (!this.send({ jsonrpc: '2.0', id, method: 'ping', params: {} })) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Close the persistent connection and fail all in-flight turns. */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.pendingResume = undefined;
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

  /**
   * Fetch upstream session modes via `agent.modes.list`.
   * Resolves with `{ modes, current }` (empty on failure/timeout).
   */
  async modesList(sessionId?: string): Promise<{ modes: unknown[]; current?: string }> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve({ modes: [] });
      }, 15_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        const modes = result?.modes;
        const current = result?.current;
        resolve({
          modes: Array.isArray(modes) ? modes : [],
          current: typeof current === 'string' ? current : undefined,
        });
      });
      const params: Record<string, unknown> = {};
      if (sessionId !== undefined && sessionId.length > 0) params.session_id = sessionId;
      this.send({ jsonrpc: '2.0', id, method: 'agent.modes.list', params });
    });
  }

  /**
   * Switch the upstream session mode via `agent.modes.setCurrent`.
   * Returns the result object on success, or `null` on failure/timeout.
   */
  async modesSetCurrent(
    mode: string,
    sessionId?: string,
  ): Promise<{ mode: string; display_name?: string } | null> {
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
        const m = result.mode;
        resolve({
          mode: typeof m === 'string' ? m : mode,
          display_name: typeof result.display_name === 'string' ? result.display_name : undefined,
        });
      });
      const params: Record<string, unknown> = { mode };
      if (sessionId !== undefined && sessionId.length > 0) params.session_id = sessionId;
      this.send({ jsonrpc: '2.0', id, method: 'agent.modes.setCurrent', params });
    });
  }

  /**
   * Fetch the agent's self-description card via `agent.getCard` on the
   * persistent WS. Resolves with the card object (undefined on failure/timeout).
   * The card carries the workspace-grounded resume in `description`/`bio` and a
   * `capabilities` list — surfaced on the hub's instance detail page.
   */
  async card(): Promise<Record<string, unknown> | undefined> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(undefined);
      }, 8_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ jsonrpc: '2.0', id, method: 'agent.getCard', params: {} });
    });
  }

  /**
   * Ask the agent to re-derive its workspace resume via `agent.resume.rebuild`.
   * Resolves with the fresh card object (undefined on failure/timeout). The
   * timeout is generous — re-scanning the workspace can take a few seconds.
   */
  async resumeRebuild(params?: { prompt?: string }): Promise<Record<string, unknown> | undefined> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(undefined);
      }, 30_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ jsonrpc: '2.0', id, method: 'agent.resume.rebuild', params: params ?? {} });
    });
  }

  /**
   * Set/clear the agent's custom resume prompt via `agent.resume.promptSet`.
   * A pure memory write on the gateway — 8 s timeout is plenty. Resolves with
   * the (unchanged) card, or undefined on failure (e.g. an older gateway
   * binary without the method — callers treat that as non-fatal).
   */
  async resumePromptSet(prompt: string): Promise<Record<string, unknown> | undefined> {
    await this.ensureConnected();
    const id = this.rpcId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(undefined);
      }, 8_000);
      this.pendingRequests.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ jsonrpc: '2.0', id, method: 'agent.resume.promptSet', params: { prompt } });
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
    this.startHeartbeat();
    this.log(`acp client connected to ${this.instance.id} (${this.instance.port})`);
    // A reconnect with turns marked for resume (flap / submitResponse reset):
    // reattach them from the proxy's replay buffer.
    this.kickResume();
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
      if (
        turn === undefined &&
        (method === 'ui.actionConfirmation' || method === 'task.completed' || method === 'task.error')
      ) {
        // Previously these were dropped silently — an approval request lost
        // here leaves the agent on [pending] until its own timeout.
        this.log(
          `acp notify dropped (unknown task=${taskId}) method=${method} ` +
          `inflight=[${[...this.inflight.keys()].join(', ')}]`,
        );
      }

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
        // The SDK flattens `extra` into params top-level (task-context.ts);
        // fall back to a nested `extra` object for older senders.
        const nestedExtra = (params.extra as Record<string, unknown> | undefined) ?? {};
        const toolKind =
          typeof params.tool_kind === 'string' ? params.tool_kind
            : typeof nestedExtra.tool_kind === 'string' ? nestedExtra.tool_kind
              : undefined;
        const toolCallId =
          typeof params.tool_call_id === 'string' ? params.tool_call_id
            : typeof nestedExtra.tool_call_id === 'string' ? nestedExtra.tool_call_id
              : undefined;
        void turn.handlers
          .onApproval({
            confirmationId,
            taskId,
            prompt: (params.prompt as string | undefined) ?? '',
            actions,
            toolKind,
            toolCallId,
          })
          .then(async (selected) => {
            this.log(
              `ui.actionConfirmation resolved task=${taskId} confirmation=${confirmationId} ` +
              `selected=${selected.id ?? ''} label=${selected.label ?? ''}`,
            );
            if (selected.migrated === true) {
              // Peer WS flapped mid-approval — the hub kept the record pending;
              // the phone's tap will arrive via the deferred relay on a live
              // client. Sending a deny from here would be wrong, and this old
              // turn only needs its bookkeeping unwound (see .finally).
              this.log(
                `approval ${confirmationId} migrated to deferred relay (peer reconnect)`,
              );
              return;
            }
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
    this.stopHeartbeat();
    this.ws = undefined;
    this.session = undefined;
    this.connecting = undefined;
    // Turns survive: the proxy kept running them. Mark every in-flight turn
    // for resume and start the reconnect loop — a flap should be invisible
    // to the app (chunks missed meanwhile replay via agent.taskResume).
    this.markTurnsForResume();
    if (this.pendingResume !== undefined && this.pendingResume.size > 0) {
      this.log(
        `acp transport lost with ${this.pendingResume.size} inflight turn(s) — will reconnect and resume`,
      );
      this.kickResume();
    }
  }

  /** Mark every in-flight turn for reattach after the next (re)connect. */
  private markTurnsForResume(): void {
    if (this.inflight.size === 0) return;
    this.pendingResume ??= new Set();
    for (const id of this.inflight.keys()) this.pendingResume.add(id);
  }

  private kickResume(): void {
    if (this.closed) return;
    if (this.pendingResume === undefined || this.pendingResume.size === 0) return;
    if (this.resumeLoop !== undefined) return;
    this.resumeLoop = this.resumeLoopBody()
      .catch(() => { /* body never throws; guard anyway */ })
      .finally(() => { this.resumeLoop = undefined; });
  }

  /**
   * Reconnect with backoff, then reattach every marked turn via
   * agent.taskResume. Turns that can't be resumed after the retry budget
   * (or that the proxy answers 'lost' for) are failed individually — the
   * proxy restarting is the only real loss case.
   */
  private async resumeLoopBody(): Promise<void> {
    const delays = [500, 1000, 2000, 5000, 10000, 20000, 30000, 30000];
    for (let attempt = 0; !this.closed; attempt++) {
      const pending = this.pendingResume;
      if (pending === undefined || pending.size === 0) return;
      if (attempt >= delays.length) {
        this.log(`acp resume exhausted — failing ${pending.size} detached turn(s)`);
        for (const taskId of pending) {
          this.failTurnNow(taskId, 'acp connection lost');
        }
        this.pendingResume = undefined;
        return;
      }
      if (this.ws === undefined || this.session === undefined) {
        try {
          await this.ensureConnected();
        } catch (err) {
          this.log(
            `acp resume reconnect failed (attempt ${attempt + 1}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(delays[attempt] ?? 30_000);
          continue;
        }
      }
      for (const taskId of [...pending]) {
        if (this.closed) return;
        const turn = this.inflight.get(taskId);
        pending.delete(taskId);
        if (turn === undefined) continue; // finished while we were reconnecting
        const outcome = await this.resumeOneTurn(taskId, turn);
        if (outcome === 'retry') {
          pending.add(taskId);
          break; // transport died again — reconnect before more resumes
        }
      }
      if (pending.size === 0) {
        this.pendingResume = undefined;
        return;
      }
      await sleep(delays[attempt] ?? 30_000);
    }
  }

  /**
   * Reattach one in-flight turn after a reconnect. Delta semantics match the
   * app/hub resume: the proxy replays from `known_length`; chunks that raced
   * the response on the fresh socket are drop-prefixed (they were already
   * applied live by onMessage).
   */
  private async resumeOneTurn(taskId: string, turn: InflightTurn): Promise<'ok' | 'retry'> {
    const base = turn.accumulated.length;
    const id = this.rpcId++;
    const result = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(undefined);
      }, 15_000);
      this.pendingRequests.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (!this.send({
        jsonrpc: '2.0',
        id,
        method: 'agent.taskResume',
        params: { task_id: taskId, known_length: base },
      })) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        resolve(undefined);
      }
    });
    // The turn may have finished (or been cancelled) while the request was out.
    if (this.inflight.get(taskId) !== turn) return 'ok';
    if (result === undefined) return 'retry';
    const status = result.status as string | undefined;
    if (status === 'streaming' || status === 'done' || status === 'error') {
      const delta = (result.delta as string | undefined) ?? '';
      const skip = Math.max(0, Math.min(turn.accumulated.length - base, delta.length));
      const apply = delta.slice(skip);
      if (apply.length > 0) {
        turn.accumulated += apply;
        turn.handlers.onChunk(apply);
      }
      if (status === 'streaming') {
        const meta = result.stream_metadata as Record<string, unknown> | undefined;
        if (meta !== undefined) turn.handlers.onMetadata?.(meta);
        this.log(`resume task=${taskId} → streaming, applied ${apply.length} units (skipped ${skip} live)`);
        return 'ok';
      }
      if (status === 'done') {
        turn.completedPayload = {
          content: (result.content as string | undefined) ?? turn.accumulated,
          ...(result.metadata !== undefined
            ? { metadata: result.metadata as Record<string, unknown> }
            : {}),
        };
        this.maybeFinishTurn(taskId, turn);
        return 'ok';
      }
      clearInterval(turn.cancelTimer);
      turn.handlers.onError((result.message as string | undefined) ?? 'agent error');
      this.inflight.delete(taskId);
      turn.resolve();
      return 'ok';
    }
    // 'lost' — the proxy no longer has the task (e.g. it restarted).
    this.log(`resume task=${taskId} → lost on agent`);
    this.failTurnNow(taskId, '对端任务已丢失（agent 重启）');
    return 'ok';
  }

  /** Fail one in-flight turn immediately (resume exhausted / proxy lost it). */
  private failTurnNow(taskId: string, message: string): void {
    const turn = this.inflight.get(taskId);
    if (turn === undefined) return;
    clearInterval(turn.cancelTimer);
    try { turn.handlers.onError(message); } catch { /* ignore */ }
    this.inflight.delete(taskId);
    turn.resolve();
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
