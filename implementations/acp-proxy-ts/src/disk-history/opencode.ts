/**
 * OpenCode — `~/.local/share/opencode/storage/`
 *   message/{sessionId}/msg_*.json  — role + time.created
 *   part/{messageId}/prt_*.json     — text parts
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { homedir } from 'node:os';

import { diskCwdMatches, pushTurn, toIsoFromUnknown, type DiskHistoryMessage } from './util.js';
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

export interface OpencodeSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function deriveTitle(messages: DiskHistoryMessage[], fallback?: string): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (firstUser !== undefined) {
    return firstUser.content.trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  if (fallback !== undefined && fallback.trim().length > 0) {
    return fallback.trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  return '';
}

function latestCreatedAt(messages: DiskHistoryMessage[], fallback?: string): string {
  let updatedAt = fallback ?? '';
  for (const m of messages) {
    if (m.created_at !== undefined && m.created_at.length > 0 && m.created_at > updatedAt) {
      updatedAt = m.created_at;
    }
  }
  return updatedAt;
}

/**
 * List OpenCode CLI sessions whose `directory` matches `cwd`.
 * Reads OpenCode session metadata JSON under storage/session/.
 */
export async function listOpencodeDiskSessions(cwd: string): Promise<OpencodeSessionSummary[]> {
  const targetCwd = resolve(cwd);
  const sessionRoot = join(storageRoot(), 'session');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(sessionRoot);
  } catch {
    return [];
  }

  const out: OpencodeSessionSummary[] = [];
  for (const projectId of projectDirs) {
    const dir = join(sessionRoot, projectId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(dir, file), 'utf-8');
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const sessionId = typeof obj.id === 'string' ? obj.id : undefined;
        const directory = typeof obj.directory === 'string' ? obj.directory : undefined;
        if (sessionId === undefined || directory === undefined) continue;
        if (!diskCwdMatches(targetCwd, directory)) continue;

        const messages = await loadOpencodeHistory(sessionId);
        if (messages === null || messages.length === 0) continue;

        const metaTitle = typeof obj.title === 'string' ? obj.title : undefined;
        const title = deriveTitle(messages, metaTitle);
        if (title.length === 0) continue;

        const time = (obj.time ?? {}) as Record<string, unknown>;
        const updatedFallback = toIsoFromUnknown(time.updated) ?? toIsoFromUnknown(time.created);

        out.push({
          sessionId,
          title,
          updatedAt: latestCreatedAt(messages, updatedFallback),
          messageCount: messages.length,
        });
      } catch {
        // skip corrupt session meta
      }
    }
  }

  out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return out;
}

export function opencodeCwdMatches(instanceCwd: string, candidateCwd?: string): boolean {
  return diskCwdMatches(instanceCwd, candidateCwd ?? instanceCwd);
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
