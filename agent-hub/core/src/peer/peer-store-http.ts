/**
 * HTTP surface for hub-local store + peer-routed reads.
 * Compatible enough with StoreToolsClient (/api/v1/*) for agent tools.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadOrCreatePeerIdentity } from './peer-identity.js';
import {
  callStoreOnDevice,
  executeLocalStoreOp,
  parseStoreUri,
} from './peer-store-protocol.js';
import { getPeerLocalStore } from './peer-local-store.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
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

async function resolveUriMeta(
  uri: string,
  selfDeviceId: string,
): Promise<{ parsed: { space: string; device: string; path: string }; meta: Record<string, unknown>; local: boolean } | { error: string; message: string }> {
  const parsed = parseStoreUri(uri);
  if (!parsed) return { error: 'bad_uri', message: 'invalid store:// URI' };
  const local = executeLocalStoreOp(
    'meta',
    { space: parsed.space, device: parsed.device, path: parsed.path },
    selfDeviceId,
  );
  if (!local._error) return { parsed, meta: local, local: true };
  if (parsed.device === selfDeviceId) {
    return { error: String(local._error), message: String(local.message ?? '') };
  }
  const remote = await callStoreOnDevice(parsed.device, 'meta', {
    space: parsed.space,
    device: parsed.device,
    path: parsed.path,
  });
  if (remote._error) {
    return { error: String(remote._error), message: String(remote.message ?? '') };
  }
  return { parsed, meta: remote, local: false };
}

function takeRange(data: Buffer, offset: number, want: number, size: number): Buffer {
  if (data.length <= want) return data;
  // A peer that ignores offset returns the whole object. Keep only this slice.
  const from = offset > 0 && data.length > offset && data.length >= size ? offset : 0;
  return data.subarray(from, from + want);
}

async function readUriBytes(
  uri: string,
  selfDeviceId: string,
  start = 0,
  maxBytes?: number,
): Promise<{ bytes: Buffer; meta: Record<string, unknown> } | { error: string; message: string }> {
  const resolved = await resolveUriMeta(uri, selfDeviceId);
  if ('error' in resolved) return resolved;
  const { parsed, meta, local } = resolved;
  const size = typeof meta.size === 'number' ? meta.size : 0;
  const offset0 = Number.isFinite(start) && start > 0 ? Math.floor(start) : 0;
  if (offset0 >= size || maxBytes === 0) {
    return { bytes: Buffer.alloc(0), meta };
  }
  const chunks: Buffer[] = [];
  let offset = offset0;
  let remaining = maxBytes == null || !Number.isFinite(maxBytes) ? Number.POSITIVE_INFINITY : maxBytes;
  while (remaining > 0 && offset < size) {
    const want = Math.min(64 * 1024, remaining);
    const payload = {
      space: parsed.space,
      device: parsed.device,
      path: parsed.path,
      offset,
      length: want,
    };
    const part = local
      ? executeLocalStoreOp('read', payload, selfDeviceId)
      : await callStoreOnDevice(parsed.device, 'read', payload);
    if (part._error) {
      if (chunks.length === 0) {
        return { error: String(part._error), message: String(part.message ?? '') };
      }
      break;
    }
    let data = takeRange(Buffer.from(String(part.data ?? ''), 'base64'), offset, want, size);
    if (data.length === 0) break;
    if (data.length > remaining) data = data.subarray(0, remaining);
    chunks.push(data);
    offset += data.length;
    remaining -= data.length;
    if (part.eof === true && offset >= size) break;
  }
  return { bytes: Buffer.concat(chunks), meta };
}

/**
 * Handle store HTTP requests on the peer service port.
 * Returns true if the request was handled.
 */
