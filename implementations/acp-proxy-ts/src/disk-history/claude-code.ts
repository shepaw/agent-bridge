/**
 * Claude Code — `~/.claude/projects/{slug}/{sessionId}.jsonl`
 * Lines of type `user` / `assistant` carry ISO `timestamp`.
 */

import { readFile } from 'node:fs/promises';

import {
  claudeProjectSlug,
  homePath,
  pushTurn,
  splitAnthropicBlocks,
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
