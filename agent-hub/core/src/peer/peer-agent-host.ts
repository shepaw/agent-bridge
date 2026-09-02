/**
 * Agent-host helpers for the peer service.
 *
 * The chat / ACP-client logic lives in `peer-acp-client.ts` (persistent
 * connection per (peer, agent) pair). This module only retains the
 * `agent_list_resp` builder.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstanceEnabled, loadOrCreateHubConfig } from '../config.js';
import {
  GENERIC_DEFAULT_AVATAR,
  defaultAvatarForEngine,
  loadEngineAvatarPayload,
} from '../engine-avatars.js';
import { instancePaths, peerStoreRoot } from '../paths.js';
import { isAlive, readState } from '../spawn.js';
import { hubStoreDeviceId, workspaceStoreUri } from './agent-store-mapping.js';

/** Parse the `## Summary` section body out of a resume.md document. Pure. */
export function parseResumeSummary(md: string): string {
  const m = md.match(/^##\s+Summary\s*\r?\n/m);
  if (!m || m.index === undefined) return '';
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/\r?\n##\s/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body.trim();
}

/**
 * Read a managed instance's workspace-grounded resume Summary from the hub
 * store mirror (`store/<device-id>/files/<instance-id>/resume.md`, written by
 * the instance's acp-proxy gateway). Advertised to paired apps as the agent's
 * bio so the Shepaw app shows a real resume instead of an engine label.
 * Returns '' when no resume has been derived/mirrored yet.
 */
export function resumeBioForInstance(instanceId: string): string {
  try {
    const deviceId = hubStoreDeviceId();
    const resumePath = join(
      peerStoreRoot(),
      deviceId,
      'files',
      instanceId,
      'resume.md',
    );
    if (!existsSync(resumePath)) return '';
    return parseResumeSummary(readFileSync(resumePath, 'utf8'));
  } catch {
    return '';
  }
}

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
  /** Absolute primary working directory on the hub host. */
  readonly cwd?: string;
  /** Absolute additional workspace roots on the hub host. */
  readonly additional_directories?: readonly string[];
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
    const extras = i.additionalDirectories ?? [];
    const workspaceUris =
      workspaceDeviceId !== undefined
        ? [
            workspaceStoreUri(workspaceDeviceId, i.cwd),
            ...extras.map((d) => workspaceStoreUri(workspaceDeviceId, d)),
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
      // 广播真实工作区简历（hub store 里网关镜像的 resume.md Summary），
      // 未生成简历的实例回退到引擎名，避免 app 把引擎当简历展示。
      bio: resumeBioForInstance(i.id) || i.engine,
      // Engine logos ship with agent-hub; peers persist avatar_data locally.
      // Shepaw keeps a local override when the user changes the avatar.
      avatar: payload?.avatar ?? defaultAvatarForEngine(i.engine) ?? GENERIC_DEFAULT_AVATAR,
      ...(payload
        ? { avatar_data: payload.avatar_data, avatar_ext: payload.avatar_ext }
        : {}),
      cwd: i.cwd,
      ...(extras.length > 0 ? { additional_directories: extras } : {}),
      ...(workspaceUri !== undefined ? { workspace_uri: workspaceUri } : {}),
      ...(workspaceUris !== undefined && workspaceUris.length > 1
        ? { workspace_uris: workspaceUris }
        : {}),
    };
  });
}
