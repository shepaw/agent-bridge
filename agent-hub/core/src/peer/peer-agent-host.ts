/**
 * Agent-host helpers for the peer service.
 *
 * The chat / ACP-client logic lives in `peer-acp-client.ts` (persistent
 * connection per (peer, agent) pair). This module only retains the
 * `agent_list_resp` builder.
 */

import { loadOrCreateHubConfig } from '../config.js';
import { instancePaths } from '../paths.js';
import { isAlive, readState } from '../spawn.js';

export interface AgentListEntry {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly running: boolean;
  /** Advertised to the Shepaw app (peer_agent_client_service.dart). */
  readonly capabilities: readonly string[];
  readonly bio?: string;
  readonly avatar?: string;
}

function isInstanceRunning(instanceId: string): boolean {
  const state = readState(instancePaths(instanceId).statePath);
  return state !== undefined && state.pid > 0 && isAlive(state.pid);
}

/** List managed instances as `agent_list_resp` entries. */
export function listAgents(): AgentListEntry[] {
  const cfg = loadOrCreateHubConfig();
  return cfg.instances.map((i) => ({
    id: i.id,
    name: i.label || i.id,
    engine: i.engine,
    running: isInstanceRunning(i.id),
    capabilities: ['chat'],
    bio: i.engine,
    avatar: '🤖',
  }));
}
