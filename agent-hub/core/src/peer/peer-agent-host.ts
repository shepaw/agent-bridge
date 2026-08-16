/**
 * Agent-host helpers for the peer service.
 *
 * The chat / ACP-client logic lives in `peer-acp-client.ts` (persistent
 * connection per (peer, agent) pair). This module only retains the
 * `agent_list_resp` builder.
 */

import { isInstanceEnabled, loadOrCreateHubConfig } from '../config.js';
import {
  GENERIC_DEFAULT_AVATAR,
  defaultAvatarForEngine,
  loadEngineAvatarPayload,
} from '../engine-avatars.js';
import { instancePaths } from '../paths.js';
import { isAlive, readState } from '../spawn.js';
import { hubStoreDeviceId, workspaceStoreUri } from './agent-store-mapping.js';

export interface AgentListEntry {
  readonly id: string;
  readonly name: string;
  readonly engine: string;
  readonly running: boolean;
  readonly enabled: boolean;
  /** Paired apps may start/stop/enable this instance from device details. */
  readonly manageable: true;
  /** Advertised to the Shepaw app (peer_agent_client_service.dart). */
  readonly capabilities: readonly string[];
  readonly bio?: string;
  readonly avatar?: string;
  /** Base64 image bytes so peers can render without bundling engine assets. */
  readonly avatar_data?: string;
  readonly avatar_ext?: string;
  /** Mapped store workspace so paired apps can open cwd files remotely. */
  readonly workspace_uri?: string;
  /** Primary + additional workspace roots (store://…), ordered. */
  readonly workspace_uris?: readonly string[];
}

function isInstanceRunning(instanceId: string): boolean {
  const state = readState(instancePaths(instanceId).statePath);
  return state !== undefined && state.pid > 0 && isAlive(state.pid);
}

export { isInstanceRunning };

/** List managed instances as `agent_list_resp` entries. */
export function listAgents(): AgentListEntry[] {
  const cfg = loadOrCreateHubConfig();
  let workspaceDeviceId: string | undefined;
  try {
    workspaceDeviceId = hubStoreDeviceId();
  } catch {
    workspaceDeviceId = undefined;
  }
  return cfg.instances.map((i) => {
    const payload = loadEngineAvatarPayload(i.engine);
    const workspaceUris =
      workspaceDeviceId !== undefined
        ? [
            workspaceStoreUri(workspaceDeviceId, i.cwd),
            ...(i.additionalDirectories ?? []).map((d) =>
              workspaceStoreUri(workspaceDeviceId, d),
            ),
          ]
        : undefined;
    const workspaceUri = workspaceUris?.[0];
    return {
      id: i.id,
      name: i.label || i.id,
      engine: i.engine,
      running: isInstanceRunning(i.id),
      enabled: isInstanceEnabled(i),
      manageable: true,
      capabilities: ['chat'],
      bio: i.engine,
      // Engine logos ship with agent-hub; peers persist avatar_data locally.
      // Shepaw keeps a local override when the user changes the avatar.
      avatar: payload?.avatar ?? defaultAvatarForEngine(i.engine) ?? GENERIC_DEFAULT_AVATAR,
      ...(payload
        ? { avatar_data: payload.avatar_data, avatar_ext: payload.avatar_ext }
        : {}),
      ...(workspaceUri !== undefined ? { workspace_uri: workspaceUri } : {}),
      ...(workspaceUris !== undefined && workspaceUris.length > 1
        ? { workspace_uris: workspaceUris }
        : {}),
    };
  });
}