export async function handleStoreHttp(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (!path.startsWith('/api/v1/')) return false;

  const self = loadOrCreatePeerIdentity().fingerprint;

  if (req.method === 'POST' && path === '/api/v1/store') {
    const raw = await readBody(req);
    let body: { op?: string; payload?: Record<string, unknown> };
    try {
      body = JSON.parse(raw) as { op?: string; payload?: Record<string, unknown> };
    } catch {
      sendJson(res, 400, { op: 'error', code: 'bad_op', message: 'invalid json' });
      return true;
    }
    const op = body.op ?? '';
    const payload = body.payload ?? {};
    const data = executeLocalStoreOp(op, payload, self);
    if (data._error) {
      sendJson(res, 200, {
        op: 'error',
        code: data._error,
        message: data.message ?? data._error,
      });
    } else {
      sendJson(res, 200, { op: 'result', data });
    }
    return true;
  }

  if (req.method === 'GET' && path === '/api/v1/uri/resolve') {
    const uri = url.searchParams.get('uri') ?? '';
    const parsed = parseStoreUri(uri);
    if (!parsed) {
      sendJson(res, 400, { error: 'bad_uri', message: 'invalid store:// URI' });
      return true;
    }
    const resolved = await resolveUriMeta(uri, self);
    if ('error' in resolved) {
      sendJson(res, 404, { error: resolved.error, message: resolved.message });
      return true;
    }
    sendJson(res, 200, {
      uri,
      space: parsed.space,
      device: parsed.device,
      path: parsed.path,
      size: resolved.meta.size,
      sha256: resolved.meta.sha256,
      kind: resolved.meta.kind,
      meta: resolved.meta,
    });
    return true;
  }

  if (req.method === 'GET' && path === '/api/v1/list') {
    const uri = url.searchParams.get('uri') ?? '';
    const parsed = parseStoreUri(uri);
    if (!parsed) {
      sendJson(res, 400, { error: 'bad_uri', message: 'invalid store:// URI' });
      return true;
    }
    const depthRaw = url.searchParams.get('depth');
    const depth =
      depthRaw != null && depthRaw !== '' ? Number(depthRaw) : undefined;
    // list URI path is treated as prefix / start directory under the device/space.
    const payload: Record<string, unknown> = {
      space: parsed.space,
      device: parsed.device,
      path: parsed.path || undefined,
      limit: 1000,
    };
    if (Number.isFinite(depth)) payload.depth = depth;
    let data = executeLocalStoreOp('list', payload, self);
    if (parsed.device !== self) {
      // Prefer live peer when connected. Local empty dirs are NOT an error
      // (missing mirror), so we must fall back on empty as well as _error.
      const localEntries = Array.isArray(data.entries) ? data.entries : [];
      const remote = await callStoreOnDevice(parsed.device, 'list', payload);
      if (!remote._error) {
        data = remote;
      } else if (data._error || localEntries.length === 0) {
        data = remote;
      }
    }
    if (data._error) {
      sendJson(res, 404, { error: data._error, message: data.message });
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  if (req.method === 'GET' && path === '/api/v1/read') {
    const uri = url.searchParams.get('uri') ?? '';
    const offsetRaw = url.searchParams.get('offset');
    const lengthRaw = url.searchParams.get('length');
    const offset = offsetRaw != null && offsetRaw !== '' ? Number(offsetRaw) : 0;
    const length = lengthRaw != null && lengthRaw !== '' ? Number(lengthRaw) : undefined;
    const out = await readUriBytes(
      uri,
      self,
      Number.isFinite(offset) ? offset : 0,
      length != null && Number.isFinite(length) ? length : undefined,
    );
    if ('error' in out) {
      sendJson(res, 404, { error: out.error, message: out.message });
      return true;
    }
    // StoreToolsClient expects raw bytes on /api/v1/read.
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': out.bytes.length,
    });
    res.end(out.bytes);
    return true;
  }

  if (req.method === 'GET' && path === '/api/v1/health') {
    sendJson(res, 200, {
      ok: true,
      device: self,
      store_root: getPeerLocalStore().root,
    });
    return true;
  }

  return false;
}
