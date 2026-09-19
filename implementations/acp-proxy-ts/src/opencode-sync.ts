/**
 * Manual OpenCode CLI → Shepaw session sync manifest.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  listOpencodeDiskSessions,
  opencodeCwdMatches,
  type OpencodeSessionSummary,
} from './disk-history/opencode.js';
import { claudeProjectSlug } from './disk-history/util.js';
import { dropManagedCliSessions, readManagedAcpSessionIdsForSync } from './sessions-list.js';

export const OPENCODE_SYNC_FILENAME = 'opencode-sync.json';

export interface OpencodeSyncedSession {
  title: string;
  updatedAt: string;
  syncedAt: string;
  messageCount: number;
}

export interface OpencodeSyncManifest {
  version: 1;
  cwd: string;
  sessions: Record<string, OpencodeSyncedSession>;
}

export type OpencodeSyncedEntry = OpencodeSyncedSession & { sessionId: string };

export interface OpencodeSyncPreview {
  cwd: string;
  workspaceSlug: string;
  onDisk: OpencodeSessionSummary[];
  synced: OpencodeSyncedEntry[];
  pending: OpencodeSessionSummary[];
}

export interface OpencodeSyncResult {
  cwd: string;
  added: number;
  updated: number;
  total: number;
  sessions: OpencodeSyncedEntry[];
}

export function opencodeSyncPathFromSessionStore(sessionStorePath: string): string {
  return join(dirname(sessionStorePath), OPENCODE_SYNC_FILENAME);
}

export function emptyOpencodeSyncManifest(cwd: string): OpencodeSyncManifest {
  return { version: 1, cwd: resolve(cwd), sessions: {} };
}

export async function loadOpencodeSyncManifest(path: string): Promise<OpencodeSyncManifest | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as OpencodeSyncManifest;
    if (parsed.version !== 1 || typeof parsed.cwd !== 'string') return null;
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveOpencodeSyncManifest(
  path: string,
  manifest: OpencodeSyncManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function previewOpencodeSync(opts: {
  cwd: string;
  syncPath: string;
  /** sessions.json — ACP-managed upstream ids are skipped (already in the app). */
  sessionStorePath?: string;
}): Promise<OpencodeSyncPreview> {
  const cwd = resolve(opts.cwd);
  if (!opencodeCwdMatches(cwd)) {
    throw new Error('OpenCode sync cwd mismatch');
  }
  const managedIds = await readManagedAcpSessionIdsForSync(opts);
  const onDisk = dropManagedCliSessions(await listOpencodeDiskSessions(cwd), managedIds);
  const manifest =
    (await loadOpencodeSyncManifest(opts.syncPath)) ?? emptyOpencodeSyncManifest(cwd);

  if (resolve(manifest.cwd) !== cwd) {
    manifest.sessions = {};
    manifest.cwd = cwd;
  }

  const syncedIds = new Set(Object.keys(manifest.sessions));
  const pending = onDisk.filter((s) => !syncedIds.has(s.sessionId));
  const synced = Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    ...meta,
  }));

  return {
    cwd,
    workspaceSlug: claudeProjectSlug(cwd),
    onDisk,
    synced,
    pending,
  };
}

export async function runOpencodeSync(opts: {
  cwd: string;
  syncPath: string;
  sessionIds?: readonly string[];
  sessionStorePath?: string;
}): Promise<OpencodeSyncResult> {
  const cwd = resolve(opts.cwd);
  const preview = await previewOpencodeSync({
    cwd,
    syncPath: opts.syncPath,
    sessionStorePath: opts.sessionStorePath,
  });
  const manifest =
    (await loadOpencodeSyncManifest(opts.syncPath)) ?? emptyOpencodeSyncManifest(cwd);
  manifest.cwd = cwd;

  const want =
    opts.sessionIds === undefined || opts.sessionIds.length === 0
      ? new Set(preview.pending.map((s) => s.sessionId))
      : new Set(opts.sessionIds);

  let added = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const disk of preview.onDisk) {
    if (!want.has(disk.sessionId)) continue;
    const prev = manifest.sessions[disk.sessionId];
    manifest.sessions[disk.sessionId] = {
      title: disk.title,
      updatedAt: disk.updatedAt,
      syncedAt: now,
      messageCount: disk.messageCount,
    };
    if (prev === undefined) added += 1;
    else updated += 1;
  }

  await saveOpencodeSyncManifest(opts.syncPath, manifest);

  const sessions = Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    ...meta,
  }));

  return { cwd, added, updated, total: sessions.length, sessions };
}

export async function listSyncedOpencodeSessions(opts: {
  cwd: string;
  syncPath: string;
}): Promise<Array<{ sessionId: string; title: string; updatedAt: string; cwd: string }>> {
  const cwd = resolve(opts.cwd);
  const manifest = await loadOpencodeSyncManifest(opts.syncPath);
  if (manifest === null) return [];
  if (resolve(manifest.cwd) !== cwd) return [];

  return Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    title: meta.title,
    updatedAt: meta.updatedAt,
    cwd,
  }));
}

export function isOpencodeSessionSynced(
  manifest: OpencodeSyncManifest | null,
  sessionId: string,
  cwd: string,
): boolean {
  if (manifest === null) return false;
  if (resolve(manifest.cwd) !== resolve(cwd)) return false;
  return manifest.sessions[sessionId] !== undefined;
}
