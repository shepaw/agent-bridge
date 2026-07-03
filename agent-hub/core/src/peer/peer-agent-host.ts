/**
 * Agent-host proxy: bridges peer-channel `agent_chat` requests to the hub's
 * local ACP agents.
 *
 * The peer service is a Noise IK *initiator* toward each managed instance's
 * `/acp/ws` gateway. For each `agent_chat` it opens a one-shot connection,
 * sends `agent.chat`, and relays the streaming `ui.textContent` / `task.*`
 * notifications back as `agent_chunk` / `agent_done` / `agent_error`.
 *
 * Auth: the peer service's static pubkey is injected into every instance's
 * `authorized_peers.json` at spawn time (see spawn.ts), so it connects without
 * an enrollment code.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  decodeFrame,
  encodeFrame,
  loadOrCreateIdentity,
  NoiseSession,
  NOISE_PROLOGUE,
} from 'shepaw-acp-sdk';
import type { AgentIdentity } from 'shepaw-acp-sdk';
import { getInstance, loadOrCreateHubConfig } from '../config.js';
import { instancePaths } from '../paths.js';
import type { InstanceConfig } from '../config.js';

export interface AgentListEntry {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly running: boolean;
}

export interface ChatHandlers {
  onChunk: (content: string) => void;
  onDone: (fullContent: string, metadata?: Record<string, unknown>) => void;
  onError: (message: string) => void;
}

export interface ChatRequest {
  readonly agentId: string;
  readonly message: string;
  readonly sessionId?: string;
  /** Caller-provided cancel signal. */
  readonly shouldCancel: () => boolean;
}

/** List managed instances as `agent_list_resp` entries. */
export function listAgents(): AgentListEntry[] {
  const cfg = loadOrCreateHubConfig();
  return cfg.instances.map((i) => ({
    id: i.id,
    name: i.label || i.id,
    engine: i.engine,
    running: false,
  }));
}

/**
 * Run one chat turn against a local instance. Opens a WS to the instance's
 * `/acp/ws`, does the Noise IK initiator handshake, sends `agent.chat`, and
 * streams the response via the handlers. Resolves when the turn ends
 * (task.completed / task.error / ws close). Throws on connection/handshake
 * failure before any streaming starts.
 */
