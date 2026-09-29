/**
 * Host-owned pouch records: session registry, orchestration inbox, store
 * search, and 惜宝's built-in tools. Files live in the hub store tree so
 * `shepaw store read` sees the same bytes.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALL_SPACES, getPeerLocalStore } from './peer-local-store.js';
import { hubStoreDeviceId } from './agent-store-mapping.js';
import type { OrchestrationInbox } from './pouch-host.js';
import type { SheToolSpec } from './pouch-host.js';

const SEARCH_SPACES = [...ALL_SPACES].filter((space) => space !== 'backups');
const MAX_SEARCH_BYTES = 200_000;
const MAX_SEARCH_HITS = 30;

export interface PouchSessionRecord {
  readonly id: string;
  readonly kind: 'dm' | 'group';
  readonly agent_ids: readonly string[];
  readonly admin_agent_id?: string;
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly reason?: string;
  readonly previous_channel_id?: string;
}

function deviceId(): string {
  return hubStoreDeviceId();
}

function writeText(space: string, path: string, text: string, owner = deviceId()): void {
  const store = getPeerLocalStore();
  const abs = store.absPath(owner, space, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function readText(space: string, path: string, owner = deviceId()): string | undefined {
  try {
    const store = getPeerLocalStore();
    const meta = store.meta(owner, space, path);
    if (meta.kind === 'dir') return undefined;
    const size = typeof meta.size === 'number' ? meta.size : 0;
    if (size <= 0) return '';
    const { data } = store.read(owner, space, path, 0, size);
    return data.toString('utf8');
  } catch {
    return undefined;
  }
}

function registryPath(): string {
  return 'registry.json';
}

export function loadPouchSessions(): PouchSessionRecord[] {
  const raw = readText('sessions', registryPath());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PouchSessionRecord => {
      if (!item || typeof item !== 'object') return false;
      const rec = item as PouchSessionRecord;
      return typeof rec.id === 'string' && (rec.kind === 'dm' || rec.kind === 'group');
    });
  } catch {
    return [];
  }
}

export function upsertPouchSession(input: {
  id: string;
  kind: 'dm' | 'group';
  agentIds?: readonly string[];
  adminAgentId?: string;
  title?: string;
  reason?: string;
  previousChannelId?: string;
  now?: number;
}): PouchSessionRecord {
  const now = input.now ?? Date.now();
  const all = loadPouchSessions();
  const prev = all.find((item) => item.id === input.id);
  const next: PouchSessionRecord = {
    id: input.id,
    kind: input.kind,
    agent_ids: input.agentIds ?? prev?.agent_ids ?? [],
    ...(input.adminAgentId || prev?.admin_agent_id
      ? { admin_agent_id: input.adminAgentId || prev?.admin_agent_id }
      : {}),
    title: (input.title ?? prev?.title ?? '').slice(0, 80),
    created_at: prev?.created_at ?? now,
    updated_at: now,
    ...(input.reason || prev?.reason ? { reason: input.reason || prev?.reason } : {}),
    ...(input.previousChannelId || prev?.previous_channel_id
      ? { previous_channel_id: input.previousChannelId || prev?.previous_channel_id }
      : {}),
  };
  const rest = all.filter((item) => item.id !== input.id);
  writeText('sessions', registryPath(), JSON.stringify([next, ...rest], null, 2));
  return next;
}

/** Create a channel on this host. The phone is not asked. */
export function createLocalPouchSession(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const kind = payload.kind === 'group' ? 'group' : payload.kind === 'dm' ? 'dm' : '';
  if (!kind) return { error: 'kind must be dm or group' };
  const reason = String(payload.reason ?? '').trim();
  if (!reason) return { error: 'Missing required flag: --reason' };
  const id = `${kind}_${randomUUID()}`;
  const summary = String(payload.summary ?? '').trim();
  const previous = String(payload.channel_id ?? '').trim();
  const agentId = String(payload.agent_id ?? '').trim();
  upsertPouchSession({
    id,
    kind,
    agentIds: agentId ? [agentId] : [],
    title: summary || reason,
    reason,
    previousChannelId: previous || undefined,
  });
  const handoff = payload.handoff;
  if (handoff && typeof handoff === 'object') {
    writeText('sessions', `handoffs/${id}.json`, JSON.stringify(handoff));
  }
  const handoffUri = String(payload.handoff_uri ?? '').trim();
  return {
    ok: true,
    new_session_id: id,
    channel_id: id,
    kind,
    ...(previous ? { previous_channel_id: previous } : {}),
    ...(summary ? { summary } : {}),
    ...(handoffUri ? { handoff_uri: handoffUri } : {}),
  };
}

export function groupWorkspaceRoot(groupId: string): string {
  const id = groupId.trim();
  return id.startsWith('group_') ? id : `group_${id}`;
}

