/**
 * Hub → App RPC for `shepaw` commands that must run on the phone.
 *
 * Store of this Hub device stays on `/api/v1`. Foreign `store://` and every
 * other namespace (except Hub-native group/resume) POST here; the App runs
 * CliExecutionGate and returns the CLI JSON envelope.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findLivePeerId, sendToPeer } from './peer-connection.js';

const CALL_TIMEOUT_MS = 120_000;

type Pending = {
  resolve: (data: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();

export function handleCliExecuteResp(frame: Record<string, unknown>): boolean {
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

export async function requestAppCliExecute(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentId =
    typeof payload.agent_id === 'string' ? payload.agent_id.trim() : '';
  const peerId = findLivePeerId(agentId || undefined);
  if (!peerId) {
    return {
      ok: false,
      error: 'paired App is not connected; command must run on the phone',
    };
  }
  const reqId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ ok: false, error: 'timeout waiting for App cli execute' });
    }, CALL_TIMEOUT_MS);
    pending.set(reqId, { resolve, timer });
    const ok = sendToPeer(peerId, {
      type: 'cli_execute_req',
      req_id: reqId,
      ...payload,
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(reqId);
      resolve({
        ok: false,
        error: 'paired App is not connected; command must run on the phone',
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

/** POST /api/v1/cli/execute — used by the shepaw CLI shim. */
export async function handleCliExecuteHttp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'POST' || url.pathname !== '/api/v1/cli/execute') {
    return false;
  }
  let payload: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, error: 'body must be a JSON object' });
      return true;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid json' });
    return true;
  }
  const out = await requestAppCliExecute(payload);
  sendJson(res, 200, out);
  return true;
}

/** Test-only: drop waiters so suites do not leak timers. */
export function resetCliExecutePendingForTest(): void {
  for (const w of pending.values()) clearTimeout(w.timer);
  pending.clear();
}
