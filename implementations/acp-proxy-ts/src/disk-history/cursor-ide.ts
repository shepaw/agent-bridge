/**
 * Cursor IDE desktop client transcripts:
 *   ~/.cursor/projects/{slug}/agent-transcripts/{sessionId}/{sessionId}.jsonl
 *
 * Slug encodes the absolute workspace path with `/` → `-` (same rule as Claude Code).
 * Only sessions under the matching workspace slug are visible to a Hub instance.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  claudeProjectSlug,
  homePath,
  pushTurn,
  splitAnthropicBlocks,
  type DiskHistoryMessage,
} from './util.js';

export interface CursorIdeSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function cursorIdeTranscriptsRoot(cwd: string): string {
  return homePath('.cursor', 'projects', claudeProjectSlug(cwd), 'agent-transcripts');
}

function transcriptPath(cwd: string, sessionId: string): string {
  return join(cursorIdeTranscriptsRoot(cwd), sessionId, `${sessionId}.jsonl`);
}

function blocksFromLine(obj: Record<string, unknown>): unknown {
  const message = obj.message;
  if (message !== null && typeof message === 'object') {
    return (message as Record<string, unknown>).content;
  }
  return obj.content;
}

/** Strip Cursor IDE envelope tags and return display text + optional timestamp. */
export function parseCursorIdeUserText(raw: string): { text: string; createdAt?: string } {
  let text = raw;
  let createdAt: string | undefined;
  const tsMatch = text.match(/<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/);
  if (tsMatch) {
    const ms = Date.parse(tsMatch[1]!.trim());
    if (!Number.isNaN(ms)) createdAt = new Date(ms).toISOString();
    text = text.replace(/<timestamp>\s*[\s\S]*?\s*<\/timestamp>\s*/g, '');
  }
  const uqMatch = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (uqMatch) text = uqMatch[1]!;
  return { text: text.trim(), createdAt };
}

function deriveTitle(messages: DiskHistoryMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (firstUser === undefined) return '';
  return firstUser.content.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function latestCreatedAt(messages: DiskHistoryMessage[]): string {
  let updatedAt = '';
  for (const m of messages) {
    if (m.created_at !== undefined && m.created_at.length > 0 && m.created_at > updatedAt) {
      updatedAt = m.created_at;
    }
  }
  return updatedAt;
}

export async function parseCursorIdeJsonl(path: string): Promise<DiskHistoryMessage[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }

  const out: DiskHistoryMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === 'turn_ended') continue;

    const roleRaw = obj.role;
    if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;

    const blocks = blocksFromLine(obj);
    const { answer, progress, progressTitle } = splitAnthropicBlocks(blocks);
    const role = roleRaw === 'user' ? 'user' : 'agent';
    let content = answer;
    let createdAt: string | undefined;
    if (role === 'user' && content.length > 0) {
      const parsed = parseCursorIdeUserText(content);
      content = parsed.text;
      createdAt = parsed.createdAt;
    }
    pushTurn(out, {
      role,
      content,
      progress: role === 'agent' ? progress : undefined,
      progressTitle: role === 'agent' ? progressTitle : undefined,
      createdAt,
      messageId: typeof obj.id === 'string' ? obj.id : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

export async function loadCursorIdeHistory(
  sessionId: string,
  cwd: string,
): Promise<DiskHistoryMessage[] | null> {
  return parseCursorIdeJsonl(transcriptPath(cwd, sessionId));
}

/**
 * List Cursor IDE conversations persisted for `cwd`. Skips subagent transcripts
 * and sessions with no readable user/agent turns.
 */
export async function listCursorIdeDiskSessions(cwd: string): Promise<CursorIdeSessionSummary[]> {
  const root = cursorIdeTranscriptsRoot(cwd);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const out: CursorIdeSessionSummary[] = [];
  for (const sessionId of entries) {
    if (sessionId.startsWith('.')) continue;
    const dirPath = join(root, sessionId);
    let dirStat;
    try {
      dirStat = await stat(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const messages = await loadCursorIdeHistory(sessionId, cwd);
    if (messages === null || messages.length === 0) continue;

    const title = deriveTitle(messages);
    if (title.length === 0) continue;

    out.push({
      sessionId,
      title,
      updatedAt: latestCreatedAt(messages),
      messageCount: messages.length,
    });
  }

  out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return out;
}

/** True when `candidateCwd` resolves to the same Cursor IDE project slug as `instanceCwd`. */
export function cursorIdeCwdMatches(instanceCwd: string, candidateCwd?: string): boolean {
  const base = resolve(instanceCwd);
  const other = resolve(candidateCwd ?? instanceCwd);
  return claudeProjectSlug(base) === claudeProjectSlug(other);
}
