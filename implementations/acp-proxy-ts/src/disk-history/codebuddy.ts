/**
 * CodeBuddy / OpenClaw-style JSONL:
 *   ~/.codebuddy/projects/{slug}/{sessionId}.jsonl
 *   ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
 *
 * Message lines: type=message, role, timestamp (ms), content blocks.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  codebuddyProjectSlug,
  homePath,
  pushTurn,
  splitAnthropicBlocks,
  toIsoFromUnknown,
  type DiskHistoryMessage,
} from './util.js';

async function parseMessageJsonl(path: string): Promise<DiskHistoryMessage[] | null> {
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
    const roleRaw = obj.role;
    if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;
    if (obj.type !== undefined && obj.type !== 'message') continue;
    const { answer, progress, progressTitle } = splitAnthropicBlocks(obj.content);
    const role = roleRaw === 'user' ? 'user' : 'agent';
    pushTurn(out, {
      role,
      content: answer,
      progress: role === 'agent' ? progress : undefined,
      progressTitle: role === 'agent' ? progressTitle : undefined,
      createdAt: toIsoFromUnknown(obj.timestamp),
      messageId: typeof obj.uuid === 'string'
        ? obj.uuid
        : typeof obj.id === 'string'
          ? obj.id
          : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

export async function loadCodebuddyHistory(
  sessionId: string,
  cwd: string,
): Promise<DiskHistoryMessage[] | null> {
  const path = homePath(
    '.codebuddy',
    'projects',
    codebuddyProjectSlug(cwd),
    `${sessionId}.jsonl`,
  );
  return parseMessageJsonl(path);
}

/** A session discovered on disk: id + a derived display title + last activity. */
export interface DiskSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
}

/**
 * Enumerate CodeBuddy sessions persisted on disk for `cwd` and derive a title
 * (first user message) and `updatedAt` (latest message timestamp) for each.
 *
 * CodeBuddy's ACP server does not advertise `sessionCapabilities.list`, so the
 * live `session/list` RPC returns nothing — yet transcripts live in
 * `~/.codebuddy/projects/{slug}/{sessionId}.jsonl`. Scanning that store is what
 * lets the app show historical CodeBuddy conversations (and real titles) in
 * the session list instead of an empty panel.
 *
 * Returns `[]` when the project directory is absent or unreadable.
 */
export async function listCodebuddyDiskSessions(cwd: string): Promise<DiskSessionSummary[]> {
  const dir = homePath('.codebuddy', 'projects', codebuddyProjectSlug(cwd));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const out: DiskSessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const sessionId = file.slice(0, -'.jsonl'.length);
    const messages = await loadCodebuddyHistory(sessionId, cwd);
    if (messages === null || messages.length === 0) continue;

    const firstUser = messages.find((m) => m.role === 'user');
    const derived = firstUser !== undefined && firstUser.content.trim().length > 0
      ? firstUser.content.trim().replace(/\s+/g, ' ').slice(0, 80)
      : sessionId;
    let updatedAt = '';
    for (const m of messages) {
      if (m.created_at !== undefined && m.created_at.length > 0 && m.created_at > updatedAt) {
        updatedAt = m.created_at;
      }
    }
    out.push({ sessionId, title: derived, updatedAt });
  }
  return out;
}

export async function loadOpenclawHistory(
  sessionId: string,
): Promise<DiskHistoryMessage[] | null> {
  const agentsRoot = homePath('.openclaw', 'agents');
  let agents: string[];
  try {
    agents = await readdir(agentsRoot);
  } catch {
    return null;
  }
  for (const agentId of agents) {
    const direct = join(agentsRoot, agentId, 'sessions', `${sessionId}.jsonl`);
    const hit = await parseMessageJsonl(direct);
    if (hit !== null) return hit;
  }
  return null;
}
