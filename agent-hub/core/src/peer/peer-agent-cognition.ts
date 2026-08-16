/**
 * Peer relays for agent cognition: Soul + structured memory.
 *
 * The Shepaw app sends `agent_soul_req` / `agent_soul_set_req` /
 * `agent_memory_req` over the peer control channel. Every branch here answers
 * immediately — an unanswered relay leaves the app UI spinning until its
 * client-side timeout (~12s).
 *
 * On-disk layout mirrors the app's store convention
 * (`store://cognition/<device>/<agentId>/…`), rooted in the hub's own device
 * tree inside the local peer store:
 *   <store>/<hubDevice>/cognition/<agentId>/soul.md
 *   <store>/<hubDevice>/cognition/<agentId>/peers/<peerId>/entries/<id>.json
 *
 * Peer memory is isolated under `peers/<peerId>/` (same scoping as the app
 * host); Soul is a single document per agent and is not peer-scoped. Paired
 * peers are owner-trusted, so cognition is always served editable — the app
 * host's PeerBoundaryConfig has no hub equivalent.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getInstance, loadOrCreateHubConfig } from '../config.js';
import { hubStoreDeviceId } from './agent-store-mapping.js';
import { getPeerLocalStore } from './peer-local-store.js';

const COGNITION_SPACE = 'cognition';

/** Keep in sync with the app's RuntimePaths.sanitizeSegment. */
function sanitizeSegment(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) return '_default';
  return s
    .replace(/[/\\]+/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[^\w.\-@+]/g, '_');
}

function cognitionAbs(...segments: string[]): string {
  const store = getPeerLocalStore();
  return join(store.root, hubStoreDeviceId(), COGNITION_SPACE, ...segments);
}

function agentRoot(agentId: string): string {
  return sanitizeSegment(agentId);
}

/** Memory scope: peer subtree when peerId given, agent root otherwise. */
function scopedRoot(agentId: string, peerId?: string): string {
  const peer = peerId?.trim();
  if (!peer) return agentRoot(agentId);
  return `${agentRoot(agentId)}/peers/${sanitizeSegment(peer)}`;
}

function entriesDir(agentId: string, peerId?: string): string {
  return `${scopedRoot(agentId, peerId)}/entries`;
}

function metaPath(agentId: string, peerId?: string): string {
  return `${scopedRoot(agentId, peerId)}/meta.json`;
}

/** Unknown agent ids must still answer — the app treats no-reply as timeout. */
function instanceExists(agentId: string): boolean {
  try {
    getInstance(loadOrCreateHubConfig(), agentId);
    return true;
  } catch {
    return false;
  }
}

function writeFileAtomic(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, abs);
}

// ---------------------------------------------------------------------------
// Soul
// ---------------------------------------------------------------------------

/** Strip the optional HTML comment header written by soul exports. */
function stripSoulHeader(text: string): string {
  return text.replace(/^<!--[\s\S]*?-->\s*/, '').trimEnd();
}

function readSoul(agentId: string): string {
  const abs = cognitionAbs(agentRoot(agentId), 'soul.md');
  if (!existsSync(abs)) return '';
  return stripSoulHeader(readFileSync(abs, 'utf-8'));
}

function writeSoul(agentId: string, soul: string): void {
  const abs = cognitionAbs(agentRoot(agentId), 'soul.md');
  if (soul.trim().length === 0) {
    // Empty soul == no soul; remove so reads don't carry a stale header file.
    rmSync(abs, { force: true });
    return;
  }
  const header = `<!-- updated_at: ${new Date().toISOString()} -->\n`;
  writeFileAtomic(abs, `${header}${soul}\n`);
}

