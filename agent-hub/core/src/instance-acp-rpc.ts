/**
 * One-shot ACP RPC calls to a running instance gateway (sessions list / history).
 *
 * Uses the hub peer-service identity (already on each instance's allowlist) via
 * PeerAcpClient. Intended for the Dashboard REST bridge — not for chat turns.
 */

import { loadOrCreateIdentity } from 'shepaw-acp-sdk';
import type { SessionHistoryMessage, SessionInfo } from 'shepaw-acp-sdk';

import { getInstance, loadOrCreateHubConfig } from './config.js';
import { instancePaths } from './paths.js';
import { authorizePeerServiceOnInstance } from './peer/peer-auth.js';
import { loadOrCreatePeerIdentity } from './peer/peer-identity.js';
import { PeerAcpClient } from './peer/peer-acp-client.js';
import { probeInstanceRuntime } from './runtime-status.js';

export class InstanceGatewayOfflineError extends Error {
  constructor(
    readonly instanceId: string,
    detail?: string,
  ) {
    super(detail ?? `Instance "${instanceId}" gateway is not online.`);
    this.name = 'InstanceGatewayOfflineError';
  }
}

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

async function withAcpClient<T>(
  instanceId: string,
  fn: (client: PeerAcpClient) => Promise<T>,
): Promise<T> {
  const cfg = loadOrCreateHubConfig();
  const instance = getInstance(cfg, instanceId);
  const runtime = await probeInstanceRuntime(instance);
  if (runtime.availability !== 'online' && runtime.availability !== 'degraded') {
    throw new InstanceGatewayOfflineError(
      instanceId,
      runtime.probeError ?? `Gateway is ${runtime.availability}. Start the instance to view sessions.`,
    );
  }

  authorizePeerServiceOnInstance(instanceId, cfg);

  const peerIdentity = loadOrCreatePeerIdentity();
  const instanceIdentity = loadOrCreateIdentity({ path: instancePaths(instance.id).identityPath });
  const client = new PeerAcpClient(peerIdentity, instance, instanceIdentity, () => {});

  try {
    return await fn(client);
  } finally {
    client.close();
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
