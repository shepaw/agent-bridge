/**
 * Manual Claude Code CLI → Shepaw session sync manifest.
 *
 * Hub writes this file when the user clicks "Sync Claude Code CLI sessions".
 * The gateway reads it to expose ONLY user-confirmed CLI conversations in
 * agent.sessions.list (never auto-scans disk on every list call).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  claudeCodeCwdMatches,
  listClaudeCodeDiskSessions,
  type ClaudeCodeSessionSummary,
} from './disk-history/claude-code.js';
import { claudeProjectSlug } from './disk-history/util.js';

export const CLAUDE_CODE_SYNC_FILENAME = 'claude-code-sync.json';

export interface ClaudeCodeSyncedSession {
  title: string;
  updatedAt: string;
  syncedAt: string;
  messageCount: number;
}

export interface ClaudeCodeSyncManifest {
  version: 1;
  cwd: string;
  sessions: Record<string, ClaudeCodeSyncedSession>;
}

export type ClaudeCodeSyncedEntry = ClaudeCodeSyncedSession & { sessionId: string };

export interface ClaudeCodeSyncPreview {
  cwd: string;
  workspaceSlug: string;
  onDisk: ClaudeCodeSessionSummary[];
  synced: ClaudeCodeSyncedEntry[];
  pending: ClaudeCodeSessionSummary[];
}

export interface ClaudeCodeSyncResult {
  cwd: string;
  added: number;
  updated: number;
  total: number;
  sessions: ClaudeCodeSyncedEntry[];
}

export function claudeCodeSyncPathFromSessionStore(sessionStorePath: string): string {
  return join(dirname(sessionStorePath), CLAUDE_CODE_SYNC_FILENAME);
}

export function emptyClaudeCodeSyncManifest(cwd: string): ClaudeCodeSyncManifest {
  return { version: 1, cwd: resolve(cwd), sessions: {} };
}

export async function loadClaudeCodeSyncManifest(
  path: string,
): Promise<ClaudeCodeSyncManifest | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as ClaudeCodeSyncManifest;
    if (parsed.version !== 1 || typeof parsed.cwd !== 'string') return null;
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveClaudeCodeSyncManifest(
  path: string,
  manifest: ClaudeCodeSyncManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function previewClaudeCodeSync(opts: {
  cwd: string;
  syncPath: string;
}): Promise<ClaudeCodeSyncPreview> {
  const cwd = resolve(opts.cwd);
  if (!claudeCodeCwdMatches(cwd)) {
    throw new Error('Claude Code sync cwd mismatch');
  }
  const onDisk = await listClaudeCodeDiskSessions(cwd);
  const manifest =
    (await loadClaudeCodeSyncManifest(opts.syncPath)) ?? emptyClaudeCodeSyncManifest(cwd);

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

export async function runClaudeCodeSync(opts: {
  cwd: string;
  syncPath: string;
  sessionIds?: readonly string[];
}): Promise<ClaudeCodeSyncResult> {
  const cwd = resolve(opts.cwd);
  const preview = await previewClaudeCodeSync({ cwd, syncPath: opts.syncPath });
  const manifest =
    (await loadClaudeCodeSyncManifest(opts.syncPath)) ?? emptyClaudeCodeSyncManifest(cwd);
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

  await saveClaudeCodeSyncManifest(opts.syncPath, manifest);

  const sessions = Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    ...meta,
  }));

  return { cwd, added, updated, total: sessions.length, sessions };
}

export async function listSyncedClaudeCodeSessions(opts: {
  cwd: string;
  syncPath: string;
}): Promise<Array<{ sessionId: string; title: string; updatedAt: string; cwd: string }>> {
  const cwd = resolve(opts.cwd);
  const manifest = await loadClaudeCodeSyncManifest(opts.syncPath);
  if (manifest === null) return [];
  if (resolve(manifest.cwd) !== cwd) return [];

  return Object.entries(manifest.sessions).map(([sessionId, meta]) => ({
    sessionId,
    title: meta.title,
    updatedAt: meta.updatedAt,
    cwd,
  }));
}

export function isClaudeCodeSessionSynced(
  manifest: ClaudeCodeSyncManifest | null,
  sessionId: string,
  cwd: string,
): boolean {
  if (manifest === null) return false;
  if (resolve(manifest.cwd) !== resolve(cwd)) return false;
  return manifest.sessions[sessionId] !== undefined;
}

/** Engines that read ~/.claude/projects/{slug} for CLI transcripts. */
export function isClaudeCodeDiskEngine(engineId: string): boolean {
  return engineId === 'claude-code' || engineId === 'tclaude' || engineId === 'claude-internal';
}
