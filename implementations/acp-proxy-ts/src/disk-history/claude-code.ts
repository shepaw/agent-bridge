/**
 * Claude Code — `~/.claude/projects/{slug}/{sessionId}.jsonl`
 * Lines of type `user` / `assistant` carry ISO `timestamp`.
 */

import { readFile } from 'node:fs/promises';

import {
  claudeProjectSlug,
  homePath,
  pushTurn,
  textFromContentBlocks,
  toIsoFromUnknown,
  type DiskHistoryMessage,
} from './util.js';

export async function loadClaudeCodeHistory(
  sessionId: string,
  cwd: string,
): Promise<DiskHistoryMessage[] | null> {
  const path = homePath('.claude', 'projects', claudeProjectSlug(cwd), `${sessionId}.jsonl`);
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
    let content = '';
    if (message !== null && typeof message === 'object') {
      content = textFromContentBlocks((message as Record<string, unknown>).content);
    } else {
      content = textFromContentBlocks(obj.content);
    }
    const role = type === 'user' ? 'user' : 'agent';
    const createdAt = toIsoFromUnknown(obj.timestamp);
    const messageId = typeof obj.uuid === 'string' ? obj.uuid : undefined;
    pushTurn(out, role, content, createdAt, messageId);
  }
  return out.length > 0 ? out : null;
}
