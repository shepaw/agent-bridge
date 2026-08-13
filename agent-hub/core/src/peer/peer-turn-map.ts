/**
 * Persistent request_id → ACP task mapping for peer chat turns.
 *
 * The in-memory turn registry in peer-connection.ts dies with the hub
 * process; the proxy (a detached, longer-lived process) keeps task output
 * buffered across our absence. This file is the bridge: after a hub restart,
 * an app's `agent_turn_resume_req` for an unknown request_id can be rebuilt
 * from the proxy via `agent.taskResume` instead of answered 'lost'.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { peerTurnMapPath } from '../paths.js';

/** Terminal entries stay resumable as long as the proxy keeps its replay buffer. */
export const PEER_TURN_TERMINAL_TTL_MS = 25 * 60 * 1000;
/** A still-running turn's mapping lives this long (pathological-runtime cap). */
export const PEER_TURN_LIVE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PeerTurnRecord {
  readonly requestId: string;
  readonly peerId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly terminalAt?: number;
}

interface StoreShape {
  readonly version: 1;
  readonly turns: PeerTurnRecord[];
}

function loadAll(): PeerTurnRecord[] {
  const path = peerTurnMapPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreShape;
    if (!Array.isArray(parsed.turns)) return [];
    return parsed.turns;
  } catch {
    return [];
  }
}

function persist(turns: PeerTurnRecord[]): void {
  const path = peerTurnMapPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const data: StoreShape = { version: 1, turns };
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function isLive(record: PeerTurnRecord, now: number): boolean {
  if (record.terminalAt !== undefined) {
    return now - record.terminalAt <= PEER_TURN_TERMINAL_TTL_MS;
  }
  return now - record.createdAt <= PEER_TURN_LIVE_TTL_MS;
}

export function savePeerTurn(record: PeerTurnRecord): void {
  const existing = loadAll().filter((t) => t.requestId !== record.requestId);
  persist([record, ...existing.filter((t) => isLive(t, Date.now()))]);
}

export function getPeerTurn(requestId: string): PeerTurnRecord | undefined {
  const now = Date.now();
  return loadAll().find((t) => t.requestId === requestId && isLive(t, now));
}

export function markPeerTurnTerminal(requestId: string, terminalAt: number): void {
  const next = loadAll().map((t) =>
    t.requestId === requestId ? { ...t, terminalAt } : t,
  );
  persist(next);
}

export function deletePeerTurn(requestId: string): void {
  persist(loadAll().filter((t) => t.requestId !== requestId));
}

/** Drop expired records (called from the hub's 60s idle sweep). */
export function reapPeerTurns(): void {
  const now = Date.now();
  persist(loadAll().filter((t) => isLive(t, now)));
}
