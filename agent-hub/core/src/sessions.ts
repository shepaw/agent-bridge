/**
 * Read and manage per-instance session mappings persisted by the ACP proxy gateway.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { instancePaths } from './paths.js';

export interface InstanceSessionEntry {
  /** Shepaw-side session identifier (sent by the mobile app). */
  readonly shepawSessionId: string;
  /** Upstream ACP agent session identifier. */
  readonly acpSessionId: string;
}

interface PersistedShape {
  version: 1;
  map: Record<string, string>;
}

function sessionsFilePath(instanceId: string): string {
  return instancePaths(instanceId).sessionsPath;
}

function readPersistedMap(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Session store at ${path} is not valid JSON.`);
  }
  const data = parsed as Partial<PersistedShape>;
  if (data.version !== 1 || data.map === undefined || typeof data.map !== 'object') {
    return new Map();
  }
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(data.map)) {
    if (typeof v === 'string' && v.length > 0) map.set(k, v);
  }
  return map;
}

function writePersistedMap(path: string, map: Map<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const data: PersistedShape = {
    version: 1,
    map: Object.fromEntries(map),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/** List persisted Shepaw → ACP session mappings for a hub instance. */
export function listInstanceSessions(instanceId: string): InstanceSessionEntry[] {
  const map = readPersistedMap(sessionsFilePath(instanceId));
  return [...map.entries()]
    .map(([shepawSessionId, acpSessionId]) => ({ shepawSessionId, acpSessionId }))
    .sort((a, b) => a.shepawSessionId.localeCompare(b.shepawSessionId));
}

/** Remove a stale mapping. Returns false when the entry did not exist. */
export function deleteInstanceSession(instanceId: string, shepawSessionId: string): boolean {
  const path = sessionsFilePath(instanceId);
  const map = readPersistedMap(path);
  if (!map.has(shepawSessionId)) return false;
  map.delete(shepawSessionId);
  writePersistedMap(path, map);
  return true;
}
