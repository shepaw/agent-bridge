/**
 * One established peer connection (post-handshake).
 *
 * Wraps a ready NoiseSession + WebSocket, decrypts incoming `data` frames,
 * routes by JSON `type`, and encrypts outgoing messages. Implements the
 * app's peer-channel protocol: `ping/pong` heartbeat, `agent_list_*`, and
 * `agent_chat/chunk/done/error/cancel` proxied to local ACP agents.
 */

import { WebSocket } from 'ws';
import { decodeFrame, encodeFrame, NoiseSession } from 'shepaw-acp-sdk';
import type { AgentIdentity } from 'shepaw-acp-sdk';
import { chatWithInstance, listAgents } from './peer-agent-host.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 120_000;

interface InflightChat {
  shouldCancel: boolean;
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
  let lastActivity = Date.now();
  let closed = false;

  const send = (obj: Record<string, unknown>): void => {
    if (closed || ws.readyState !== ws.OPEN) return;
    const ct = session.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
    ws.send(encodeFrame({ t: 'data', payload: ct }));
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
    try {
      await chatWithInstance(
        peerIdentity,
        { agentId, message, sessionId: params.session_id as string | undefined, shouldCancel: () => state.shouldCancel },
        {
          onChunk: (content) => send({ type: 'agent_chunk', request_id: requestId, content }),
          onDone: (content, metadata) => send({ type: 'agent_done', request_id: requestId, content, ...(metadata ? { metadata } : {}) }),
          onError: (msg) => send({ type: 'agent_error', request_id: requestId, message: msg }),
        },
      );
    } catch (err) {
      send({ type: 'agent_error', request_id: requestId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight.delete(requestId);
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
        case 'agent_chat':
          void handleAgentChat(obj as Record<string, unknown>);
          break;
        case 'agent_cancel': {
          const rid = obj.request_id as string | undefined;
          if (rid !== undefined) {
            const s = inflight.get(rid);
            if (s !== undefined) s.shouldCancel = true;
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
    ws.once('close', () => {
      closed = true;
      clearInterval(heartbeat);
      log(`peer ${peerId} disconnected`);
      resolve();
    });
    ws.once('error', () => {
      closed = true;
      clearInterval(heartbeat);
      resolve();
    });
  });
}
