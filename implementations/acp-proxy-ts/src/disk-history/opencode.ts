/**
 * OpenCode — `~/.local/share/opencode/storage/`
 *   message/{sessionId}/msg_*.json  — role + time.created
 *   part/{messageId}/prt_*.json     — text parts
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { homedir } from 'node:os';

import { pushTurn, toIsoFromUnknown, type DiskHistoryMessage } from './util.js';

function storageRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, 'opencode', 'storage');
  }
  return join(homedir(), '.local', 'share', 'opencode', 'storage');
}

async function loadTextParts(messageId: string): Promise<string> {
  const dir = join(storageRoot(), 'part', messageId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return '';
  }
  const chunks: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj.type === 'text' && typeof obj.text === 'string' && obj.text.trim().length > 0) {
        chunks.push(obj.text);
      }
    } catch {
      // skip corrupt part
    }
  }
  return chunks.join('\n').trim();
}

export async function loadOpencodeHistory(sessionId: string): Promise<DiskHistoryMessage[] | null> {
  const dir = join(storageRoot(), 'message', sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const rows: Array<{ role: 'user' | 'agent'; content: string; createdAt?: string; id: string; sort: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const roleRaw = obj.role;
      if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;
      const id = typeof obj.id === 'string' ? obj.id : name.replace(/\.json$/, '');
      const time = (obj.time ?? {}) as Record<string, unknown>;
      const sort = typeof time.created === 'number' ? time.created : 0;
      const createdAt = toIsoFromUnknown(time.created) ?? toIsoFromUnknown(time.completed);
      const content = await loadTextParts(id);
      rows.push({
        role: roleRaw === 'user' ? 'user' : 'agent',
        content,
        createdAt,
        id,
        sort,
      });
    } catch {
      // skip
    }
  }
  rows.sort((a, b) => a.sort - b.sort);
  const out: DiskHistoryMessage[] = [];
  for (const row of rows) {
    pushTurn(out, row.role, row.content, row.createdAt, row.id);
  }
  return out.length > 0 ? out : null;
}