export function orchestrationInboxPath(
  groupId: string,
  sessionId: string,
  file: string,
): string {
  return `${groupWorkspaceRoot(groupId)}/shared/orchestration/${sessionId}/inbox/${file}`;
}

function writeInbox(
  groupId: string,
  sessionId: string,
  file: string,
  payload: Record<string, unknown>,
): void {
  const body = { issued_at: new Date().toISOString(), ...payload };
  writeText(
    'workspaces',
    orchestrationInboxPath(groupId, sessionId, file),
    JSON.stringify(body),
  );
}

function readInboxFile(
  groupId: string,
  sessionId: string,
  file: string,
  sinceMs: number,
): Record<string, unknown> | undefined {
  const raw = readText('workspaces', orchestrationInboxPath(groupId, sessionId, file));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const issued = typeof parsed.issued_at === 'string' ? Date.parse(parsed.issued_at) : Number.NaN;
    if (Number.isFinite(issued) && issued < sinceMs) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Inbox files written at or after `sinceMs` (missing issued_at still counts). */
export function readOrchestrationInbox(query: {
  groupId: string;
  sessionId: string;
  sinceMs: number;
}): OrchestrationInbox | undefined {
  const dispatch = readInboxFile(query.groupId, query.sessionId, 'dispatch.json', query.sinceMs);
  const finish = readInboxFile(query.groupId, query.sessionId, 'finish.json', query.sinceMs);
  const mentions = readInboxFile(query.groupId, query.sessionId, 'mentions.json', query.sinceMs);
  if (!dispatch && !finish && !mentions) return undefined;
  const steps = Array.isArray(dispatch?.steps) ? dispatch.steps : [];
  const mentionList = Array.isArray(mentions?.mentions) ? mentions.mentions : [];
  const action = typeof finish?.action === 'string' ? finish.action : '';
  return {
    ...(action === 'done' || action === 'continue' || action === 'pause'
      ? { finish: action }
      : {}),
    ...(dispatch
      ? {
          mode: dispatch.mode === 'sequential' ? 'sequential' : 'concurrent',
          steps: steps.flatMap((step) => {
            if (!step || typeof step !== 'object') return [];
            const rec = step as Record<string, unknown>;
            const agents = Array.isArray(rec.agents) ? rec.agents.map(String) : [];
            const task = String(rec.task ?? '');
            if (agents.length === 0 || task.length === 0) return [];
            const n = typeof rec.step === 'number' ? rec.step : undefined;
            return [{ agents, task, ...(n !== undefined ? { step: n } : {}) }];
          }),
        }
      : {}),
    ...(mentionList.length > 0
      ? {
          mentions: mentionList.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const rec = item as Record<string, unknown>;
            const name = String(rec.name ?? '').trim();
            if (!name) return [];
            return [{
              name,
              ...(rec.notify === false ? { notify: false } : {}),
              ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
            }];
          }),
        }
      : {}),
  };
}

const STORE_URI = /^store:\/\/([^/]+)\/([a-f0-9]{16})(?:\/(.*))?$/i;

export function searchLocalStore(input: {
  query: string;
  space?: string;
  uri?: string;
  deviceId?: string;
}): { hits: Array<{ uri: string; path: string; space: string; excerpt: string }> } {
  const query = input.query.trim().toLowerCase();
  const owner = (input.deviceId ?? deviceId()).toLowerCase();
  let spaces = input.space ? [input.space] : SEARCH_SPACES;
  let prefix = '';
  if (input.uri) {
    const match = STORE_URI.exec(input.uri.trim());
    if (match) {
      spaces = [match[1] ?? ''];
      prefix = match[3] ?? '';
    }
  }
  const hits: Array<{ uri: string; path: string; space: string; excerpt: string }> = [];
  const store = getPeerLocalStore();
  for (const space of spaces) {
    if (!SEARCH_SPACES.includes(space) && space !== input.space) continue;
    if (!ALL_SPACES.has(space)) continue;
    let cursor: string | undefined;
    for (let page = 0; page < 8 && hits.length < MAX_SEARCH_HITS; page += 1) {
      let listed;
      try {
        listed = store.listPage({
          deviceId: owner,
          space,
          prefix: prefix || undefined,
          limit: 500,
          computeHash: false,
          cursor,
        });
      } catch {
        break;
      }
      for (const entry of listed.entries) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        if (entry.kind === 'dir') continue;
        if (entry.size <= 0 || entry.size > MAX_SEARCH_BYTES) continue;
        let text = '';
        try {
          text = store.read(owner, space, entry.path, 0, entry.size).data.toString('utf8');
        } catch {
          continue;
        }
        if (text.includes('\0')) continue;
        const at = text.toLowerCase().indexOf(query);
        if (at < 0 && !entry.path.toLowerCase().includes(query)) continue;
        const excerpt = at < 0
          ? entry.path
          : text.slice(Math.max(0, at - 40), at + query.length + 80).replace(/\s+/g, ' ');
        hits.push({
          uri: `store://${space}/${owner}/${entry.path}`,
          path: entry.path,
          space,
          excerpt,
        });
      }
      if (!listed.next_cursor) break;
      cursor = listed.next_cursor;
    }
  }
  return { hits };
}

