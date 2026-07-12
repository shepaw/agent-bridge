/**
 * Codex — ~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-*-{sessionId}.jsonl
 *
 * User turns: response_item / payload.type=message / role=user
 * Agent turns: same with role=assistant, or event_msg task_complete
 * with last_agent_message when present.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  homePath,
  pushTurn,
  textFromContentBlocks,
  toIsoFromUnknown,
  type DiskHistoryMessage,
} from './util.js';

async function findCodexRollout(sessionId: string): Promise<string | null> {
  const root = homePath('.codex', 'sessions');
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (ent.isFile() && ent.name.endsWith(`${sessionId}.jsonl`)) {
        return full;
      }
      // Filenames look like: rollout-2026-05-16T08-33-26-{uuid}.jsonl
      if (ent.isFile() && ent.name.includes(sessionId) && ent.name.endsWith('.jsonl')) {
        return full;
      }
    }
  }
  return null;
}

export async function loadCodexHistory(sessionId: string): Promise<DiskHistoryMessage[] | null> {
  const path = await findCodexRollout(sessionId);
  if (path === null) return null;
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
    const createdAt = toIsoFromUnknown(obj.timestamp);
    const payload = (obj.payload ?? {}) as Record<string, unknown>;

    if (obj.type === 'response_item' && payload.type === 'message') {
      const roleRaw = payload.role;
      if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;
      const content = textFromContentBlocks(payload.content);
      pushTurn(out, roleRaw === 'user' ? 'user' : 'agent', content, createdAt);
      continue;
    }

    if (obj.type === 'event_msg' && payload.type === 'task_complete') {
      const text = payload.last_agent_message;
      if (typeof text !== 'string' || text.trim().length === 0) continue;
      const at = toIsoFromUnknown(payload.completed_at) ?? createdAt;
      pushTurn(out, 'agent', text, at);
    }
  }
  return out.length > 0 ? out : null;
}
