/**
 * Hermes — `~/.hermes/state.db` messages table:
 *   role, content, timestamp (unix seconds)
 */

import { access } from 'node:fs/promises';

import { homePath, pushTurn, toIsoFromUnknown, type DiskHistoryMessage } from './util.js';

export async function loadHermesHistory(sessionId: string): Promise<DiskHistoryMessage[] | null> {
  const dbPath = homePath('.hermes', 'state.db');
  try {
    await access(dbPath);
  } catch {
    return null;
  }

  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const rows = db
      .prepare(
        `SELECT role, content, timestamp
         FROM messages
         WHERE session_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(sessionId) as Array<{ role: string; content: string; timestamp: number }>;

    const out: DiskHistoryMessage[] = [];
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'agent') continue;
      const role = row.role === 'user' ? 'user' : 'agent';
      const createdAt = toIsoFromUnknown(row.timestamp);
      pushTurn(out, role, String(row.content ?? ''), createdAt);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}
