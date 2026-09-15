/**
 * Claude Code CLI — `~/.claude/projects/{slug}/{sessionId}.jsonl`
 * Lines of type `user` / `assistant` carry ISO `timestamp`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  claudeProjectSlug,
  homePath,
  pushTurn,
  splitAnthropicBlocks,
  toIsoFromUnknown,
  type DiskHistoryMessage,
} from './util.js';

export interface ClaudeCodeSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function claudeCodeProjectsDir(cwd: string): string {
  return homePath('.claude', 'projects', claudeProjectSlug(cwd));
}

export async function loadClaudeCodeHistory(
  sessionId: string,
  cwd: string,
): Promise<DiskHistoryMessage[] | null> {
  const path = joinClaudeCodeSessionPath(cwd, sessionId);
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
    const type = obj.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = obj.message;
    const blocks =
      message !== null && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : obj.content;
    const { answer, progress, progressTitle } = splitAnthropicBlocks(blocks);
    const role = type === 'user' ? 'user' : 'agent';
    pushTurn(out, {
      role,
      content: answer,
      // Tool calls / thinking only make sense on the agent side.
      progress: role === 'agent' ? progress : undefined,
      progressTitle: role === 'agent' ? progressTitle : undefined,
      createdAt: toIsoFromUnknown(obj.timestamp),
      messageId: typeof obj.uuid === 'string' ? obj.uuid : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

function joinClaudeCodeSessionPath(cwd: string, sessionId: string): string {
  return homePath('.claude', 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);
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

/**
 * List Claude Code CLI sessions on disk for `cwd`. Only reads
 * `~/.claude/projects/{slug}/*.jsonl` for the matching workspace slug.
 */
export async function listClaudeCodeDiskSessions(cwd: string): Promise<ClaudeCodeSessionSummary[]> {
  const dir = claudeCodeProjectsDir(cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const out: ClaudeCodeSessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const sessionId = file.slice(0, -'.jsonl'.length);
    const messages = await loadClaudeCodeHistory(sessionId, cwd);
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

/** True when `candidateCwd` resolves to the same Claude Code project slug as `instanceCwd`. */
export function claudeCodeCwdMatches(instanceCwd: string, candidateCwd?: string): boolean {
  const base = resolve(instanceCwd);
  const other = resolve(candidateCwd ?? instanceCwd);
  return claudeProjectSlug(base) === claudeProjectSlug(other);
}
