/**
 * Manual OpenClaw CLI → Shepaw session sync manifest.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  listOpenclawDiskSessions,
  openclawCwdMatches,
  type OpenclawSessionSummary,
} from './disk-history/openclaw.js';
import { claudeProjectSlug } from './disk-history/util.js';
import { dropManagedCliSessions, readManagedAcpSessionIdsForSync } from './sessions-list.js';

export const OPENCLAW_SYNC_FILENAME = 'openclaw-sync.json';

export interface OpenclawSyncedSession {
  title: string;
  updatedAt: string;
  syncedAt: string;
  messageCount: number;
}

export interface OpenclawSyncManifest {
  version: 1;
  cwd: string;
  sessions: Record<string, OpenclawSyncedSession>;
}

export type OpenclawSyncedEntry = OpenclawSyncedSession & { sessionId: string };

export interface OpenclawSyncPreview {
  cwd: string;
  workspaceSlug: string;
  onDisk: OpenclawSessionSummary[];
  synced: OpenclawSyncedEntry[];
  pending: OpenclawSessionSummary[];
}

export interface OpenclawSyncResult {
  cwd: string;
  added: number;
  updated: number;
  total: number;
  sessions: OpenclawSyncedEntry[];
}

export function openclawSyncPathFromSessionStore(sessionStorePath: string): string {
  return join(dirname(sessionStorePath), OPENCLAW_SYNC_FILENAME);
}

export function emptyOpenclawSyncManifest(cwd: string): OpenclawSyncManifest {
  return { version: 1, cwd: resolve(cwd), sessions: {} };
}

export async function loadOpenclawSyncManifest(path: string): Promise<OpenclawSyncManifest | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as OpenclawSyncManifest;
    if (parsed.version !== 1 || typeof parsed.cwd !== 'string') return null;
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveOpenclawSyncManifest(
  path: string,
  manifest: OpenclawSyncManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function previewOpenclawSync(opts: {
  cwd: string;
  syncPath: string;
  /** sessions.json — ACP-managed upstream ids are skipped (already in the app). */
  sessionStorePath?: string;
}): Promise<OpenclawSyncPreview> {
  const cwd = resolve(opts.cwd);
  if (!openclawCwdMatches(cwd)) {
    throw new Error('OpenClaw sync cwd mismatch');
  }
  const managedIds = await readManagedAcpSessionIdsForSync(opts);
  const onDisk = dropManagedCliSessions(await listOpenclawDiskSessions(cwd), managedIds);
  const manifest =
    (await loadOpenclawSyncManifest(opts.syncPath)) ?? emptyOpenclawSyncManifest(cwd);

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

export async function runOpenclawSync(opts: {
  cwd: string;
  syncPath: string;
  sessionIds?: readonly string[];
  sessionStorePath?: string;
}): Promise<OpenclawSyncResult> {
  const cwd = resolve(opts.cwd);
  const preview = await previewOpenclawSync({
    cwd,
    syncPath: opts.syncPath,
    sessionStorePath: opts.sessionStorePath,
  });
  const manifest =
    (await loadOpenclawSyncManifest(opts.syncPath)) ?? emptyOpenclawSyncManifest(cwd);
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

  await saveOpenclawSyncManifest(opts.syncPath, manifest);

  const sessions = Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    ...meta,
  }));

  return { cwd, added, updated, total: sessions.length, sessions };
}

export async function listSyncedOpenclawSessions(opts: {
  cwd: string;
  syncPath: string;
}): Promise<Array<{ sessionId: string; title: string; updatedAt: string; cwd: string }>> {
  const cwd = resolve(opts.cwd);
  const manifest = await loadOpenclawSyncManifest(opts.syncPath);
  if (manifest === null) return [];
  if (resolve(manifest.cwd) !== cwd) return [];

  return Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    title: meta.title,
    updatedAt: meta.updatedAt,
    cwd,
  }));
}

export function isOpenclawSessionSynced(
  manifest: OpenclawSyncManifest | null,
  sessionId: string,
  cwd: string,
): boolean {
  if (manifest === null) return false;
  if (resolve(manifest.cwd) !== resolve(cwd)) return false;
  return manifest.sessions[sessionId] !== undefined;
}
