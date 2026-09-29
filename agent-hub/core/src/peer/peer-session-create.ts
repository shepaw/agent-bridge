/**
 * `shepaw chat session create` lands on this host.
 *
 * The new channel id is recorded in the pouch session registry. The phone
 * only displays it. `requestAppSessionCreate` remains for a caller that
 * still needs the phone to mint an App-side card.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findLivePeerId, sendToPeer } from './peer-connection.js';
import { createLocalPouchSession } from './pouch-disk.js';

const CALL_TIMEOUT_MS = 20_000;

type Pending = {
  resolve: (data: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();

export function handleSessionCreateResp(frame: Record<string, unknown>): boolean {
  const reqId = typeof frame.req_id === 'string' ? frame.req_id : undefined;
  if (!reqId) return false;
  const waiter = pending.get(reqId);
  if (!waiter) return false;
  pending.delete(reqId);
  clearTimeout(waiter.timer);
  const { type: _t, req_id: _id, ...rest } = frame;
  waiter.resolve(rest);
  return true;
}

export async function requestAppSessionCreate(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentId =
    typeof payload.agent_id === 'string' ? payload.agent_id.trim() : '';
  const peerId = findLivePeerId(agentId || undefined);
  if (!peerId) {
    return {
      error: 'paired App is not connected; session create must run on the phone',
    };
  }
  const reqId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ error: 'timeout waiting for App session create' });
    }, CALL_TIMEOUT_MS);
    pending.set(reqId, { resolve, timer });
    const ok = sendToPeer(peerId, {
      type: 'session_create_req',
      req_id: reqId,
      ...payload,
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve({
        error: 'paired App is not connected; session create must run on the phone',
      });
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** POST /api/v1/chat/session-create — used by the shepaw CLI shim. */
export async function handleSessionCreateHttp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'POST' || url.pathname !== '/api/v1/chat/session-create') {
    return false;
  }
  let payload: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'body must be a JSON object' });
      return true;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'invalid json' });
    return true;
  }
  let out: Record<string, unknown>;
  try {
    out = createLocalPouchSession(payload);
  } catch (err) {
    out = { error: err instanceof Error ? err.message : String(err) };
  }
  sendJson(res, 200, out);
  return true;
}

/** Test-only: drop waiters so suites do not leak timers. */
export function resetSessionCreatePendingForTest(): void {
  for (const w of pending.values()) clearTimeout(w.timer);
  pending.clear();
}
