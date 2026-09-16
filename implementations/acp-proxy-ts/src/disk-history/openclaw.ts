/**
 * OpenClaw — `~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`
 *
 * Message lines match CodeBuddy-style JSONL (type=message, role, timestamp).
 * Workspace binding uses session metadata on disk (jsonl header or sidecar json)
 * and per-agent workspace config when present.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  diskCwdMatches,
  homePath,
  pushTurn,
  splitAnthropicBlocks,
  toIsoFromUnknown,
  type DiskHistoryMessage,
} from './util.js';

export interface OpenclawSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

function cwdFromRecord(obj: Record<string, unknown>): string | undefined {
  for (const key of ['cwd', 'workspace', 'directory', 'workingDirectory'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

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

async function readOpenclawSessionMetaJson(
  sessionsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  for (const name of [`${sessionId}.json`, `${sessionId}.meta.json`]) {
    try {
      const raw = await readFile(join(sessionsDir, name), 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const cwd = cwdFromRecord(obj);
      if (cwd !== undefined) return cwd;
    } catch {
      // try next sidecar name
    }
  }
  return undefined;
}

async function readOpenclawSessionCwdFromJsonl(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n').slice(0, 40)) {
    if (line.trim().length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj.type;
    if (type === 'session_meta' || type === 'meta' || type === 'session') {
      const payload = (obj.payload ?? obj) as Record<string, unknown>;
      const cwd = cwdFromRecord(payload);
      if (cwd !== undefined) return cwd;
    }
    const top = cwdFromRecord(obj);
    if (top !== undefined) return top;
  }
  return undefined;
}

async function readAgentWorkspace(agentId: string): Promise<string | undefined> {
  const agentsRoot = homePath('.openclaw', 'agents');
  for (const name of ['agent.json', 'config.json']) {
    try {
      const raw = await readFile(join(agentsRoot, agentId, name), 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const cwd = cwdFromRecord(obj);
      if (cwd !== undefined) return cwd;
    } catch {
      // try next file
    }
  }

  try {
    const raw = await readFile(homePath('.openclaw', 'openclaw.json'), 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const agents = (cfg.agents ?? {}) as Record<string, unknown>;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
    const perAgent = (agents[agentId] ?? {}) as Record<string, unknown>;
    return cwdFromRecord(perAgent) ?? cwdFromRecord(defaults);
  } catch {
    return undefined;
  }
}

async function resolveOpenclawSessionCwd(
  agentId: string,
  sessionId: string,
  jsonlPath: string,
): Promise<string | undefined> {
  const sessionsDir = join(homePath('.openclaw', 'agents', agentId), 'sessions');
  return (
    (await readOpenclawSessionMetaJson(sessionsDir, sessionId)) ??
    (await readOpenclawSessionCwdFromJsonl(jsonlPath)) ??
    (await readAgentWorkspace(agentId))
  );
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

/** List OpenClaw sessions on disk whose resolved workspace cwd matches `cwd`. */
export async function listOpenclawDiskSessions(cwd: string): Promise<OpenclawSessionSummary[]> {
  const targetCwd = resolve(cwd);
  const agentsRoot = homePath('.openclaw', 'agents');
  let agents: string[];
  try {
    agents = await readdir(agentsRoot);
  } catch {
    return [];
  }

  const out: OpenclawSessionSummary[] = [];
  for (const agentId of agents) {
    const sessionsDir = join(agentsRoot, agentId, 'sessions');
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      const jsonlPath = join(sessionsDir, file);
      const sessionCwd = await resolveOpenclawSessionCwd(agentId, sessionId, jsonlPath);
      if (sessionCwd === undefined || !diskCwdMatches(targetCwd, sessionCwd)) continue;

      const messages = await parseMessageJsonl(jsonlPath);
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
  }

  out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return out;
}

export function openclawCwdMatches(instanceCwd: string, candidateCwd?: string): boolean {
  return diskCwdMatches(instanceCwd, candidateCwd ?? instanceCwd);
}
