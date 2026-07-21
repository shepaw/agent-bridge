/**
 * One established peer connection (post-handshake).
 *
 * Wraps a ready NoiseSession + WebSocket, decrypts incoming `data` frames,
 * routes by JSON `type`, and encrypts outgoing messages. Implements the
 * app's peer-channel protocol: `ping/pong` heartbeat, `agent_list_*`, and
 * `agent_chat/chunk/done/error/cancel` proxied to local ACP agents.
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { decodeFrame, encodeFrame, NoiseSession, loadOrCreateIdentity } from 'shepaw-acp-sdk';
import type { AgentIdentity } from 'shepaw-acp-sdk';
import { getInstance, loadOrCreateHubConfig } from '../config.js';
import { instancePaths } from '../paths.js';
import { listAgents } from './peer-agent-host.js';
import { PeerAcpClient } from './peer-acp-client.js';
import {
  MAX_PEER_FILE_BYTES,
  normalizePeerAttachmentRefs,
  persistIncomingFile,
  resolveAttachmentsForAcp,
  type IncomingPeerFile,
  type StoredPeerFile,
} from './peer-file-store.js';
import {
  expireStalePendingApprovals,
  getPendingApproval,
  listPendingApprovalsForPeer,
  markPendingApprovalSubmitted,
  pendingApprovalFromRequest,
  savePendingApproval,
} from './peer-pending-approvals.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 120_000;
// In-memory wait must match Cursor's waitForResponse (20 min), not the 24h
// persistence TTL. A lost verdict otherwise leaves the turn hung for a day.
const APPROVAL_TIMEOUT_MS = 20 * 60 * 1000;
// Terminal turn results (done/error) stay replayable this long. Aligned with
// the app's approvalWaitHardCap (25 min): a phone that flapped right as the
// turn ended can still resume and collect the result instead of a false
// 'lost' (which would fail an already-computed turn).
const TURN_RESULT_TTL_MS = 25 * 60 * 1000;

/** Verdict of a phone approval. `migrated` = peer WS flapped mid-approval; the
 * hub keeps the record pending and the verdict will arrive via the deferred
 * relay on a later connection — the (old-connection) turn must NOT relay
 * anything itself. */
interface ApprovalVerdict {
  id: string;
  label?: string;
  migrated?: boolean;
}

/**
 * Peer-level turn registry entry — survives connection teardown. This is what
 * makes turn resume possible: the app's request_id ↔ ACP task_id mapping,
 * the full accumulated stream (resume replays the missing suffix), and the
 * terminal result (done/error) buffered for replay while the peer is away.
 */
interface TurnEntry {
  agentId: string;
  taskId: string;
  status: 'streaming' | 'done' | 'error';
  /** Mirrors the chunk stream sent to the phone (UTF-16 code units, like JS/Dart String.length). */
  accumulated: string;
  done?: { content: string; metadata?: Record<string, unknown> };
  error?: string;
  /** Last ui.messageMetadata seen — resume re-sends it so the app's
   * StreamContentSplitter diversion state survives the flap. */
  lastMetadata?: Record<string, unknown>;
  /** When the turn reached a terminal state — TTL base for the reaper. */
  terminalAt?: number;
}

/** One live connection's routing endpoints. Turn output and approval cards
 * always go to the TOP of the stack (the newest connection); teardown splices
 * its own entry out, so an older connection takes over again (glare-safe). */
interface LiveRoute {
  token: object;
  send: (obj: Record<string, unknown>) => void;
  approvalHandler: (
    requestId: string,
    agentId: string,
    req: {
      confirmationId: string; taskId: string; prompt: string;
      actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
      toolKind?: string; toolCallId?: string;
    },
  ) => Promise<ApprovalVerdict>;
}

/**
 * Peer-scoped state shared across reconnects. A peer WS flap (phone network
 * switch, desktop app resume) must not kill agent work: the hub→proxy acp
 * clients live here rather than in the per-connection closure, so a reconnect
 * reuses them and in-flight agent turns keep running. Closing the last acp WS
 * would make the proxy reject every pending confirmation waiter ('Connection
 * closed') and abort the agent's tasks — that is what stranded agents on
 * [pending] after a 200ms peer flap.
 */
