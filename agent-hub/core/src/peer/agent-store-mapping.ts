/**
 * Auto-map an agent's Working Directory and private pouch into the hub store.
 *
 * Convention (URI is space-first; on-disk layout is device-first):
 *   store://workspaces/<device-id>/<workspace-abs-path>/
 *   store://agents/<device-id>/<agent-uuid>/
 *
 * Disk:
 *   <store>/<device-id>/workspaces/<workspace-abs-path>/  → symlink to cwd
 *   <store>/<device-id>/agents/<agent-uuid>/              → private dir
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadOrCreatePeerIdentity } from './peer-identity.js';
import { getPeerLocalStore, type PeerLocalStore } from './peer-local-store.js';
import { normalizeCwd } from '../paths.js';

export const WORKSPACES_SPACE = 'workspaces';
export const AGENTS_SPACE = 'agents';

export interface AgentStoreMapping {
  readonly deviceId: string;
  readonly workspaceUri: string;
  readonly agentUri: string;
  readonly workspaceRelPath: string;
  readonly agentRelPath: string;
}

/** Encode an absolute working directory into a store-relative path (no leading /). */
export function encodeWorkspaceStorePath(absCwd: string): string {
  const normalized = normalizeCwd(absCwd).replace(/\\/g, '/');
  // Unix: /Users/foo → Users/foo
  // Windows: C:/Users/foo → C/Users/foo
  return normalized.replace(/^\/+/, '').replace(/^([A-Za-z]):\//, '$1/');
}

export function workspaceStoreUri(deviceId: string, absCwd: string): string {
  const rel = encodeWorkspaceStorePath(absCwd);
  return `store://${WORKSPACES_SPACE}/${deviceId}/${rel}/`;
}

export function agentPrivateStoreUri(deviceId: string, agentUuid: string): string {
  return `store://${AGENTS_SPACE}/${deviceId}/${agentUuid}/`;
}

export function hubStoreDeviceId(): string {
  return loadOrCreatePeerIdentity().fingerprint;
}

/**
 * Ensure store dirs exist for this agent: private agents/<uuid>/ and a
 * workspaces/<abs-path>/ symlink pointing at the Working Directory.
 */
export function ensureAgentStoreMappings(opts: {
  agentId: string;
  cwd: string;
  deviceId?: string;
  store?: PeerLocalStore;
}): AgentStoreMapping {
  const deviceId = opts.deviceId ?? hubStoreDeviceId();
  const cwd = normalizeCwd(opts.cwd);
  const store = opts.store ?? getPeerLocalStore();
  const workspaceRel = encodeWorkspaceStorePath(cwd);
  const agentRel = opts.agentId;

  const workspaceAbs = join(store.root, deviceId, WORKSPACES_SPACE, ...workspaceRel.split('/'));
  const agentAbs = join(store.root, deviceId, AGENTS_SPACE, agentRel);

  mkdirSync(dirname(workspaceAbs), { recursive: true });
  mkdirSync(agentAbs, { recursive: true });

  ensureWorkspaceSymlink(workspaceAbs, cwd);

  return {
    deviceId,
    workspaceUri: workspaceStoreUri(deviceId, cwd),
    agentUri: agentPrivateStoreUri(deviceId, opts.agentId),
    workspaceRelPath: workspaceRel,
    agentRelPath: agentRel,
  };
}

/** Re-point the workspace symlink when Working Directory changes. */
export function remapAgentWorkspace(opts: {
  agentId: string;
  previousCwd?: string;
  cwd: string;
  deviceId?: string;
  store?: PeerLocalStore;
}): AgentStoreMapping {
  const deviceId = opts.deviceId ?? hubStoreDeviceId();
  const store = opts.store ?? getPeerLocalStore();

  if (opts.previousCwd) {
    const prevRel = encodeWorkspaceStorePath(opts.previousCwd);
    const prevAbs = join(store.root, deviceId, WORKSPACES_SPACE, ...prevRel.split('/'));
    removeSymlinkIfPresent(prevAbs);
  }

  return ensureAgentStoreMappings({
    agentId: opts.agentId,
    cwd: opts.cwd,
    deviceId,
    store,
  });
}

function ensureWorkspaceSymlink(linkPath: string, targetCwd: string): void {
  const target = resolve(targetCwd);
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
    try {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        // Already a symlink — replace so cwd updates take effect.
        rmSync(linkPath, { force: true });
      } else {
        // Real directory/file already there — leave it (manual override).
        return;
      }
    } catch {
      rmSync(linkPath, { force: true });
    }
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  // Prefer absolute target so the link stays valid if store root moves.
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function removeSymlinkIfPresent(linkPath: string): void {
  if (!existsSync(linkPath) && !isBrokenSymlink(linkPath)) return;
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) rmSync(linkPath, { force: true });
  } catch {
    /* ignore */
  }
}

function isBrokenSymlink(p: string): boolean {
  try {
    const st = lstatSync(p);
    if (!st.isSymbolicLink()) return false;
    // existsSync follows the link; false ⇒ dangling symlink.
    return !existsSync(p);
  } catch {
    return false;
  }
}

/** Resolve store path under root without following the final symlink (for tests). */
export function workspaceLinkPath(
  storeRoot: string,
  deviceId: string,
  absCwd: string,
): string {
  const rel = encodeWorkspaceStorePath(absCwd);
  return join(storeRoot, deviceId, WORKSPACES_SPACE, ...rel.split('/'));
}
