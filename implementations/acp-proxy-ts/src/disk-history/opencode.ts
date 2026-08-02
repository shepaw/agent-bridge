/**
 * OpenCode — `~/.local/share/opencode/storage/`
 *   message/{sessionId}/msg_*.json  — role + time.created
 *   part/{messageId}/prt_*.json     — text parts
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { homedir } from 'node:os';

import { pushTurn, toIsoFromUnknown, type DiskHistoryMessage } from './util.js';
import { formatToolLines } from '../permission/format.js';

function storageRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, 'opencode', 'storage');
  }
  return join(homedir(), '.local', 'share', 'opencode', 'storage');
}

interface OpenCodeParts {
  answer: string;
  progress: string;
  progressTitle?: string;
}

/** Read a message's parts: text → answer; tool / reasoning → progress. */
async function loadParts(messageId: string): Promise<OpenCodeParts> {
  const dir = join(storageRoot(), 'part', messageId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { answer: '', progress: '' };
  }
  const answers: string[] = [];
  const progressParts: string[] = [];
  let progressTitle: string | undefined;
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj.type === 'text' && typeof obj.text === 'string' && obj.text.trim().length > 0) {
        answers.push(obj.text);
        continue;
      }
      if (obj.type === 'reasoning' && typeof obj.text === 'string' && obj.text.trim().length > 0) {
        progressParts.push(obj.text.trim());
        progressTitle = 'Thinking';
        continue;
      }
      if (obj.type === 'tool') {
        const toolName = typeof obj.tool === 'string' && obj.tool.length > 0 ? obj.tool : 'Tool';
        const state = (obj.state ?? {}) as Record<string, unknown>;
        const input = (state.input ?? {}) as Record<string, unknown>;
        const command = typeof input.command === 'string' ? input.command : undefined;
        const paths: string[] = [];
        for (const key of ['filePath', 'file_path', 'path']) {
          const v = input[key];
          if (typeof v === 'string' && v.length > 0) paths.push(v);
        }
        const status = typeof state.status === 'string' ? state.status : 'completed';
        progressParts.push(formatToolLines(status, toolName, command, paths).trimEnd());
        progressTitle = toolName;
      }
    } catch {
      // skip corrupt part
    }
  }
  return {
    answer: answers.join('\n').trim(),
    progress: progressParts.join('\n'),
    progressTitle,
  };
}

export async function loadOpencodeHistory(sessionId: string): Promise<DiskHistoryMessage[] | null> {
  const dir = join(storageRoot(), 'message', sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const rows: Array<{
    role: 'user' | 'agent';
    parts: OpenCodeParts;
    createdAt?: string;
    id: string;
    sort: number;
  }> = [];
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
      const parts = await loadParts(id);
      rows.push({
        role: roleRaw === 'user' ? 'user' : 'agent',
        parts,
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
    pushTurn(out, {
      role: row.role,
      content: row.parts.answer,
      progress: row.role === 'agent' ? row.parts.progress : undefined,
      progressTitle: row.role === 'agent' ? row.parts.progressTitle : undefined,
      createdAt: row.createdAt,
      messageId: row.id,
    });
  }
  return out.length > 0 ? out : null;
}