export async function chatWithInstance(
  peerIdentity: AgentIdentity,
  req: ChatRequest,
  handlers: ChatHandlers,
): Promise<void> {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, req.agentId);
  const instanceIdentity = loadOrCreateIdentity({ path: instancePaths(instance.id).identityPath });

  const url = `ws://127.0.0.1:${instance.port}/acp/ws`;
  const session = NoiseSession.initiator({
    staticPublicKey: peerIdentity.staticPublicKey,
    staticPrivateKey: peerIdentity.staticPrivateKey,
    remoteStaticPublicKey: instanceIdentity.staticPublicKey,
    prologue: NOISE_PROLOGUE,
  });

  const ws = new WebSocket(url);
  let taskId = randomUUID();
  let rpcId = 1;
  let resolved = false;
  let accumulated = '';
  let metadata: Record<string, unknown> | undefined;

  const close = (code?: number): void => {
    if (!resolved) {
      resolved = true;
      try { ws.close(code); } catch { /* ignore */ }
    }
  };

  const send = (obj: Record<string, unknown>): void => {
    const ct = session.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
    ws.send(encodeFrame({ t: 'data', payload: ct }));
  };

  try {
    // 1. Open WS + send Noise msg1 (no enroll — peer service is pre-authorized).
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off('error', reject);
        const msg1Payload = JSON.stringify({ agentId: instanceIdentity.agentId, clientVersion: 'shepaw-hub-peer/1.0' });
        const msg1 = session.writeHandshake1(Buffer.from(msg1Payload, 'utf-8'));
        ws.send(encodeFrame({ t: 'hs', payload: msg1 }));
        resolve();
      };
      ws.once('open', onOpen);
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`ws closed before open (code ${code})`)));
    });

    // Wait for msg2 (10s handshake timeout).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMsg);
        ws.off('close', onClose);
        reject(new Error('agent handshake timeout (no msg2)'));
      }, 10_000);
      const cleanup = (): void => { clearTimeout(timer); };
      const onMsg = (data: WebSocket.RawData): void => {
        try {
          const frame = decodeFrame(data.toString('utf-8'));
          if (frame.t !== 'hs') {
            cleanup();
            reject(new Error(`expected hs frame, got ${frame.t}`));
            return;
          }
          session.readHandshake2(frame.payload);
          cleanup();
          ws.off('message', onMsg);
          ws.off('close', onClose);
          resolve();
        } catch (err) {
          cleanup();
          ws.off('message', onMsg);
          ws.off('close', onClose);
          reject(err);
        }
      };
      const onClose = (code: number): void => {
        cleanup();
        reject(new Error(`ws closed during handshake (code ${code})`));
      };
      ws.on('message', onMsg);
      ws.once('close', onClose);
    });

    // 2. Send agent.chat.
    taskId = randomUUID();
    const sessionId = req.sessionId ?? taskId;
    send({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'agent.chat',
      params: {
        task_id: taskId,
        session_id: sessionId,
        message: req.message,
        user_id: 'peer-service',
        ui_component_version: 'v2',
      },
    });

    // 3. Pump notifications until turn ends.
    await new Promise<void>((resolve) => {
      const onMsg = (data: WebSocket.RawData): void => {
        if (resolved) return;
        try {
          const frame = decodeFrame(data.toString('utf-8'));
          if (frame.t !== 'data') return;
          const plaintext = session.decrypt(frame.payload);
          const obj = JSON.parse(Buffer.from(plaintext).toString('utf-8')) as Record<string, unknown>;
          const method = obj.method as string | undefined;

          // Handle the ack response (has id) — nothing to do.
          if (obj.id !== undefined) return;

          if (method === 'ui.textContent') {
            const params = obj.params as Record<string, unknown> | undefined;
            const content = (params?.content as string | undefined) ?? '';
            const isFinal = params?.is_final === true;
            if (!isFinal && content.length > 0) {
              accumulated += content;
              handlers.onChunk(content);
            }
            return;
          }
          if (method === 'task.completed') {
            metadata = obj.params as Record<string, unknown> | undefined;
            resolved = true;
            handlers.onDone(accumulated, metadata);
            close();
            resolve();
            return;
          }
          if (method === 'task.error') {
            const params = obj.params as Record<string, unknown> | undefined;
            const msg = (params?.message as string | undefined) ?? 'agent error';
            resolved = true;
            handlers.onError(msg);
            close();
            resolve();
            return;
          }
          // Other notifications (task.started, ui.* interactive) ignored in Phase 1.
        } catch {
          /* permissive — drop malformed frame */
        }
      };
      ws.on('message', onMsg);
      ws.once('close', () => {
        if (!resolved) {
          resolved = true;
          // If we already streamed chunks, treat close as done; else error.
          if (accumulated.length > 0) handlers.onDone(accumulated, metadata);
          else handlers.onError('connection closed before completion');
          resolve();
        }
      });

      // Cancel polling.
      const cancelTimer = setInterval(() => {
        if (req.shouldCancel() && !resolved) {
          clearInterval(cancelTimer);
          try {
            send({ jsonrpc: '2.0', id: rpcId++, method: 'agent.cancelTask', params: { task_id: taskId } });
          } catch {
            /* ignore */
          }
        }
      }, 200);
      // Stop the cancel poll when we resolve.
      const origResolve = resolve;
      resolve = ((v: void) => { clearInterval(cancelTimer); origResolve(v); }) as typeof resolve;
    });
  } finally {
    close();
  }
}

/** Resolve an instance config by id (for the host to map agent_id → port). */
export function resolveInstance(agentId: string): InstanceConfig {
  return getInstance(loadOrCreateHubConfig(), agentId);
}
