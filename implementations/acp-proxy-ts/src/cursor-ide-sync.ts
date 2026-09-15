/**
 * Manual Cursor IDE → Shepaw session sync manifest.
 *
 * Hub writes this file when the user clicks "Sync Cursor IDE sessions".
 * The gateway reads it to expose ONLY user-confirmed IDE conversations in
 * agent.sessions.list (never auto-scans disk on every list call).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  cursorIdeCwdMatches,
  listCursorIdeDiskSessions,
  type CursorIdeSessionSummary,
} from './disk-history/cursor-ide.js';
import { claudeProjectSlug } from './disk-history/util.js';

export const CURSOR_IDE_SYNC_FILENAME = 'cursor-ide-sync.json';

export interface CursorIdeSyncedSession {
  title: string;
  updatedAt: string;
  syncedAt: string;
  messageCount: number;
}

export interface CursorIdeSyncManifest {
  version: 1;
  cwd: string;
  sessions: Record<string, CursorIdeSyncedSession>;
}

export type CursorIdeSyncedEntry = CursorIdeSyncedSession & { sessionId: string };

export interface CursorIdeSyncPreview {
  cwd: string;
  workspaceSlug: string;
  onDisk: CursorIdeSessionSummary[];
  synced: CursorIdeSyncedEntry[];
  pending: CursorIdeSessionSummary[];
}

export interface CursorIdeSyncResult {
  cwd: string;
  added: number;
  updated: number;
  total: number;
  sessions: CursorIdeSyncedEntry[];
}

export function cursorIdeSyncPathFromSessionStore(sessionStorePath: string): string {
  return join(dirname(sessionStorePath), CURSOR_IDE_SYNC_FILENAME);
}

export function emptyCursorIdeSyncManifest(cwd: string): CursorIdeSyncManifest {
  return { version: 1, cwd: resolve(cwd), sessions: {} };
}

export async function loadCursorIdeSyncManifest(
  path: string,
): Promise<CursorIdeSyncManifest | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as CursorIdeSyncManifest;
    if (parsed.version !== 1 || typeof parsed.cwd !== 'string') return null;
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCursorIdeSyncManifest(
  path: string,
  manifest: CursorIdeSyncManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function previewCursorIdeSync(opts: {
  cwd: string;
  syncPath: string;
}): Promise<CursorIdeSyncPreview> {
  const cwd = resolve(opts.cwd);
  if (!cursorIdeCwdMatches(cwd)) {
    throw new Error('Cursor IDE sync cwd mismatch');
  }
  const onDisk = await listCursorIdeDiskSessions(cwd);
  const manifest = (await loadCursorIdeSyncManifest(opts.syncPath)) ?? emptyCursorIdeSyncManifest(cwd);

  if (resolve(manifest.cwd) !== cwd) {
    // Different workspace bound to this instance — treat manifest as empty for safety.
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

export async function runCursorIdeSync(opts: {
  cwd: string;
  syncPath: string;
  /** When set, sync only these session ids; otherwise sync all pending on disk. */
  sessionIds?: readonly string[];
}): Promise<CursorIdeSyncResult> {
  const cwd = resolve(opts.cwd);
  const preview = await previewCursorIdeSync({ cwd, syncPath: opts.syncPath });
  const manifest =
    (await loadCursorIdeSyncManifest(opts.syncPath)) ?? emptyCursorIdeSyncManifest(cwd);
  manifest.cwd = cwd;

  const want = opts.sessionIds === undefined || opts.sessionIds.length === 0
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

  await saveCursorIdeSyncManifest(opts.syncPath, manifest);

  const sessions = Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    ...meta,
  }));

  return { cwd, added, updated, total: sessions.length, sessions };
}

/** Summaries for agent.sessions.list — only manifest entries, scoped to cwd. */
export async function listSyncedCursorIdeSessions(opts: {
  cwd: string;
  syncPath: string;
}): Promise<Array<{ sessionId: string; title: string; updatedAt: string; cwd: string }>> {
  const cwd = resolve(opts.cwd);
  const manifest = await loadCursorIdeSyncManifest(opts.syncPath);
  if (manifest === null) return [];
  if (resolve(manifest.cwd) !== cwd) return [];

  return Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    title: meta.title,
    updatedAt: meta.updatedAt,
    cwd,
  }));
}

export function isCursorIdeSessionSynced(
  manifest: CursorIdeSyncManifest | null,
  sessionId: string,
  cwd: string,
): boolean {
  if (manifest === null) return false;
  if (resolve(manifest.cwd) !== resolve(cwd)) return false;
  return manifest.sessions[sessionId] !== undefined;
}
