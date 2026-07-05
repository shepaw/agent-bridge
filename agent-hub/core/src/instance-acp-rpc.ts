/**
 * ACP RPC calls to a running instance gateway (sessions list / history).
 *
 * Reuses one PeerAcpClient per instance across Dashboard REST requests and
 * closes idle connections after a grace period, avoiding a full WS handshake
 * on every poll.
 */

import { loadOrCreateIdentity } from 'shepaw-acp-sdk';
import type { SessionHistoryMessage, SessionInfo } from 'shepaw-acp-sdk';

import type { InstanceConfig } from './config.js';
import { getInstance, loadOrCreateHubConfig } from './config.js';
import { instancePaths } from './paths.js';
import { authorizePeerServiceOnInstance } from './peer/peer-auth.js';
import { loadOrCreatePeerIdentity } from './peer/peer-identity.js';
import { PeerAcpClient } from './peer/peer-acp-client.js';
import { probeInstanceRuntime } from './runtime-status.js';

/** Close pooled WS when unused for this long (Dashboard polls every 30s). */
const IDLE_CLOSE_MS = 120_000;

export class InstanceGatewayOfflineError extends Error {
  constructor(
    readonly instanceId: string,
    detail?: string,
  ) {
    super(detail ?? `Instance "${instanceId}" gateway is not online.`);
    this.name = 'InstanceGatewayOfflineError';
  }
}

interface PoolEntry {
  client: PeerAcpClient;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const pool = new Map<string, PoolEntry>();
const creating = new Map<string, Promise<PoolEntry>>();

function parseSessionInfo(raw: unknown): SessionInfo | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const session_id = typeof obj.session_id === 'string' ? obj.session_id : undefined;
  if (session_id === undefined || session_id.length === 0) return null;
  return {
    session_id,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : undefined,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
  };
}

function parseHistoryMessage(raw: unknown): SessionHistoryMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const role = obj.role === 'user' || obj.role === 'agent' ? obj.role : undefined;
  const content = typeof obj.content === 'string' ? obj.content : undefined;
  if (role === undefined || content === undefined) return null;
  return {
    role,
    content,
    message_id: typeof obj.message_id === 'string' ? obj.message_id : undefined,
  };
}

async function ensureGatewayOnline(instanceId: string, instance: InstanceConfig): Promise<void> {
  const runtime = await probeInstanceRuntime(instance);
  if (runtime.availability !== 'online' && runtime.availability !== 'degraded') {
    closeInstanceAcpRpcClient(instanceId);
    throw new InstanceGatewayOfflineError(
      instanceId,
      runtime.probeError ?? `Gateway is ${runtime.availability}. Start the instance to view sessions.`,
    );
  }
}

function scheduleIdleClose(instanceId: string, entry: PoolEntry): void {
  if (entry.refs > 0) return;
  entry.idleTimer = setTimeout(() => {
    if (pool.get(instanceId) === entry) {
      closeInstanceAcpRpcClient(instanceId);
    }
  }, IDLE_CLOSE_MS);
}

async function createPoolEntry(instanceId: string): Promise<PoolEntry> {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  await ensureGatewayOnline(instanceId, instance);
  authorizePeerServiceOnInstance(instanceId, cfg);

  const peerIdentity = loadOrCreatePeerIdentity();
  const instanceIdentity = loadOrCreateIdentity({ path: instancePaths(instance.id).identityPath });
  const client = new PeerAcpClient(peerIdentity, instance, instanceIdentity, () => {});
  const entry: PoolEntry = { client, refs: 0, idleTimer: undefined };
  pool.set(instanceId, entry);
  return entry;
}

async function acquirePoolEntry(instanceId: string): Promise<PoolEntry> {
  const existing = pool.get(instanceId);
  if (existing !== undefined) {
    if (existing.idleTimer !== undefined) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    return existing;
  }

  let pending = creating.get(instanceId);
  if (pending === undefined) {
    pending = createPoolEntry(instanceId).finally(() => {
      creating.delete(instanceId);
    });
    creating.set(instanceId, pending);
  }
  return pending;
}

/** Drop a pooled client (e.g. when the instance stops). */
export function closeInstanceAcpRpcClient(instanceId: string): void {
  const entry = pool.get(instanceId);
  if (entry === undefined) return;
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  try {
    entry.client.close();
  } catch {
    /* ignore */
  }
  pool.delete(instanceId);
}

async function withAcpClient<T>(
  instanceId: string,
  fn: (client: PeerAcpClient) => Promise<T>,
): Promise<T> {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  await ensureGatewayOnline(instanceId, instance);

  const entry = await acquirePoolEntry(instanceId);
  entry.refs += 1;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  try {
    return await fn(entry.client);
  } catch (err) {
    closeInstanceAcpRpcClient(instanceId);
    throw err;
  } finally {
    entry.refs -= 1;
    if (entry.refs === 0 && pool.get(instanceId) === entry) {
      scheduleIdleClose(instanceId, entry);
    }
  }
}

/** Live session list from `agent.sessions.list` on the instance gateway. */
export async function listInstanceConversations(instanceId: string): Promise<SessionInfo[]> {
  const raw = await withAcpClient(instanceId, (client) => client.sessions());
  return raw.map(parseSessionInfo).filter((session): session is SessionInfo => session !== null);
}

/** Replayed transcript from `agent.sessions.history`. */
export async function getInstanceConversationHistory(
  instanceId: string,
  sessionId: string,
): Promise<SessionHistoryMessage[]> {
  const raw = await withAcpClient(instanceId, (client) => client.sessionHistory(sessionId));
  return raw.map(parseHistoryMessage).filter((message): message is SessionHistoryMessage => message !== null);
}
