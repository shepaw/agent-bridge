/**
 * Agent-host helpers for the peer service.
 *
 * The chat / ACP-client logic lives in `peer-acp-client.ts` (persistent
 * connection per (peer, agent) pair). This module only retains the
 * `agent_list_resp` builder.
 */

import { loadOrCreateHubConfig } from '../config.js';

export interface AgentListEntry {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly running: boolean;
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
