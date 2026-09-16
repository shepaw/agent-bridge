/**
 * Manual Codex CLI → Shepaw session sync manifest.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  codexCwdMatches,
  listCodexDiskSessions,
  type CodexSessionSummary,
} from './disk-history/codex.js';
import { claudeProjectSlug } from './disk-history/util.js';

export const CODEX_SYNC_FILENAME = 'codex-sync.json';

export interface CodexSyncedSession {
  title: string;
  updatedAt: string;
  syncedAt: string;
  messageCount: number;
}

export interface CodexSyncManifest {
  version: 1;
  cwd: string;
  sessions: Record<string, CodexSyncedSession>;
}

export type CodexSyncedEntry = CodexSyncedSession & { sessionId: string };

export interface CodexSyncPreview {
  cwd: string;
  workspaceSlug: string;
  onDisk: CodexSessionSummary[];
  synced: CodexSyncedEntry[];
  pending: CodexSessionSummary[];
}

export interface CodexSyncResult {
  cwd: string;
  added: number;
  updated: number;
  total: number;
  sessions: CodexSyncedEntry[];
}

export function codexSyncPathFromSessionStore(sessionStorePath: string): string {
  return join(dirname(sessionStorePath), CODEX_SYNC_FILENAME);
}

export function emptyCodexSyncManifest(cwd: string): CodexSyncManifest {
  return { version: 1, cwd: resolve(cwd), sessions: {} };
}

export async function loadCodexSyncManifest(path: string): Promise<CodexSyncManifest | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as CodexSyncManifest;
    if (parsed.version !== 1 || typeof parsed.cwd !== 'string') return null;
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCodexSyncManifest(path: string, manifest: CodexSyncManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function previewCodexSync(opts: {
  cwd: string;
  syncPath: string;
}): Promise<CodexSyncPreview> {
  const cwd = resolve(opts.cwd);
  if (!codexCwdMatches(cwd)) {
    throw new Error('Codex sync cwd mismatch');
  }
  const onDisk = await listCodexDiskSessions(cwd);
  const manifest = (await loadCodexSyncManifest(opts.syncPath)) ?? emptyCodexSyncManifest(cwd);

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

export async function runCodexSync(opts: {
  cwd: string;
  syncPath: string;
  sessionIds?: readonly string[];
}): Promise<CodexSyncResult> {
  const cwd = resolve(opts.cwd);
  const preview = await previewCodexSync({ cwd, syncPath: opts.syncPath });
  const manifest = (await loadCodexSyncManifest(opts.syncPath)) ?? emptyCodexSyncManifest(cwd);
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

  await saveCodexSyncManifest(opts.syncPath, manifest);

  const sessions = Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    ...meta,
  }));

  return { cwd, added, updated, total: sessions.length, sessions };
}

export async function listSyncedCodexSessions(opts: {
  cwd: string;
  syncPath: string;
}): Promise<Array<{ sessionId: string; title: string; updatedAt: string; cwd: string }>> {
  const cwd = resolve(opts.cwd);
  const manifest = await loadCodexSyncManifest(opts.syncPath);
  if (manifest === null) return [];
  if (resolve(manifest.cwd) !== cwd) return [];

  return Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    title: meta.title,
    updatedAt: meta.updatedAt,
    cwd,
  }));
}

export function isCodexSessionSynced(
  manifest: CodexSyncManifest | null,
  sessionId: string,
  cwd: string,
): boolean {
  if (manifest === null) return false;
  if (resolve(manifest.cwd) !== resolve(cwd)) return false;
  return manifest.sessions[sessionId] !== undefined;
}

export function isCodexDiskEngine(engineId: string): boolean {
  return engineId === 'codex' || engineId === 'tcodex';
}
