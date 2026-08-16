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

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadOrCreatePeerIdentity } from './peer-identity.js';
import { getPeerLocalStore, type PeerLocalStore } from './peer-local-store.js';
import { normalizeCwd } from '../paths.js';

export const WORKSPACES_SPACE = 'workspaces';
export const AGENTS_SPACE = 'agents';

export interface AgentStoreMapping {
  readonly deviceId: string;
  readonly workspaceUri: string;
  /** Primary cwd URI first, then each additional directory URI. */
  readonly workspaceUris: readonly string[];
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

const ABSOLUTE_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** True when [href] is a cwd-relative path (not store://, http, mailto, …). */
export function isRelativeWorkspaceHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('store://')) return false;
  return !ABSOLUTE_HREF.test(trimmed);
}

/** Join a workspace root URI with a relative path. Rejects `..` traversal. */
export function joinStoreUri(rootUri: string, relPath: string): string | null {
  const root = rootUri.trim().replace(/\/+$/, '');
  if (!root.startsWith('store://')) return null;
  const rel = relPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  if (!rel) return root;
  const parts: string[] = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  if (parts.length === 0) return root;
  return `${root}/${parts.join('/')}`;
}

/**
 * Resolve a markdown href against one or more mapped workspace roots.
 * Absolute/`store://` hrefs are returned as-is (store) or skipped (http…).
 */
export function resolveWorkspaceFileUri(
  workspaceRootUri: string | readonly string[],
  href: string,
): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('store://')) return trimmed;
  if (!isRelativeWorkspaceHref(trimmed)) return null;
  const roots = typeof workspaceRootUri === 'string' ? [workspaceRootUri] : workspaceRootUri;
  for (const root of roots) {
    const joined = joinStoreUri(root, trimmed);
    if (joined) return joined;
  }
  return null;
}

export function hubStoreDeviceId(): string {
  return loadOrCreatePeerIdentity().fingerprint;
}

function ensureWorkspaceRootSymlink(
  store: PeerLocalStore,
  deviceId: string,
  absPath: string,
): string {
  const cwd = normalizeCwd(absPath);
  const workspaceRel = encodeWorkspaceStorePath(cwd);
  const workspaceAbs = join(store.root, deviceId, WORKSPACES_SPACE, ...workspaceRel.split('/'));
  mkdirSync(dirname(workspaceAbs), { recursive: true });
  ensureWorkspaceSymlink(workspaceAbs, cwd);
  return workspaceStoreUri(deviceId, cwd);
}

/**
 * Ensure store dirs exist for this agent: private agents/<uuid>/ and
 * workspaces/<abs-path>/ symlinks for the primary cwd and any additional roots.
 */
export function ensureAgentStoreMappings(opts: {
  agentId: string;
  cwd: string;
  additionalDirectories?: readonly string[];
  deviceId?: string;
  store?: PeerLocalStore;
}): AgentStoreMapping {
  const deviceId = opts.deviceId ?? hubStoreDeviceId();
  const cwd = normalizeCwd(opts.cwd);
  const store = opts.store ?? getPeerLocalStore();
  const extras = (opts.additionalDirectories ?? [])
    .map((d) => normalizeCwd(d))
    .filter((d) => d !== cwd);
  const agentRel = opts.agentId;
  const agentAbs = join(store.root, deviceId, AGENTS_SPACE, agentRel);
  mkdirSync(agentAbs, { recursive: true });

  const workspaceUri = ensureWorkspaceRootSymlink(store, deviceId, cwd);
  const additionalUris = extras.map((d) => ensureWorkspaceRootSymlink(store, deviceId, d));
  const workspaceUris = [workspaceUri, ...additionalUris];

  return {
    deviceId,
    workspaceUri,
    workspaceUris,
    agentUri: agentPrivateStoreUri(deviceId, opts.agentId),
    workspaceRelPath: encodeWorkspaceStorePath(cwd),
    agentRelPath: agentRel,
  };
}

/** Re-point workspace symlinks when Working Directory / additional roots change. */
export function remapAgentWorkspace(opts: {
  agentId: string;
  previousCwd?: string;
  previousAdditionalDirectories?: readonly string[];
  cwd: string;
  additionalDirectories?: readonly string[];
  deviceId?: string;
  store?: PeerLocalStore;
}): AgentStoreMapping {
  const deviceId = opts.deviceId ?? hubStoreDeviceId();
  const store = opts.store ?? getPeerLocalStore();

  const prevRoots = [
    ...(opts.previousCwd ? [opts.previousCwd] : []),
    ...(opts.previousAdditionalDirectories ?? []),
  ].map((d) => normalizeCwd(d));
  const nextRoots = new Set([
    normalizeCwd(opts.cwd),
    ...(opts.additionalDirectories ?? []).map((d) => normalizeCwd(d)),
  ]);
  for (const prev of prevRoots) {
    if (nextRoots.has(prev)) continue;
    const prevRel = encodeWorkspaceStorePath(prev);
    const prevAbs = join(store.root, deviceId, WORKSPACES_SPACE, ...prevRel.split('/'));
    removeSymlinkIfPresent(prevAbs);
  }

  return ensureAgentStoreMappings({
    agentId: opts.agentId,
    cwd: opts.cwd,
    additionalDirectories: opts.additionalDirectories,
    deviceId,
    store,
  });
}

/** Ensure every instance has workspace symlinks (idempotent if already correct). */
export function ensureAllAgentStoreMappings(
  instances: ReadonlyArray<{
    id: string;
    cwd: string;
    additionalDirectories?: readonly string[];
  }>,
  opts?: { deviceId?: string; store?: PeerLocalStore },
): void {
  for (const instance of instances) {
    try {
      ensureAgentStoreMappings({
        agentId: instance.id,
        cwd: instance.cwd,
        additionalDirectories: instance.additionalDirectories,
        deviceId: opts?.deviceId,
        store: opts?.store,
      });
    } catch (err) {
      console.warn(
        `[shepaw-hub] Warning: failed to map workspace for "${instance.id}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

function ensureWorkspaceSymlink(linkPath: string, targetCwd: string): void {
  const target = resolve(targetCwd);
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
    try {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        try {
          if (resolve(readlinkSync(linkPath)) === target) return;
        } catch {
          /* replace below */
        }
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
