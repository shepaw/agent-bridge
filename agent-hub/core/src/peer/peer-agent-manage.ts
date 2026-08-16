/**
 * Peer control-plane for managing hub agent instances from a paired app.
 *
 * Frames:
 *   agent_manage_req  { request_id, op, agent_id?, enabled?, additional_directories? }
 *   agent_manage_resp { request_id, ok, error?, agents? }
 *
 * ops: list | start | stop | set_enabled | set_additional_directories
 *
 * `set_additional_directories` takes a full-replacement `additional_directories`
 * string array (absolute paths on the hub host). Empty array clears all extras.
 * When the instance is running it is restarted so the proxy picks up new roots.
 */
import {
  getInstance,
  isInstanceEnabled,
  loadOrCreateHubConfig,
  updateInstance,
} from '../config.js';
import { startInstance, stopInstance } from '../spawn.js';
import {
  ensureAgentStoreMappings,
  hubStoreDeviceId,
  workspaceStoreUri,
} from './agent-store-mapping.js';
import { isInstanceRunning, listAgents } from './peer-agent-host.js';

export interface AgentManageEntry {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly running: boolean;
  readonly enabled: boolean;
  readonly manageable: true;
  readonly cwd?: string;
  readonly additional_directories?: readonly string[];
  readonly workspace_uri?: string;
  readonly workspace_uris?: readonly string[];
}

function listManagedAgents(): AgentManageEntry[] {
  const cfg = loadOrCreateHubConfig();
  let deviceId: string | undefined;
  try {
    deviceId = hubStoreDeviceId();
  } catch {
    deviceId = undefined;
  }
  return cfg.instances.map((i) => {
    const extras = i.additionalDirectories ?? [];
    const workspaceUri =
      deviceId !== undefined ? workspaceStoreUri(deviceId, i.cwd) : undefined;
    const workspaceUris =
      deviceId !== undefined
        ? [
            workspaceStoreUri(deviceId, i.cwd),
            ...extras.map((d) => workspaceStoreUri(deviceId, d)),
          ]
        : undefined;
    return {
      id: i.id,
      name: i.label || i.id,
      engine: i.engine,
      running: isInstanceRunning(i.id),
      enabled: isInstanceEnabled(i),
      manageable: true,
      cwd: i.cwd,
      ...(extras.length > 0 ? { additional_directories: extras } : {}),
      ...(workspaceUri !== undefined ? { workspace_uri: workspaceUri } : {}),
      ...(workspaceUris !== undefined && workspaceUris.length > 1
        ? { workspace_uris: workspaceUris }
        : {}),
    };
  });
}

function requireAgentId(obj: Record<string, unknown>): string {
  const id = obj.agent_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('agent_id is required');
  }
  return id;
}

function parseAdditionalDirectories(obj: Record<string, unknown>): string[] {
  const raw = obj.additional_directories ?? obj.additionalDirectories;
  if (raw === undefined) {
    throw new Error('additional_directories is required');
  }
  if (!Array.isArray(raw)) {
    throw new Error('additional_directories must be an array of strings');
  }
  return raw.filter((x): x is string => typeof x === 'string');
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
      case 'set_additional_directories': {
        const id = requireAgentId(obj);
        const dirs = parseAdditionalDirectories(obj);
        const cfg = loadOrCreateHubConfig();
        const existing = getInstance(cfg, id);
        const wasRunning = isInstanceRunning(id);
        if (wasRunning) {
          await stopInstance(existing);
        }
        const next = updateInstance(loadOrCreateHubConfig(), id, {
          additionalDirectories: dirs,
        });
        const updated = getInstance(next, id);
        try {
          ensureAgentStoreMappings({
            agentId: updated.id,
            cwd: updated.cwd,
            additionalDirectories: updated.additionalDirectories,
          });
        } catch {
          /* URI still advertised even if symlink fails */
        }
        if (wasRunning) {
          await startInstance(updated);
        }
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
