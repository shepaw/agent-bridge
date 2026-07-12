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
  textFromContentBlocks,
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
    const content = textFromContentBlocks(obj.content);
    const role = roleRaw === 'user' ? 'user' : 'agent';
    const createdAt = toIsoFromUnknown(obj.timestamp);
    const messageId = typeof obj.uuid === 'string'
      ? obj.uuid
      : typeof obj.id === 'string'
        ? obj.id
        : undefined;
    pushTurn(out, role, content, createdAt, messageId);
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
