/**
 * One established peer connection (post-handshake).
 *
 * Wraps a ready NoiseSession + WebSocket, decrypts incoming `data` frames,
 * routes by JSON `type`, and encrypts outgoing messages. Implements the
 * app's peer-channel protocol: `ping/pong` heartbeat, `agent_list_*`, and
 * `agent_chat/chunk/done/error/cancel` proxied to local ACP agents.
 */

import { WebSocket } from 'ws';
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

interface InflightChat {
  shouldCancel: boolean;
}

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
 * Peer-scoped state shared across reconnects. A peer WS flap (phone network
 * switch, desktop app resume) must not kill agent work: the hub→proxy acp
 * clients live here rather than in the per-connection closure, so a reconnect
 * reuses them and in-flight agent turns keep running. Closing the last acp WS
 * would make the proxy reject every pending confirmation waiter ('Connection
 * closed') and abort the agent's tasks — that is what stranded agents on
 * [pending] after a 200ms peer flap.
 */
interface PeerSessionState {
  acpClients: Map<string, PeerAcpClient>;
  /** Number of peer connections currently bound to this peer (drive enter/exit). */
  liveConnections: number;
}
const peerSessions = new Map<string, PeerSessionState>();

function getPeerSession(peerId: string): PeerSessionState {
  let s = peerSessions.get(peerId);
  if (s === undefined) {
    s = { acpClients: new Map(), liveConnections: 0 };
    peerSessions.set(peerId, s);
  }
  return s;
}

/**
 * Close acp clients of peers that have no live connection and no in-flight
 * turns. Clients whose turns drained after a disconnect would otherwise linger
 * (one WS + heartbeat per agent) for the lifetime of the daemon.
 * Exported for tests.
 */
export function reapIdlePeerSessions(): void {
  for (const [peerId, s] of peerSessions) {
    if (s.liveConnections > 0) continue;
    for (const [agentId, client] of s.acpClients) {
      if (client.hasInflightTurns) continue;
      try { client.close(); } catch { /* ignore */ }
      s.acpClients.delete(agentId);
    }
    if (s.acpClients.size === 0) peerSessions.delete(peerId);
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
  }
  peerSessions.clear();
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
  const inflight = new Map<string, InflightChat>();
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
    const state: InflightChat = { shouldCancel: false };
    inflight.set(requestId, state);
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
      inflight.delete(requestId);
      return;
    }
    try {
      const refs = normalizePeerAttachmentRefs(params.attachments);
      const attachments = resolveAttachmentsForAcp(agentId, refs, storedFiles);
      await client.chat(
        {
          message,
          sessionId: params.session_id as string | undefined,
          shouldCancel: () => state.shouldCancel,
          attachments,
        },
        {
          onChunk: (content) => send({ type: 'agent_chunk', request_id: requestId, content }),
          onMetadata: (metadata) => send({ type: 'agent_metadata', request_id: requestId, metadata }),
          onDone: (content, metadata) => { log(`agent_done req=${requestId}`); send({ type: 'agent_done', request_id: requestId, content, ...(metadata ? { metadata } : {}) }); },
          onError: (msg) => { log(`agent_error req=${requestId}: ${msg}`); send({ type: 'agent_error', request_id: requestId, message: msg }); },
          onApproval: (a) => requestApproval(requestId, agentId, a),
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`agent_chat req=${requestId} threw: ${msg}`);
      // Connection/handshake failure — drop the client so the next chat retries.
      acpClients.delete(agentId);
      try { client.close(); } catch { /* ignore */ }
      send({ type: 'agent_error', request_id: requestId, message: msg });
    } finally {
      inflight.delete(requestId);
    }
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
            const s = inflight.get(rid);
            if (s !== undefined) s.shouldCancel = true;
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
      // A peer WS flap must NOT kill agent work. The previous behaviour —
      // resolve every waiter with deny + mark the record submitted + close all
      // acp clients — destroyed every recovery path at once: late taps hit
      // NO MATCH / deferred miss, the deny relay always failed on the
      // just-closed client, and the proxy aborted the agent's tasks when its
      // last hub WS went away.
      // Instead, MIGRATE in-memory waiters: resolve with {migrated} so turn
      // bookkeeping unwinds without sending a verdict; the persisted record
      // stays 'pending' so a reconnect re-sends the card and the late tap is
      // delivered via the deferred relay on the still-open acp client. The
      // acp clients themselves survive (peer-scoped) — the idle reaper closes
      // them once their turns drain. Fail-closed backstop stays with the
      // 20-min proxy confirmation timeout + record expiry.
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