/** agent_soul_req { agent_id, request_id? } → agent_soul_resp */
export function handleAgentSoulGet(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const agentId = typeof obj.agent_id === 'string' ? obj.agent_id : '';
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : undefined;
  const base: Record<string, unknown> = {
    type: 'agent_soul_resp',
    agent_id: agentId,
    ...(requestId !== undefined && requestId.length > 0 ? { request_id: requestId } : {}),
  };
  if (agentId.length === 0) {
    return { ...base, ok: false, error: 'missing_agent_id' };
  }
  try {
    if (!instanceExists(agentId)) {
      return { ...base, ok: false, error: 'not_found' };
    }
    return { ...base, ok: true, soul: readSoul(agentId), editable: true };
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** agent_soul_set_req { agent_id, soul, request_id? } → agent_soul_set_resp */
export function handleAgentSoulSet(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const agentId = typeof obj.agent_id === 'string' ? obj.agent_id : '';
  const soul = typeof obj.soul === 'string' ? obj.soul : '';
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : undefined;
  const base: Record<string, unknown> = {
    type: 'agent_soul_set_resp',
    agent_id: agentId,
    ...(requestId !== undefined && requestId.length > 0 ? { request_id: requestId } : {}),
  };
  if (agentId.length === 0) {
    return { ...base, ok: false, error: 'missing_agent_id' };
  }
  try {
    if (!instanceExists(agentId)) {
      return { ...base, ok: false, error: 'not_found' };
    }
    writeSoul(agentId, soul);
    return { ...base, ok: true };
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Structured memory
// ---------------------------------------------------------------------------

/** Wire shape mirrors the app's AgentMemoryEntry.toJson (camelCase). */
interface MemoryEntryJson {
  memoryId: number | null;
  memoryContent: string;
  memoryTime: number;
  memoryType: string;
  memoryKeywords: string[];
  sourceType: string | null;
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
}

const MEMORY_TYPES = new Set(['conversation', 'knowledge', 'behavior', 'event', 'emotion']);

/** Tolerant parse, mirroring the app's AgentMemoryEntry.fromJson defaults. */
function parseMemoryEntry(raw: unknown): MemoryEntryJson | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const kw = rec.memoryKeywords;
  const type = typeof rec.memoryType === 'string' ? rec.memoryType : '';
  return {
    memoryId: typeof rec.memoryId === 'number' ? Math.trunc(rec.memoryId) : null,
    memoryContent: typeof rec.memoryContent === 'string' ? rec.memoryContent : '',
    memoryTime: typeof rec.memoryTime === 'number' ? Math.trunc(rec.memoryTime) : 0,
    memoryType: MEMORY_TYPES.has(type) ? type : 'conversation',
    memoryKeywords: Array.isArray(kw) ? kw.map(String) : [],
    sourceType: typeof rec.sourceType === 'string' ? rec.sourceType : null,
    sourceId: typeof rec.sourceId === 'string' ? rec.sourceId : null,
    createdAt: typeof rec.createdAt === 'number' ? Math.trunc(rec.createdAt) : 0,
    updatedAt: typeof rec.updatedAt === 'number' ? Math.trunc(rec.updatedAt) : 0,
  };
}

interface MemoryMeta {
  nextId: number;
}

function loadMeta(agentId: string, peerId?: string): MemoryMeta {
  const abs = cognitionAbs(metaPath(agentId, peerId));
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
    return { nextId: typeof raw.next_id === 'number' ? Math.trunc(raw.next_id) : 1 };
  } catch {
    return { nextId: 1 };
  }
}

function saveMeta(agentId: string, peerId: string | undefined, meta: MemoryMeta): void {
  writeFileAtomic(
    cognitionAbs(metaPath(agentId, peerId)),
    `${JSON.stringify({ schema_version: 1, next_id: meta.nextId }, null, 2)}\n`,
  );
}

function listEntries(agentId: string, peerId?: string): MemoryEntryJson[] {
  const dir = cognitionAbs(entriesDir(agentId, peerId));
  if (!existsSync(dir)) return [];
  const out: MemoryEntryJson[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = Number.parseInt(name.slice(0, -'.json'.length), 10);
    if (!Number.isFinite(id)) continue;
    try {
      const entry = parseMemoryEntry(
        JSON.parse(readFileSync(join(dir, name), 'utf-8')),
      );
      if (entry !== null) out.push(entry);
    } catch {
      /* skip malformed entry file */
    }
  }
  out.sort((a, b) => b.memoryTime - a.memoryTime);
  return out;
}

function writeEntry(agentId: string, peerId: string | undefined, entry: MemoryEntryJson): void {
  writeFileAtomic(
    cognitionAbs(entriesDir(agentId, peerId), `${entry.memoryId ?? 0}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
}

function numField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

/**
 * agent_memory_req { request_id, agent_id, op, type?, keyword?, limit?,
 * entry?, memory_id? } → agent_memory_resp
 *
 * ops: list | query | add | update | delete | clear — same semantics and
 * error codes as the app host (`peer_agent_host_service.dart`).
 */
export function handleAgentMemoryReq(
  peerId: string,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : '';
  const agentId = typeof obj.agent_id === 'string' ? obj.agent_id : '';
  const op = typeof obj.op === 'string' ? obj.op : 'list';
  const base: Record<string, unknown> = {
    type: 'agent_memory_resp',
    request_id: requestId,
    agent_id: agentId,
    editable: true,
  };
  if (agentId.length === 0) {
    return { ...base, ok: false, error: 'missing_agent_id' };
  }
  try {
    if (!instanceExists(agentId)) {
      return { ...base, ok: false, error: 'not_available' };
    }
    switch (op) {
      case 'list': {
        const type = typeof obj.type === 'string' ? obj.type : '';
        const limit = numField(obj.limit) ?? 200;
        let entries = listEntries(agentId, peerId);
        if (type.length > 0) entries = entries.filter((e) => e.memoryType === type);
        return { ...base, ok: true, memories: entries.slice(0, limit) };
      }
      case 'query': {
        const keyword = (typeof obj.keyword === 'string' ? obj.keyword : '').trim().toLowerCase();
        const limit = numField(obj.limit) ?? 50;
        const all = listEntries(agentId, peerId);
        const hits =
          keyword.length === 0
            ? all
            : all.filter(
                (e) =>
                  e.memoryContent.toLowerCase().includes(keyword) ||
                  e.memoryKeywords.some((k) => k.toLowerCase().includes(keyword)),
              );
        return { ...base, ok: true, memories: hits.slice(0, limit) };
      }
      case 'add': {
        const entry = parseMemoryEntry(obj.entry);
        if (entry === null) return { ...base, ok: false, error: 'invalid_entry' };
        const meta = loadMeta(agentId, peerId);
        const id = meta.nextId;
        saveMeta(agentId, peerId, { nextId: id + 1 });
        const now = Date.now();
        writeEntry(agentId, peerId, {
          ...entry,
          memoryId: id,
          createdAt: entry.createdAt === 0 ? now : entry.createdAt,
          updatedAt: now,
        });
        return { ...base, ok: true, memory_id: id };
      }
      case 'update': {
        const entry = parseMemoryEntry(obj.entry);
        if (entry === null) return { ...base, ok: false, error: 'invalid_entry' };
        if (entry.memoryId === null) return { ...base, ok: false, error: 'missing_memory_id' };
        writeEntry(agentId, peerId, { ...entry, updatedAt: Date.now() });
        return { ...base, ok: true };
      }
      case 'delete': {
        const memoryId = numField(obj.memory_id);
        if (memoryId === undefined) return { ...base, ok: false, error: 'missing_memory_id' };
        rmSync(cognitionAbs(entriesDir(agentId, peerId), `${memoryId}.json`), { force: true });
        return { ...base, ok: true };
      }
      case 'clear': {
        rmSync(cognitionAbs(entriesDir(agentId, peerId)), { recursive: true, force: true });
        saveMeta(agentId, peerId, { nextId: 1 });
        return { ...base, ok: true };
      }
      default:
        return { ...base, ok: false, error: 'unsupported' };
    }
  } catch (err) {
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