export interface PeerSessionState {
  acpClients: Map<string, PeerAcpClient>;
  /** Number of peer connections currently bound to this peer (drive enter/exit). */
  liveConnections: number;
  /** request_id → turn registry (see TurnEntry). */
  turns: Map<string, TurnEntry>;
  /** Live connection route stack — top = newest. */
  liveRoutes: LiveRoute[];
  /** Approvals raised while NO connection was live. The card is persisted and
   * re-sent on reconnect; the verdict comes back through the deferred relay,
   * which resolves the parked waiter with {migrated:true}. */
  detachedApprovals: Map<string, {
    resolve: (selected: ApprovalVerdict) => void;
    timer: NodeJS.Timeout;
  }>;
}
const peerSessions = new Map<string, PeerSessionState>();

function getPeerSession(peerId: string): PeerSessionState {
  let s = peerSessions.get(peerId);
  if (s === undefined) {
    s = {
      acpClients: new Map(),
      liveConnections: 0,
      turns: new Map(),
      liveRoutes: [],
      detachedApprovals: new Map(),
    };
    peerSessions.set(peerId, s);
  }
  return s;
}

/** Route one frame to the peer's current live connection. No live connection
 * → silently dropped: chunks/metadata are covered by TurnEntry.accumulated /
 * lastMetadata and replayed on resume; done/error are buffered in the entry. */
function routeToPeer(peerSession: PeerSessionState, obj: Record<string, unknown>): void {
  peerSession.liveRoutes.at(-1)?.send(obj);
}

/**
 * Close acp clients of peers that have no live connection and no in-flight
 * turns, and expire buffered terminal turn results. Clients whose turns
 * drained after a disconnect would otherwise linger (one WS + heartbeat per
 * agent) for the lifetime of the daemon.
 * Exported for tests.
 */
export function reapIdlePeerSessions(): void {
  const now = Date.now();
  for (const [peerId, s] of peerSessions) {
    for (const [rid, entry] of s.turns) {
      if (entry.terminalAt !== undefined && now - entry.terminalAt > TURN_RESULT_TTL_MS) {
        s.turns.delete(rid);
      }
    }
    if (s.liveConnections > 0) continue;
    for (const [agentId, client] of s.acpClients) {
      if (client.hasInflightTurns) continue;
      try { client.close(); } catch { /* ignore */ }
      s.acpClients.delete(agentId);
    }
    if (s.acpClients.size === 0 && s.turns.size === 0 && s.detachedApprovals.size === 0) {
      peerSessions.delete(peerId);
    }
  }
}

const reapTimer = setInterval(reapIdlePeerSessions, 60_000);
reapTimer.unref();

/** Test-only: close every peer session and clear the registry. */
export function resetPeerSessionsForTest(): void {
  for (const [, s] of peerSessions) {
    for (const c of s.acpClients.values()) {
      try { c.close(); } catch { /* ignore */ }
    }
    s.acpClients.clear();
    s.turns.clear();
    for (const parked of s.detachedApprovals.values()) {
      clearTimeout(parked.timer);
    }
    s.detachedApprovals.clear();
    s.liveRoutes.length = 0;
    s.liveConnections = 0;
  }
  peerSessions.clear();
}

/** Test-only: direct registry access for white-box assertions (TTL sweeps etc.). */
export function getPeerSessionsForTest(): Map<string, PeerSessionState> {
  return peerSessions;
}

/**
 * Drive one peer connection. Returns when the WS closes. The NoiseSession
 * must already be `ready` (handshake complete).
 */
