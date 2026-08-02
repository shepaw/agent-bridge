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
import { formatToolLines } from '../permission/format.js';

/** reasoning payload → thinking text (progress section). */
function reasoningText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const s of (payload.summary ?? []) as unknown[]) {
    if (s !== null && typeof s === 'object') {
      const t = (s as Record<string, unknown>).text;
      if (typeof t === 'string' && t.trim().length > 0) parts.push(t.trim());
    }
  }
  if (parts.length > 0) return parts.join('\n');
  const content = payload.content;
  if (typeof content === 'string' && content.trim().length > 0) return content.trim();
  return '';
}

/** function_call / local_shell_call / custom_tool_call → live-style tool text. */
function toolCallText(payload: Record<string, unknown>): { text: string; title: string } | null {
  const type = payload.type;
  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : 'Tool';
    const args = typeof payload.arguments === 'string'
      ? payload.arguments
      : typeof payload.input === 'string'
        ? payload.input
        : undefined;
    return { text: formatToolLines('completed', name, args, undefined).trimEnd(), title: name };
  }
  if (type === 'local_shell_call') {
    const action = (payload.action ?? {}) as Record<string, unknown>;
    const command = Array.isArray(action.command)
      ? (action.command as unknown[]).filter((x): x is string => typeof x === 'string').join(' ')
      : undefined;
    return { text: formatToolLines('completed', 'Shell', command, undefined).trimEnd(), title: 'Shell' };
  }
  return null;
}

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
      pushTurn(out, {
        role: roleRaw === 'user' ? 'user' : 'agent',
        content,
        createdAt,
      });
      continue;
    }

    if (obj.type === 'response_item' && payload.type === 'reasoning') {
      const text = reasoningText(payload);
      if (text.length === 0) continue;
      pushTurn(out, {
        role: 'agent',
        content: '',
        progress: text,
        progressTitle: 'Thinking',
        createdAt,
      });
      continue;
    }

    if (obj.type === 'response_item') {
      const tool = toolCallText(payload);
      if (tool === null) continue;
      pushTurn(out, {
        role: 'agent',
        content: '',
        progress: tool.text,
        progressTitle: tool.title,
        createdAt,
      });
      continue;
    }

    if (obj.type === 'event_msg' && payload.type === 'task_complete') {
      const text = payload.last_agent_message;
      if (typeof text !== 'string' || text.trim().length === 0) continue;
      // task_complete repeats the final assistant message; the response_item
      // entries above already carried it (now coalesced into one agent turn).
      const trimmed = text.trim();
      const last = out[out.length - 1];
      if (
        last !== undefined &&
        last.role === 'agent' &&
        (last.content === trimmed || last.content.endsWith(trimmed))
      ) {
        continue;
      }
      const at = toIsoFromUnknown(payload.completed_at) ?? createdAt;
      pushTurn(out, { role: 'agent', content: text, createdAt: at });
    }
  }
  return out.length > 0 ? out : null;
}
