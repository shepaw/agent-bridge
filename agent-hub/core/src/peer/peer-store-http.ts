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

async function readUriBytes(
  uri: string,
  selfDeviceId: string,
): Promise<{ bytes: Buffer; meta: Record<string, unknown> } | { error: string; message: string }> {
  const parsed = parseStoreUri(uri);
  if (!parsed) return { error: 'bad_uri', message: 'invalid store:// URI' };

  // Prefer local mirror / self; fall back to live peer when needed.
  const local = executeLocalStoreOp(
    'meta',
    { space: parsed.space, device: parsed.device, path: parsed.path },
    selfDeviceId,
  );
  if (!local._error) {
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const part = executeLocalStoreOp(
        'read',
        {
          space: parsed.space,
          device: parsed.device,
          path: parsed.path,
          offset,
          length: 64 * 1024,
        },
        selfDeviceId,
      );
      if (part._error) break;
      const data = Buffer.from(String(part.data ?? ''), 'base64');
      chunks.push(data);
      offset += data.length;
      if (part.eof === true || data.length === 0) break;
    }
    return { bytes: Buffer.concat(chunks), meta: local };
  }

  if (parsed.device === selfDeviceId) {
    return { error: String(local._error), message: String(local.message ?? '') };
  }

  // Remote live read via peer channel.
  const meta = await callStoreOnDevice(parsed.device, 'meta', {
    space: parsed.space,
    device: parsed.device,
    path: parsed.path,
  });
  if (meta._error) {
    return { error: String(meta._error), message: String(meta.message ?? '') };
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const part = await callStoreOnDevice(parsed.device, 'read', {
      space: parsed.space,
      device: parsed.device,
      path: parsed.path,
      offset,
      length: 64 * 1024,
    });
    if (part._error) {
      return { error: String(part._error), message: String(part.message ?? '') };
    }
    const data = Buffer.from(String(part.data ?? ''), 'base64');
    chunks.push(data);
    offset += data.length;
    if (part.eof === true || data.length === 0) break;
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
    const out = await readUriBytes(uri, self);
    if ('error' in out) {
      sendJson(res, 404, { error: out.error, message: out.message });
      return true;
    }
    sendJson(res, 200, {
      uri,
      space: parsed.space,
      device: parsed.device,
      path: parsed.path,
      size: out.meta.size,
      sha256: out.meta.sha256,
      kind: out.meta.kind,
      meta: out.meta,
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
    // list URI path is treated as prefix under the device/space.
    let data = executeLocalStoreOp(
      'list',
      { space: parsed.space, device: parsed.device, path: parsed.path || undefined },
      self,
    );
    if (data._error && parsed.device !== self) {
      data = await callStoreOnDevice(parsed.device, 'list', {
        space: parsed.space,
        device: parsed.device,
        path: parsed.path || undefined,
      });
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
    const out = await readUriBytes(uri, self);
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