export async function drivePeerConnection(opts: {
  ws: WebSocket;
  session: NoiseSession;
  peerIdentity: AgentIdentity;
  peerId: string;
  log: (line: string) => void;
}): Promise<void> {
  const { ws, session, peerIdentity, peerId, log } = opts;
  // Persistent ACP clients per agent id — one WS + session per (peer, agent),
  // reused across chat turns AND across peer reconnects (see peerSessions), so
  // a peer flap does not abort in-flight agent turns.
  const peerSession = getPeerSession(peerId);
  peerSession.liveConnections += 1;
  const acpClients = peerSession.acpClients;
  // Pending tool-call approvals: confirmationId → waiter. The phone replies
  // with agent_approval_resp; a peer disconnect MIGRATES the waiter (kept
  // pending for reconnect) — only the 20-min timeout resolves with deny.
  const pendingApprovals = new Map<string, {
    resolve: (selected: ApprovalVerdict) => void;
    timer: NodeJS.Timeout;
  }>();
  // Replies that arrived before requestApproval registered its resolver
  // (loopback race). Consumed when the matching approval_req is set up.
  const earlyApprovalResps = new Map<string, { id: string; label?: string }>();
  const incomingFiles = new Map<string, IncomingPeerFile>();
  const storedFiles = new Map<string, StoredPeerFile>();
  let lastActivity = Date.now();
  let closed = false;

  const send = (obj: Record<string, unknown>): void => {
    if (closed || ws.readyState !== ws.OPEN) return;
    const ct = session.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
    ws.send(encodeFrame({ t: 'data', payload: ct }));
  };

  /** Get or create the persistent ACP client for an agent. */
  const getAcpClient = (agentId: string): PeerAcpClient => {
    let client = acpClients.get(agentId);
    if (client !== undefined) return client;
    const cfg = loadOrCreateHubConfig();
    const instance = getInstance(cfg, agentId);
    const instanceIdentity = loadOrCreateIdentity({ path: instancePaths(instance.id).identityPath });
    client = new PeerAcpClient(peerIdentity, instance, instanceIdentity, log);
    acpClients.set(agentId, client);
    return client;
  };

  /** Relay a tool-call approval to the phone and await its decision. */
  const requestApproval = (
    chatRequestId: string,
    agentId: string,
    req: {
      confirmationId: string; taskId: string; prompt: string;
      actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
      toolKind?: string; toolCallId?: string;
    },
  ): Promise<ApprovalVerdict> => {
    const record = pendingApprovalFromRequest(peerId, chatRequestId, agentId, req);
    try {
      savePendingApproval(record);
    } catch (err) {
      log(`failed to persist pending approval ${req.confirmationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Register the resolver BEFORE sending to the phone. On loopback / fast
    // auto-approve paths the reply can arrive in the same tick; if we send
    // first, approval_resp hits NO MATCH and Cursor stays on [pending].
    return new Promise<ApprovalVerdict>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(req.confirmationId);
        // Mark the persisted record as resolved (deny) — otherwise a reconnect
        // revives this card even though the agent already got the denial, and
        // taps on it fall into the void.
        markPendingApprovalSubmitted(req.confirmationId, '');
        log(`approval ${req.confirmationId} timed out → deny`);
        resolve({ id: '' }); // fail closed
      }, APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(req.confirmationId, {
        timer,
        resolve: (selected) => {
          clearTimeout(timer);
          resolve(selected);
        },
      });
      // Consume a reply that raced in before the resolver was registered.
      const early = earlyApprovalResps.get(req.confirmationId);
      if (early !== undefined) {
        earlyApprovalResps.delete(req.confirmationId);
        pendingApprovals.delete(req.confirmationId);
        clearTimeout(timer);
        markPendingApprovalSubmitted(req.confirmationId, early.id, early.label);
        log(
          `approval_req consumed early resp confirmation=${req.confirmationId} ` +
          `action=${early.id}`,
        );
        resolve(early);
        return;
      }
      send({
        type: 'agent_approval_req',
        approval_id: req.confirmationId,
        request_id: chatRequestId,
        task_id: req.taskId,
        prompt: req.prompt,
        actions: req.actions,
        ...(req.toolKind !== undefined ? { tool_kind: req.toolKind } : {}),
        ...(req.toolCallId !== undefined ? { tool_call_id: req.toolCallId } : {}),
      });
      log(
        `approval_req sent confirmation=${req.confirmationId} chatReq=${chatRequestId} ` +
        `task=${req.taskId} pending=${pendingApprovals.size} actions=${req.actions.length}`,
      );
    });
  };

  /**
   * Approval raised while NO peer connection is live (peer flap mid-turn).
   * Registering the waiter on a dead connection's map is fatal: the card can
   * never be sent, and its 20-min timeout eventually relays a spurious DENY
   * even if the phone already allowed via the re-sent card (deferred relay).
   * Instead: persist the record (resendPendingApprovalsForPeer replays the
   * card on reconnect), park the waiter peer-level, and let the deferred
   * relay resolve it with {migrated:true} — the turn's bookkeeping unwinds
   * without relaying anything itself. 20-min timeout = fail-closed backstop.
   */
  const detachedApproval = (
    chatRequestId: string,
    agentId: string,
    req: {
      confirmationId: string; taskId: string; prompt: string;
      actions: ReadonlyArray<{ id: string; label?: string; style?: string }>;
      toolKind?: string; toolCallId?: string;
    },
  ): Promise<ApprovalVerdict> => {
    const record = pendingApprovalFromRequest(peerId, chatRequestId, agentId, req);
    try {
      savePendingApproval(record);
    } catch (err) {
      log(`failed to persist pending approval ${req.confirmationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(
      `detached approval parked confirmation=${req.confirmationId} chatReq=${chatRequestId} ` +
      `task=${req.taskId} (no live connection — card replays on reconnect)`,
    );
    return new Promise<ApprovalVerdict>((resolve) => {
      const timer = setTimeout(() => {
        peerSession.detachedApprovals.delete(req.confirmationId);
        markPendingApprovalSubmitted(req.confirmationId, '');
        log(`detached approval ${req.confirmationId} timed out → deny`);
        resolve({ id: '' }); // fail closed
      }, APPROVAL_TIMEOUT_MS);
      peerSession.detachedApprovals.set(req.confirmationId, {
        timer,
        resolve: (selected) => {
          clearTimeout(timer);
          resolve(selected);
        },
      });
    });
  };

  const handleDeferredApprovalResp = async (
    approvalId: string,
    selectedActionId: string,
    selectedActionLabel: string | undefined,
  ): Promise<void> => {
    const record = getPendingApproval(approvalId);
    if (record === undefined || record.status !== 'pending') {
      log(`approval_resp deferred miss confirmation=${approvalId}`);
      return;
    }
    if (record.peerId !== peerId) {
      log(`approval_resp deferred peer mismatch confirmation=${approvalId}`);
      return;
    }
    let client: PeerAcpClient;
    try {
      client = getAcpClient(record.agentId);
    } catch (err) {
      log(`approval_resp deferred client error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const ok = await client.submitDeferredApproval(
      record.taskId,
      record.approvalId,
      { id: selectedActionId, label: selectedActionLabel },
    );
    if (ok) {
      markPendingApprovalSubmitted(approvalId, selectedActionId, selectedActionLabel);
      log(`approval_resp deferred relayed confirmation=${approvalId}`);
      // Wake a parked (detached) waiter, if any — the verdict is delivered,
      // the turn only needs its bookkeeping unwound ({migrated} skips a
      // duplicate submitResponse).
      const parked = peerSession.detachedApprovals.get(approvalId);
      if (parked !== undefined) {
        clearTimeout(parked.timer);
        peerSession.detachedApprovals.delete(approvalId);
        parked.resolve({ id: selectedActionId, label: selectedActionLabel, migrated: true });
        log(`detached approval resolved confirmation=${approvalId} action=${selectedActionId}`);
      }
    }
  };

  const resendPendingApprovalsForPeer = (): void => {
    const pending = listPendingApprovalsForPeer(peerId);
    for (const record of pending) {
      send({
        type: 'agent_approval_req',
        approval_id: record.approvalId,
        request_id: record.requestId,
        task_id: record.taskId,
        prompt: record.prompt,
        actions: record.actions,
        ...(record.toolKind !== undefined ? { tool_kind: record.toolKind } : {}),
        ...(record.toolCallId !== undefined ? { tool_call_id: record.toolCallId } : {}),
      });
    }
    if (pending.length > 0) {
      log(`re-sent ${pending.length} pending approval(s) to peer ${peerId}`);
    }
  };

  expireStalePendingApprovals();
  resendPendingApprovalsForPeer();

  // Register this connection as the peer's live route — turn output and
  // approval cards always go to the stack top (newest connection). Teardown
  // splices this entry out by token (glare-safe).
  const connToken = {};
  peerSession.liveRoutes.push({
    token: connToken,
    send,
    approvalHandler: (requestId, agentId, a) => requestApproval(requestId, agentId, a),
  });

  /** App requests the slash-command palette for an agent. */
  const handleAgentCommandsReq = async (params: Record<string, unknown>): Promise<void> => {
    const agentId = params.agent_id as string | undefined;
    if (typeof agentId !== 'string') return;
    let commands: unknown[] = [];
    try {
      commands = await getAcpClient(agentId).commands();
    } catch (err) {
      log(`agent_commands req failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({ type: 'agent_commands_resp', agent_id: agentId, commands });
  };

  /** App requests the agent's known sessions so it can mirror them locally. */
  const handleAgentSessionsReq = async (params: Record<string, unknown>): Promise<void> => {
    const agentId = params.agent_id as string | undefined;
    if (typeof agentId !== 'string') return;
    let sessions: unknown[] = [];
    try {
      sessions = await getAcpClient(agentId).sessions();
    } catch (err) {
      log(`agent_sessions req failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({ type: 'agent_sessions_resp', agent_id: agentId, sessions });
  };

  /** App requests a session's transcript so it can backfill local history. */
  const handleAgentSessionHistoryReq = async (params: Record<string, unknown>): Promise<void> => {
    const agentId = params.agent_id as string | undefined;
    const sessionId = params.session_id as string | undefined;
    if (typeof agentId !== 'string' || typeof sessionId !== 'string') return;
    let messages: unknown[] = [];
    try {
      messages = await getAcpClient(agentId).sessionHistory(sessionId);
    } catch (err) {
      log(`agent_session_history req failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({ type: 'agent_session_history_resp', agent_id: agentId, session_id: sessionId, messages });
  };

  /** App requests upstream model list (agent.models.list relay). */
  const handleAgentModelsReq = async (params: Record<string, unknown>): Promise<void> => {
    const agentId = params.agent_id as string | undefined;
    if (typeof agentId !== 'string') return;
    const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
    let models: unknown[] = [];
    let current: string | undefined;
    try {
      const result = await getAcpClient(agentId).modelsList(sessionId);
      models = result.models;
      current = result.current;
    } catch (err) {
      log(`agent_models req failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({
      type: 'agent_models_resp',
      agent_id: agentId,
      models,
      ...(current !== undefined ? { current } : {}),
    });
  };

  /** App switches upstream model (agent.models.setCurrent relay). */
  const handleAgentModelsSetReq = async (params: Record<string, unknown>): Promise<void> => {
    const agentId = params.agent_id as string | undefined;
    const model = params.model as string | undefined;
    if (typeof agentId !== 'string' || typeof model !== 'string' || model.length === 0) return;
    const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
    let ok = false;
    let displayName: string | undefined;
    try {
      const result = await getAcpClient(agentId).modelsSetCurrent(model, sessionId);
      ok = result !== null;
      displayName = result?.display_name;
    } catch (err) {
      log(`agent_models_set req failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    send({
      type: 'agent_models_set_resp',
      agent_id: agentId,
      model,
      ok,
      ...(displayName !== undefined ? { display_name: displayName } : {}),
    });
  };

  const handleAgentChat = async (params: Record<string, unknown>): Promise<void> => {
    const requestId = params.request_id as string | undefined;
    const agentId = params.agent_id as string | undefined;
    const message = params.message as string | undefined;
    if (requestId === undefined || agentId === undefined || typeof message !== 'string') {
      send({ type: 'agent_error', request_id: requestId ?? '', message: 'invalid agent_chat params' });
      return;
    }
    if (peerSession.turns.has(requestId)) {
      // A retried agent_chat with a live request_id must not start a second
      // ACP turn — the original keeps running and stays resumable.
      log(`agent_chat duplicate request_id=${requestId} — rejected`);
      send({ type: 'agent_error', request_id: requestId, message: 'duplicate request_id' });
      return;
    }
    const sessionHint = typeof params.session_id === 'string' && params.session_id.length > 0
      ? params.session_id.slice(0, 8)
      : '(default)';
    log(`agent_chat req=${requestId} agent=${agentId} session=${sessionHint}`);
    let client: PeerAcpClient;
    try {
      client = getAcpClient(agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ type: 'agent_error', request_id: requestId, message: msg });
      return;
    }
    // Register the turn in the peer-level registry BEFORE starting it: output
    // routes through liveRoutes to the current live connection, so a flap
    // neither loses the stream (accumulated replays on resume) nor the result
    // (done/error buffered with TTL).
    const taskId = randomUUID();
    const entry: TurnEntry = { agentId, taskId, status: 'streaming', accumulated: '' };
    peerSession.turns.set(requestId, entry);
    const finishDone = (content: string, metadata?: Record<string, unknown>): void => {
      entry.status = 'done';
      entry.done = { content, metadata };
      entry.terminalAt = Date.now();
      log(`agent_done req=${requestId}`);
      routeToPeer(peerSession, { type: 'agent_done', request_id: requestId, content, ...(metadata ? { metadata } : {}) });
    };
    const finishError = (msg: string): void => {
      entry.status = 'error';
      entry.error = msg;
      entry.terminalAt = Date.now();
      log(`agent_error req=${requestId}: ${msg}`);
      routeToPeer(peerSession, { type: 'agent_error', request_id: requestId, message: msg });
    };
    try {
      const refs = normalizePeerAttachmentRefs(params.attachments);
      const attachments = resolveAttachmentsForAcp(agentId, refs, storedFiles);
      await client.chat(
        {
          message,
          sessionId: params.session_id as string | undefined,
          taskId,
          attachments,
        },
        {
          onChunk: (content) => {
            entry.accumulated += content;
            routeToPeer(peerSession, { type: 'agent_chunk', request_id: requestId, content });
          },
          onMetadata: (metadata) => {
            entry.lastMetadata = metadata;
            routeToPeer(peerSession, { type: 'agent_metadata', request_id: requestId, metadata });
          },
          onDone: finishDone,
          onError: finishError,
          // Approvals go to the current live connection; with none (peer away),
          // park them — a dead connection's waiter would eventually relay a
          // spurious deny (E1).
          onApproval: (a) => {
            const live = peerSession.liveRoutes.at(-1);
            return live !== undefined
              ? live.approvalHandler(requestId, agentId, a)
              : detachedApproval(requestId, agentId, a);
          },
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`agent_chat req=${requestId} threw: ${msg}`);
      // Connection/handshake failure — drop the client so the next chat retries.
      acpClients.delete(agentId);
      try { client.close(); } catch { /* ignore */ }
      finishError(msg);
    }
  };

  /**
   * Resume a turn after a reconnect. MUST stay fully synchronous (no await):
   * the single-threaded interleaving guarantee is what prevents chunk/done
   * from racing the response. Delta semantics: accumulated is a UTF-16 code
   * unit stream byte-aligned with the app's received chunks, so
   * `slice(known_content_length)` is exactly what the phone missed. The app
   * additionally drop-prefixes against late live chunks, making duplicate
   * resume requests idempotent.
   */
  const handleTurnResumeReq = (requestId: string, knownContentLength: number): void => {
    const entry = peerSession.turns.get(requestId);
    if (entry === undefined) {
      log(`turn resume req=${requestId} → lost (unknown/expired)`);
      send({ type: 'agent_turn_resume_resp', request_id: requestId, status: 'lost', message: '对端任务已结束或丢失（hub 重启或已过期）' });
      return;
    }
    const base = Math.max(0, Math.min(knownContentLength, entry.accumulated.length));
    if (base !== knownContentLength) {
      log(`turn resume req=${requestId} known=${knownContentLength} out of range — clamped to ${base}`);
    }
    const delta = entry.accumulated.slice(base);
    if (entry.status === 'streaming') {
      log(`turn resume req=${requestId} → streaming, replaying ${delta.length} units`);
      send({
        type: 'agent_turn_resume_resp',
        request_id: requestId,
        status: 'streaming',
        delta,
        ...(entry.lastMetadata !== undefined ? { stream_metadata: entry.lastMetadata } : {}),
      });
      return;
    }
    if (entry.status === 'done') {
      log(`turn resume req=${requestId} → done, replaying ${delta.length} units + result`);
      send({
        type: 'agent_turn_resume_resp',
        request_id: requestId,
        status: 'done',
        delta,
        content: entry.done!.content,
        ...(entry.done!.metadata !== undefined ? { metadata: entry.done!.metadata } : {}),
      });
      return;
    }
    log(`turn resume req=${requestId} → error, replaying ${delta.length} units + error`);
    send({
      type: 'agent_turn_resume_resp',
      request_id: requestId,
      status: 'error',
      delta,
      message: entry.error ?? 'agent error',
    });
  };

  const handleFileBegin = (params: Record<string, unknown>): void => {
    const fileId = params.file_id as string | undefined;
    const agentId = params.agent_id as string | undefined;
    const fileName = (params.file_name as string | undefined) ?? 'file';
    const mimeType = (params.mime_type as string | undefined) ?? 'application/octet-stream';
    const semanticType =
      (params.file_type as string | undefined) ??
      (params.semantic_type as string | undefined) ??
      'file';
    const size = typeof params.size === 'number' ? params.size : 0;
    if (fileId === undefined || agentId === undefined) return;
    if (size <= 0 || size > MAX_PEER_FILE_BYTES) {
      send({ type: 'agent_file_error', file_id: fileId, message: `invalid or oversized file (${size} bytes)` });
      return;
    }
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ type: 'agent_file_error', file_id: fileId, message: msg });
      return;
    }
    incomingFiles.set(fileId, {
      agentId,
      fileId,
      fileName,
      mimeType,
      semanticType,
      size,
      chunks: new Map(),
    });
    send({ type: 'agent_file_ack', file_id: fileId, ok: true, stage: 'begin' });
  };

  const handleFileChunk = (params: Record<string, unknown>): void => {
    const fileId = params.file_id as string | undefined;
    const index = params.index as number | undefined;
    const data = params.data as string | undefined;
    if (fileId === undefined || index === undefined || typeof data !== 'string') return;
    const incoming = incomingFiles.get(fileId);
    if (incoming === undefined) return;
    try {
      incoming.chunks.set(index, Buffer.from(data, 'base64'));
    } catch (err) {
      incomingFiles.delete(fileId);
      send({
        type: 'agent_file_error',
        file_id: fileId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleFileEnd = (params: Record<string, unknown>): void => {
    const fileId = params.file_id as string | undefined;
    const chunkCount = typeof params.chunk_count === 'number' ? params.chunk_count : 0;
    if (fileId === undefined) return;
    const incoming = incomingFiles.get(fileId);
    incomingFiles.delete(fileId);
    if (incoming === undefined) {
      send({ type: 'agent_file_ack', file_id: fileId, ok: false, stage: 'end', error: 'unknown file_id' });
      return;
    }
    try {
      const stored = persistIncomingFile(incoming, chunkCount);
      storedFiles.set(fileId, stored);
      send({ type: 'agent_file_ack', file_id: fileId, ok: true, stage: 'end' });
      log(`agent_file stored file_id=${fileId} path=${stored.absPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`agent_file_end failed: ${msg}`);
      send({ type: 'agent_file_ack', file_id: fileId, ok: false, stage: 'end', error: msg });
    }
  };

  const onMessage = (data: WebSocket.RawData): void => {
    lastActivity = Date.now();
    try {
      const frame = decodeFrame(data.toString('utf-8'));
      if (frame.t !== 'data') return;
      const plaintext = session.decrypt(frame.payload);
      const obj = JSON.parse(Buffer.from(plaintext).toString('utf-8')) as Record<string, unknown>;
      const type = obj.type as string | undefined;
      switch (type) {
        case 'ping':
          send({ type: 'pong', timestamp: Date.now() });
          break;
        case 'pong':
          break;
        case 'agent_list_req':
          send({ type: 'agent_list_resp', agents: listAgents() });
          break;
        case 'agent_commands_req':
          void handleAgentCommandsReq(obj);
          break;
        case 'agent_sessions_req':
          void handleAgentSessionsReq(obj);
          break;
        case 'agent_session_history_req':
          void handleAgentSessionHistoryReq(obj);
          break;
        case 'agent_models_req':
          void handleAgentModelsReq(obj);
          break;
        case 'agent_models_set_req':
          void handleAgentModelsSetReq(obj);
          break;
        case 'agent_chat':
          void handleAgentChat(obj as Record<string, unknown>);
          break;
        case 'agent_file_begin':
          handleFileBegin(obj);
          break;
        case 'agent_file_chunk':
          handleFileChunk(obj);
          break;
        case 'agent_file_end':
          handleFileEnd(obj);
          break;
        case 'agent_cancel': {
          const rid = obj.request_id as string | undefined;
          if (rid !== undefined) {
            // Route via the peer-level turn registry — works from ANY live
            // connection (the turn may have started on a dead one).
            const entry = peerSession.turns.get(rid);
            if (entry !== undefined && entry.status === 'streaming') {
              log(`agent_cancel req=${rid} → cancelTurn task=${entry.taskId}`);
              peerSession.acpClients.get(entry.agentId)?.cancelTurn(entry.taskId);
            }
          }
          break;
        }
        case 'agent_turn_resume_req': {
          const rid = obj.request_id as string | undefined;
          const known = obj.known_content_length;
          if (rid !== undefined) {
            handleTurnResumeReq(rid, typeof known === 'number' ? known : 0);
          }
          break;
        }
        case 'agent_approval_resp': {
          // Phone user's tool-call decision; resolve the pending approval.
          const aid = obj.approval_id as string | undefined;
          const sel = obj.selected_action_id as string | undefined;
          const label = obj.selected_action_label as string | undefined;
          if (aid !== undefined) {
            const waiter = pendingApprovals.get(aid);
            if (waiter !== undefined) {
              pendingApprovals.delete(aid);
              markPendingApprovalSubmitted(aid, sel ?? '', label);
              log(
                `approval_resp confirmation=${aid} → ${sel && sel.length > 0 ? 'allow' : 'deny'} ` +
                `action=${sel ?? ''} label=${label ?? ''} remaining=${pendingApprovals.size}`,
              );
              waiter.resolve({ id: sel ?? '', label });
            } else {
              // Buffer briefly in case the reply raced ahead of requestApproval's
              // resolver registration; otherwise fall through to deferred relay.
              earlyApprovalResps.set(aid, { id: sel ?? '', label });
              setTimeout(() => {
                if (!earlyApprovalResps.has(aid)) return;
                earlyApprovalResps.delete(aid);
                log(
                  `approval_resp NO MATCH confirmation=${aid} action=${sel ?? ''} ` +
                  `pendingKeys=[${[...pendingApprovals.keys()].join(', ')}] → deferred relay`,
                );
                void handleDeferredApprovalResp(aid, sel ?? '', label);
              }, 250);
            }
          }
          break;
        }
        case 'message':
        case 'ack':
          // Phase 1: no chat persistence; acknowledged but ignored.
          break;
        default:
          log(`unknown peer message type: ${String(type)}`);
      }
    } catch {
      /* drop malformed frame */
    }
  };

  ws.on('message', onMessage);

  // Heartbeat: send ping every 30s; if no activity for 120s, close.
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastActivity > LIVENESS_TIMEOUT_MS) {
      log('peer liveness timeout, closing');
      try { ws.close(); } catch { /* ignore */ }
      return;
    }
    try {
      send({ type: 'ping', timestamp: Date.now() });
    } catch {
      /* send failure — will be caught by close handler */
    }
  }, HEARTBEAT_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    const teardown = (): void => {
      closed = true;
      clearInterval(heartbeat);
      peerSession.liveConnections = Math.max(0, peerSession.liveConnections - 1);
      // Remove this connection from the route stack by token — an older
      // (glare) connection takes over as the new top.
      const i = peerSession.liveRoutes.findIndex((r) => r.token === connToken);
      if (i >= 0) peerSession.liveRoutes.splice(i, 1);
      // A peer WS flap must NOT kill agent work. In-memory approval waiters
      // are MIGRATED ({migrated}) so turn bookkeeping unwinds without sending
      // a verdict; persisted records stay 'pending' — the card replays on
      // reconnect and the late tap is delivered via the deferred relay on the
      // still-open acp client. Turn registry entries are untouched: their
      // stream keeps accumulating and the result is replayable on resume.
      for (const [id, waiter] of pendingApprovals) {
        log(`peer disconnect → migrate approval ${id} (kept pending)`);
        clearTimeout(waiter.timer);
        try { waiter.resolve({ id: '', migrated: true }); } catch { /* ignore */ }
      }
      pendingApprovals.clear();
      // earlyApprovalResps intentionally NOT cleared: its 250ms timers fire
      // after teardown and route through the deferred relay (shared acp client
      // is still open), so a verdict that raced the flap is still delivered.
      resolve();
    };
    ws.once('close', () => { log(`peer ${peerId} disconnected`); teardown(); });
    ws.once('error', teardown);
  });
}