export function sheToolSpecs(opts: {
  group: boolean;
  memberNames: readonly string[];
}): SheToolSpec[] {
  const tools: SheToolSpec[] = [
    {
      name: 'store_read',
      description: 'Read a store:// URI on this host pouch.',
      parameters: {
        type: 'object',
        properties: { uri: { type: 'string' } },
        required: ['uri'],
      },
    },
    {
      name: 'store_list',
      description: 'List one store:// directory on this host pouch.',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string' },
          depth: { type: 'integer' },
        },
        required: ['uri'],
      },
    },
    {
      name: 'store_write',
      description: 'Write a text file into this host pouch. Default space is runtime.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          space: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  ];
  if (!opts.group) return tools;
  const names = opts.memberNames.filter((name) => name.trim().length > 0);
  tools.push(
    {
      name: 'group_dispatch',
      description: 'Assign group members. steps: [{agents, task}]. mode concurrent or sequential.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['concurrent', 'sequential'] },
          steps: { type: 'array' },
        },
        required: ['steps'],
      },
    },
    {
      name: 'group_finish',
      description: 'End the round: done, continue, or pause.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['done', 'continue', 'pause'] } },
        required: ['action'],
      },
    },
    {
      name: 'group_mention',
      description: `Activate members by name${names.length > 0 ? ` (${names.join(', ')})` : ''}.`,
      parameters: {
        type: 'object',
        properties: { mentions: { type: 'array' } },
        required: ['mentions'],
      },
    },
  );
  return tools;
}

export async function executeSheTool(input: {
  name: string;
  args: Record<string, unknown>;
  groupId?: string;
  sessionId?: string;
}): Promise<string> {
  try {
    return JSON.stringify(runSheTool(input));
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function runSheTool(input: {
  name: string;
  args: Record<string, unknown>;
  groupId?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const args = input.args;
  if (input.name === 'store_read' || input.name === 'store_list') {
    const uri = String(args.uri ?? '');
    const match = STORE_URI.exec(uri.trim());
    if (!match) return { error: 'bad_uri' };
    const space = match[1] ?? '';
    const owner = (match[2] ?? '').toLowerCase();
    const path = match[3] ?? '';
    if (input.name === 'store_read') {
      if (!path) return { error: 'bad_uri' };
      const text = readText(space, path, owner);
      if (text === undefined) return { error: 'not_found', uri };
      return { uri, content: text };
    }
    const depth = typeof args.depth === 'number' ? args.depth : 1;
    const page = getPeerLocalStore().listPage({
      deviceId: owner,
      space,
      prefix: path || undefined,
      depth,
      limit: 200,
      computeHash: false,
    });
    return { uri, entries: page.entries };
  }
  if (input.name === 'store_write') {
    const path = String(args.path ?? '').trim();
    const content = String(args.content ?? '');
    const space = String(args.space ?? 'runtime').trim() || 'runtime';
    if (!path) return { error: 'missing path' };
    if (!ALL_SPACES.has(space)) return { error: 'bad_op', space };
    writeText(space, path, content);
    const owner = deviceId();
    return { uri: `store://${space}/${owner}/${path}` };
  }
  if (!input.groupId || !input.sessionId) {
    return { error: 'group tools need a group turn' };
  }
  if (input.name === 'group_dispatch') {
    const steps = args.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      return { error: 'group_dispatch.steps must be a non-empty array' };
    }
    writeInbox(input.groupId, input.sessionId, 'dispatch.json', {
      kind: 'dispatch',
      mode: String(args.mode ?? 'concurrent'),
      steps,
    });
    return { ok: true, inbox: 'dispatch.json' };
  }
  if (input.name === 'group_finish') {
    const action = String(args.action ?? '');
    if (!['done', 'continue', 'pause'].includes(action)) {
      return { error: 'group_finish.action must be done|continue|pause' };
    }
    writeInbox(input.groupId, input.sessionId, 'finish.json', { kind: 'finish', action });
    return { ok: true, inbox: 'finish.json' };
  }
  if (input.name === 'group_mention') {
    const mentions = args.mentions;
    if (!Array.isArray(mentions) || mentions.length === 0) {
      return { error: 'group_mention.mentions must be a non-empty array' };
    }
    writeInbox(input.groupId, input.sessionId, 'mentions.json', { kind: 'mention', mentions });
    return { ok: true, inbox: 'mentions.json' };
  }
  return { error: `unknown tool ${input.name}` };
}
