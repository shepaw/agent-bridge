/**
 * Ephemeral ACP connection to list upstream agent sessions (session/list).
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import type { AcpEngineSpec } from './engines.js';
import { spawnCommand } from './engines.js';

export interface StoredSessionEntry {
  shepawSessionId: string;
  acpSessionId: string;
}

interface PersistedShape {
  version: 1;
  map: Record<string, string>;
  orphanedSdkIds?: string[];
}

export async function readStoredSessions(path: string): Promise<StoredSessionEntry[]> {
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<PersistedShape>;
    if (data.version !== 1 || data.map === undefined || typeof data.map !== 'object') {
      return [];
    }
    return Object.entries(data.map)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([shepawSessionId, acpSessionId]) => ({ shepawSessionId, acpSessionId }))
      .sort((a, b) => a.shepawSessionId.localeCompare(b.shepawSessionId));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return [];
    throw err;
  }
}

/** `sessions.json` lives next to `cursor-ide-sync.json` (and the other CLI sync manifests). */
export function sessionStorePathFromSyncPath(syncPath: string): string {
  return join(dirname(syncPath), 'sessions.json');
}

/**
 * Upstream ACP session ids the gateway already manages (`sessions.json` map
 * values + orphaned ids). Client CLI/IDE sync must skip these — they already
 * belong to an app conversation and re-importing them creates duplicates.
 */
export async function readManagedAcpSessionIds(path: string | undefined): Promise<Set<string>> {
  const ids = new Set<string>();
  if (path === undefined || path.length === 0) return ids;
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<PersistedShape>;
    if (data.version !== 1) return ids;
    if (data.map !== undefined && typeof data.map === 'object') {
      for (const sdkId of Object.values(data.map)) {
        if (typeof sdkId === 'string' && sdkId.length > 0) ids.add(sdkId);
      }
    }
    if (Array.isArray(data.orphanedSdkIds)) {
      for (const id of data.orphanedSdkIds) {
        if (typeof id === 'string' && id.length > 0) ids.add(id);
      }
    }
  } catch {
    return ids;
  }
  return ids;
}

export async function readManagedAcpSessionIdsForSync(opts: {
  syncPath: string;
  sessionStorePath?: string;
}): Promise<Set<string>> {
  return readManagedAcpSessionIds(opts.sessionStorePath ?? sessionStorePathFromSyncPath(opts.syncPath));
}

export function dropManagedCliSessions<T extends { sessionId: string }>(
  sessions: readonly T[],
  managedIds: ReadonlySet<string>,
): T[] {
  if (managedIds.size === 0) return [...sessions];
  return sessions.filter((s) => !managedIds.has(s.sessionId));
}

/**
 * Order sessions newest-first — the order every Shepaw surface renders.
 *
 * Both list sources (live `session/list` and disk discovery) arrive already
 * sorted, but appending one to the other puts the newest IDE-synced
 * conversations *below* much older ACP ones. Sessions with no `updatedAt` keep
 * their relative order and sink to the end, matching what the app does for its
 * own lists.
 */
export function sortSessionsByRecency<T extends { updatedAt?: string | null }>(
  sessions: readonly T[],
): T[] {
  return sessions
    .map((session, index) => ({ session, index, at: recencyOf(session.updatedAt) }))
    .sort((a, b) => {
      if (a.at === b.at) return a.index - b.index;
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return b.at - a.at;
    })
    .map((entry) => entry.session);
}

/** Epoch ms for an ISO stamp; undefined when absent, blank, or unparseable. */
function recencyOf(raw: string | null | undefined): number | undefined {
  const text = (raw ?? '').trim();
  if (text.length === 0) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

export async function listUpstreamAcpSessions(
  spec: AcpEngineSpec,
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<acp.SessionInfo[]> {
  const { command, args } = spawnCommand(spec);
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  if (child.stdin === null || child.stdout === null) {
    throw new Error('ACP agent subprocess missing stdin/stdout pipes');
  }

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = acp
    .client({ name: 'shepaw-acp-proxy' })
    .connect(stream);

  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'shepaw-acp-proxy',
        title: 'Shepaw ACP Proxy',
        version: '0.2.0',
      },
    });

    const response = await connection.agent.request(acp.methods.agent.session.list, {
      cwd,
    }) as acp.ListSessionsResponse;

    return response.sessions ?? [];
  } finally {
    connection.close();
    if (!child.killed) child.kill('SIGTERM');
  }
}
