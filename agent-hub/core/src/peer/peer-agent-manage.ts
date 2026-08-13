/**
 * Peer control-plane for managing hub agent instances from a paired app.
 *
 * Frames:
 *   agent_manage_req  { request_id, op, agent_id?, enabled? }
 *   agent_manage_resp { request_id, ok, error?, agents? }
 *
 * ops: list | start | stop | set_enabled
 */
import {
  getInstance,
  isInstanceEnabled,
  loadOrCreateHubConfig,
  updateInstance,
} from '../config.js';
import { startInstance, stopInstance } from '../spawn.js';
import { isInstanceRunning, listAgents } from './peer-agent-host.js';

export interface AgentManageEntry {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly running: boolean;
  readonly enabled: boolean;
  readonly manageable: true;
}

function listManagedAgents(): AgentManageEntry[] {
  const cfg = loadOrCreateHubConfig();
  return cfg.instances.map((i) => ({
    id: i.id,
    name: i.label || i.id,
    engine: i.engine,
    running: isInstanceRunning(i.id),
    enabled: isInstanceEnabled(i),
    manageable: true,
  }));
}

function requireAgentId(obj: Record<string, unknown>): string {
  const id = obj.agent_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('agent_id is required');
  }
  return id;
}

export async function handleAgentManage(
  obj: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : '';
  const op = typeof obj.op === 'string' ? obj.op : '';
  try {
    switch (op) {
      case 'list':
        break;
      case 'start': {
        const cfg = loadOrCreateHubConfig();
        const instance = getInstance(cfg, requireAgentId(obj));
        await startInstance(instance);
        break;
      }
      case 'stop': {
        const cfg = loadOrCreateHubConfig();
        const instance = getInstance(cfg, requireAgentId(obj));
        await stopInstance(instance);
        break;
      }
      case 'set_enabled': {
        const enabled = obj.enabled !== false;
        const cfg = loadOrCreateHubConfig();
        const id = requireAgentId(obj);
        const instance = getInstance(cfg, id);
        if (!enabled && isInstanceRunning(id)) {
          await stopInstance(instance);
        }
        updateInstance(loadOrCreateHubConfig(), id, { enabled });
        break;
      }
      default:
        return {
          type: 'agent_manage_resp',
          request_id: requestId,
          ok: false,
          error: `unknown op: ${op}`,
        };
    }
    return {
      type: 'agent_manage_resp',
      request_id: requestId,
      ok: true,
      agents: listManagedAgents(),
    };
  } catch (err) {
    return {
      type: 'agent_manage_resp',
      request_id: requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      agents: listManagedAgents(),
    };
  }
}

/** Latest agent_list_resp payload after a manage mutation. */
export function currentAgentListPayload(): Record<string, unknown> {
  return { type: 'agent_list_resp', agents: listAgents() };
}
