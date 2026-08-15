/**
 * Dashboard store (储物袋) routes — local PeerLocalStore + optional peer HTTP
 * fallback for paired-device shared spaces. Peer daemon not required for local.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  ALL_SPACES,
  MAX_CHUNK,
  SHARED_SPACES,
  executeLocalStoreOp,
  getPeerLocalStore,
  hubStoreDeviceId,
  loadOrCreateHubConfig,
  loadPairedPeers,
  parseStoreUri,
  peerServiceStatus,
  agentPrivateStoreUri,
  workspaceStoreUri,
  ensureAgentStoreMappings,
} from '@shepaw/agent-hub-core';

export const storeRouter = Router();

const MAX_WRITE_BYTES = 5 * 1024 * 1024;

/** Spaces shown for local hub (网盘分区), aligned with Shepaw browserSpaces + agents. */
const LOCAL_BROWSER_SPACES = [
  'workspaces',
  'runtime',
  'files',
  'public',
  'memory',
  'artifacts',
  'agents',
] as const;

/** Spaces readable on paired devices (SHARED_SPACES). */
const PEER_BROWSER_SPACES = [...SHARED_SPACES].sort();

const SPACE_LIST = [...ALL_SPACES].sort();

function httpStatusForError(code: string): number {
  if (code === 'not_found') return 404;
  if (code === 'acl_denied') return 403;
  if (
    code === 'bad_path' ||
    code === 'bad_op' ||
    code === 'bad_uri' ||
    code === 'too_large' ||
    code === 'hash_mismatch' ||
    code === 'staging_state' ||
    code === 'peer_offline' ||
    code === 'master_offline' ||
    code === 'not_paired' ||
    code === 'exists'
  ) {
    return code === 'exists' ? 409 : 400;
  }
  return 500;
}

function sendOpError(res: Response, result: Record<string, unknown>): boolean {
  if (!result._error) return false;
  const code = String(result._error);
  res.status(httpStatusForError(code)).json({
    error: String(result.message ?? code),
    code,
  });
  return true;
}

function requireUri(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const uri = raw.trim();
  return uri.length > 0 ? uri : null;
}

function buildUri(space: string, device: string, path: string): string {
  if (!path) return `store://${space}/${device}/`;
  return `store://${space}/${device}/${path.replace(/^\/+|\/+$/g, '')}`;
}

function parentStoreUri(space: string, device: string, path: string): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  return buildUri(space, device, parts.join('/'));
}

function peerBaseUrl(): string | null {
  const st = peerServiceStatus();
  if (!st.running) return null;
  const host = st.host === '0.0.0.0' ? '127.0.0.1' : st.host;
  return `http://${host}:${st.port}`;
}

async function peerListRemote(
  uri: string,
  depth: number,
): Promise<Record<string, unknown> | null> {
  const base = peerBaseUrl();
  if (!base) return null;
  try {
    const q = new URLSearchParams({ uri, depth: String(depth) });
    const res = await fetch(`${base}/api/v1/list?${q}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        _error: String(body.error ?? 'peer_offline'),
        message: String(body.message ?? `peer HTTP ${res.status}`),
      };
    }
    return body;
  } catch (e) {
    return {
      _error: 'peer_offline',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

async function peerReadRemoteBytes(
  uri: string,
): Promise<{ bytes: Buffer } | { error: string; message: string }> {
  const base = peerBaseUrl();
  if (!base) {
    return { error: 'peer_offline', message: 'Peer 服务未运行，无法读取远端储物袋' };
  }
  try {
    const q = new URLSearchParams({ uri });
    const res = await fetch(`${base}/api/v1/read?${q}`);
    if (!res.ok) {
      let message = `peer HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        message = String(body.message ?? body.error ?? message);
      } catch {
        /* ignore */
      }
      return { error: 'not_found', message };
    }
    const ab = await res.arrayBuffer();
    return { bytes: Buffer.from(ab) };
  } catch (e) {
    return {
      error: 'peer_offline',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

async function listLocalOrRemote(
  uri: string,
  depth: number,
  self: string,
): Promise<Record<string, unknown>> {
  const parsed = parseStoreUri(uri);
  if (!parsed) return { _error: 'bad_uri', message: 'invalid store:// URI' };

  const payload: Record<string, unknown> = {
    space: parsed.space,
    device: parsed.device,
    path: parsed.path || undefined,
    limit: 1000,
  };
  if (Number.isFinite(depth) && depth > 0) payload.depth = depth;

  const local = executeLocalStoreOp('list', payload, self);
  if (parsed.device === self) return local;

  // Remote device: ask live peer via peer HTTP (WS connections live in peer process).
  // Prefer live result when online; fall back to local mirror; otherwise surface offline.
  const remote = await peerListRemote(uri, depth);
  if (remote && !remote._error) return remote;

  if (!local._error) {
    const entries = Array.isArray(local.entries) ? local.entries : [];
    if (entries.length > 0) return local;
  }

  if (remote) {
    const code = String(remote._error ?? 'peer_offline');
    const message =
      code === 'master_offline' || code === 'peer_offline'
        ? '配对设备未在线，且本机没有该设备的储物袋镜像'
        : String(remote.message ?? code);
    return { _error: code, message };
  }

  if (local._error) return local;
  return {
    _error: 'peer_offline',
    message: 'Peer 服务未运行，无法读取配对设备储物袋',
  };
}

storeRouter.get('/health', (_req: Request, res: Response) => {
  try {
    const deviceId = hubStoreDeviceId();
    const store = getPeerLocalStore();
    res.json({
      ok: true,
      deviceId,
      storeRoot: store.root,
      spaces: SPACE_LIST,
      localBrowserSpaces: [...LOCAL_BROWSER_SPACES],
      peerBrowserSpaces: PEER_BROWSER_SPACES,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Netdisk-style roots: local device, paired peers, agent mappings. */
storeRouter.get('/roots', (_req: Request, res: Response) => {
  try {
    const deviceId = hubStoreDeviceId();
    const store = getPeerLocalStore();
    try {
      for (const instance of loadOrCreateHubConfig().instances) {
        try {
          ensureAgentStoreMappings({
            agentId: instance.id,
            cwd: instance.cwd,
            deviceId,
            store,
          });
        } catch {
          /* continue mapping remaining instances */
        }
      }
    } catch {
      /* advertise URIs even if some symlinks fail */
    }
    const peerStatus = peerServiceStatus();
    const peers = loadPairedPeers().map((p) => ({
      id: p.id,
      deviceName: p.deviceName || p.fingerprint,
      deviceId: p.deviceId,
      fingerprint: p.fingerprint,
      pairedAt: p.pairedAt,
      writable: false,
      spaces: PEER_BROWSER_SPACES,
      /** Default entry: shared files space. */
      rootUri: buildUri('files', p.fingerprint, ''),
    }));
    const cfg = loadOrCreateHubConfig();
    const agents = cfg.instances.map((p) => ({
      instanceId: p.id,
      label: p.label || p.id,
      engine: p.engine,
      cwd: p.cwd,
      deviceId,
      workspaceUri: workspaceStoreUri(deviceId, p.cwd),
      agentUri: agentPrivateStoreUri(deviceId, p.id),
    }));
    res.json({
      local: {
        kind: 'local' as const,
        label: '本机',
        deviceId,
        writable: true,
        storeRoot: store.root,
        spaces: [...LOCAL_BROWSER_SPACES],
      },
      peers,
      agents,
      peerService: {
        running: peerStatus.running,
        port: peerStatus.port,
        host: peerStatus.host,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Recent files across spaces for a device (flat, sorted by mtime desc).
 * Query: device= (defaults to self), spaces=comma list, prefix=, limit=50
 */
storeRouter.get('/recent', async (req: Request, res: Response) => {
  try {
    const self = hubStoreDeviceId();
    const device =
      typeof req.query.device === 'string' && /^[a-f0-9]{16}$/i.test(req.query.device.trim())
        ? req.query.device.trim().toLowerCase()
        : self;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50;
    const prefix =
      typeof req.query.prefix === 'string' ? req.query.prefix.replace(/^\/+|\/+$/g, '') : '';

    let spaces: string[];
    if (typeof req.query.spaces === 'string' && req.query.spaces.trim()) {
      spaces = req.query.spaces.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (device === self) {
      spaces = [...LOCAL_BROWSER_SPACES];
    } else {
      spaces = PEER_BROWSER_SPACES;
    }

    type RecentRow = {
      uri: string;
      space: string;
      device: string;
      path: string;
      size: number;
      sha256: string;
      mtime: number;
      kind: 'file';
    };
    const files: RecentRow[] = [];
    let lastRemoteError: Record<string, unknown> | null = null;
    let listedOk = false;

    for (const space of spaces) {
      const uri = buildUri(space, device, prefix);
      // depth omitted / 0 → recursive file list (no dirs)
      const result = await listLocalOrRemote(uri, 0, self);
      if (result._error) {
        if (device !== self) lastRemoteError = result;
        continue;
      }
      listedOk = true;
      const entries = Array.isArray(result.entries) ? result.entries : [];
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as Record<string, unknown>;
        const path = typeof e.path === 'string' ? e.path : '';
        if (!path) continue;
        if (e.kind === 'dir') continue;
        if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
        files.push({
          uri: buildUri(space, device, path),
          space,
          device,
          path,
          size: typeof e.size === 'number' ? e.size : 0,
          sha256: typeof e.sha256 === 'string' ? e.sha256 : '',
          mtime: typeof e.mtime === 'number' ? e.mtime : 0,
          kind: 'file',
        });
      }
    }

    if (!listedOk && lastRemoteError && sendOpError(res, lastRemoteError)) return;

    files.sort((a, b) => b.mtime - a.mtime);
    res.json({
      device,
      writable: device === self,
      entries: files.slice(0, limit),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.get('/mappings', (_req: Request, res: Response) => {
  try {
    const deviceId = hubStoreDeviceId();
    const cfg = loadOrCreateHubConfig();
    const mappings = cfg.instances.map((p) => ({
      instanceId: p.id,
      label: p.label || p.id,
      engine: p.engine,
      cwd: p.cwd,
      deviceId,
      workspaceUri: workspaceStoreUri(deviceId, p.cwd),
      agentUri: agentPrivateStoreUri(deviceId, p.id),
    }));
    res.json({ deviceId, mappings });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.get('/list', async (req: Request, res: Response) => {
  try {
    const uri = requireUri(req.query.uri);
    if (!uri) {
      res.status(400).json({ error: 'uri query required', code: 'bad_uri' });
      return;
    }
    const parsed = parseStoreUri(uri);
    if (!parsed) {
      res.status(400).json({ error: 'invalid store:// URI', code: 'bad_uri' });
      return;
    }
    const self = hubStoreDeviceId();
    const depthRaw = req.query.depth;
    const depth =
      typeof depthRaw === 'string' && depthRaw.trim()
        ? Number(depthRaw)
        : 1;

    const result = await listLocalOrRemote(uri, depth, self);
    if (sendOpError(res, result)) return;

    const entries = Array.isArray(result.entries) ? result.entries : [];
    res.json({
      uri: buildUri(parsed.space, parsed.device, parsed.path),
      space: parsed.space,
      device: parsed.device,
      path: parsed.path,
      parent: parentStoreUri(parsed.space, parsed.device, parsed.path),
      writable: parsed.device === self,
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.get('/meta', async (req: Request, res: Response) => {
  try {
    const uri = requireUri(req.query.uri);
    if (!uri) {
      res.status(400).json({ error: 'uri query required', code: 'bad_uri' });
      return;
    }
    const parsed = parseStoreUri(uri);
    if (!parsed || !parsed.path) {
      res.status(400).json({ error: 'invalid store:// file URI', code: 'bad_uri' });
      return;
    }
    const self = hubStoreDeviceId();
    let result = executeLocalStoreOp(
      'meta',
      { space: parsed.space, device: parsed.device, path: parsed.path },
      self,
    );
    if (result._error && parsed.device !== self) {
      // Fallback: read via peer then synthesize meta
      const remote = await peerReadRemoteBytes(uri);
      if ('bytes' in remote) {
        result = {
          kind: 'file',
          size: remote.bytes.length,
          sha256: createHash('sha256').update(remote.bytes).digest('hex'),
          mtime: Date.now(),
        };
      } else {
        res.status(httpStatusForError(remote.error)).json(remote);
        return;
      }
    }
    if (sendOpError(res, result)) return;
    res.json({ uri, writable: parsed.device === self, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.get('/read', async (req: Request, res: Response) => {
  try {
    const uri = requireUri(req.query.uri);
    if (!uri) {
      res.status(400).json({ error: 'uri query required', code: 'bad_uri' });
      return;
    }
    const parsed = parseStoreUri(uri);
    if (!parsed || !parsed.path) {
      res.status(400).json({ error: 'invalid store:// file URI', code: 'bad_uri' });
      return;
    }
    const self = hubStoreDeviceId();

    let bytes: Buffer | null = null;
    let sha256 = '';
    let mtime: unknown;

    const meta = executeLocalStoreOp(
      'meta',
      { space: parsed.space, device: parsed.device, path: parsed.path },
      self,
    );
    if (!meta._error) {
      const size = typeof meta.size === 'number' ? meta.size : 0;
      if (size > MAX_WRITE_BYTES) {
        res.status(400).json({
          error: `file too large to read via dashboard (${size} bytes; max ${MAX_WRITE_BYTES})`,
          code: 'too_large',
        });
        return;
      }
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
            length: MAX_CHUNK,
          },
          self,
        );
        if (sendOpError(res, part)) return;
        const data = Buffer.from(String(part.data ?? ''), 'base64');
        chunks.push(data);
        offset += data.length;
        if (part.eof === true || data.length === 0) break;
      }
      bytes = Buffer.concat(chunks);
      sha256 = typeof meta.sha256 === 'string'
        ? meta.sha256
        : createHash('sha256').update(bytes).digest('hex');
      mtime = meta.mtime;
    } else if (parsed.device !== self) {
      const remote = await peerReadRemoteBytes(uri);
      if ('error' in remote) {
        res.status(httpStatusForError(remote.error)).json(remote);
        return;
      }
      if (remote.bytes.length > MAX_WRITE_BYTES) {
        res.status(400).json({
          error: `file too large to read via dashboard (${remote.bytes.length} bytes; max ${MAX_WRITE_BYTES})`,
          code: 'too_large',
        });
        return;
      }
      bytes = remote.bytes;
      sha256 = createHash('sha256').update(bytes).digest('hex');
    } else {
      sendOpError(res, meta);
      return;
    }

    if (req.query.raw === '1' || req.query.raw === 'true') {
      const name = parsed.path.split('/').pop() || 'download';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      res.send(bytes);
      return;
    }

    res.json({
      uri,
      size: bytes.length,
      sha256,
      mtime,
      writable: parsed.device === self,
      contentBase64: bytes.toString('base64'),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.post('/write', (req: Request, res: Response) => {
  try {
    const body = req.body as {
      uri?: string;
      contentBase64?: string;
      content?: string;
    };
    const uri = requireUri(body.uri);
    if (!uri) {
      res.status(400).json({ error: 'uri required', code: 'bad_uri' });
      return;
    }
    const parsed = parseStoreUri(uri);
    if (!parsed || !parsed.path) {
      res.status(400).json({ error: 'invalid store:// file URI (path required)', code: 'bad_uri' });
      return;
    }
    const self = hubStoreDeviceId();
    if (parsed.device !== self) {
      res.status(403).json({
        error: '只能写入本机储物袋；配对设备为只读',
        code: 'acl_denied',
      });
      return;
    }

    let bytes: Buffer;
    if (typeof body.contentBase64 === 'string') {
      bytes = Buffer.from(body.contentBase64, 'base64');
    } else if (typeof body.content === 'string') {
      bytes = Buffer.from(body.content, 'utf-8');
    } else {
      res.status(400).json({ error: 'content or contentBase64 required', code: 'bad_op' });
      return;
    }

    if (bytes.length > MAX_WRITE_BYTES) {
      res.status(400).json({
        error: `file too large (max ${MAX_WRITE_BYTES} bytes)`,
        code: 'too_large',
      });
      return;
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const begin = executeLocalStoreOp(
      'write.begin',
      {
        space: parsed.space,
        device: parsed.device,
        path: parsed.path,
        size: bytes.length,
        sha256,
      },
      self,
    );
    if (sendOpError(res, begin)) return;
    const uploadId = String(begin.upload_id ?? '');
    if (!uploadId) {
      res.status(500).json({ error: 'write.begin missing upload_id', code: 'internal' });
      return;
    }

    let offset = 0;
    while (offset < bytes.length) {
      const slice = bytes.subarray(offset, offset + MAX_CHUNK);
      const chunk = executeLocalStoreOp(
        'write.chunk',
        {
          space: parsed.space,
          device: parsed.device,
          upload_id: uploadId,
          offset,
          data: slice.toString('base64'),
        },
        self,
      );
      if (sendOpError(res, chunk)) return;
      offset += slice.length;
    }

    const committed = executeLocalStoreOp(
      'commit',
      {
        space: parsed.space,
        device: parsed.device,
        upload_ids: [uploadId],
      },
      self,
    );
    if (sendOpError(res, committed)) return;
    const failed = Array.isArray(committed.failed) ? committed.failed : [];
    if (failed.length > 0) {
      res.status(400).json({ error: 'commit failed', code: 'bad_op', failed });
      return;
    }

    res.json({
      ok: true,
      uri: buildUri(parsed.space, parsed.device, parsed.path),
      size: bytes.length,
      sha256,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.delete('/entry', (req: Request, res: Response) => {
  try {
    const uri = requireUri(req.query.uri);
    if (!uri) {
      res.status(400).json({ error: 'uri query required', code: 'bad_uri' });
      return;
    }
    const parsed = parseStoreUri(uri);
    if (!parsed || !parsed.path) {
      res.status(400).json({ error: 'invalid store:// file URI', code: 'bad_uri' });
      return;
    }
    const self = hubStoreDeviceId();
    if (parsed.device !== self) {
      res.status(403).json({
        error: '只能删除本机储物袋文件；配对设备为只读',
        code: 'acl_denied',
      });
      return;
    }
    const result = executeLocalStoreOp(
      'delete',
      { space: parsed.space, device: parsed.device, path: parsed.path },
      self,
    );
    if (sendOpError(res, result)) return;
    res.json({ ok: true, uri, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function entryBasename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function resolveDestLocation(
  store: ReturnType<typeof getPeerLocalStore>,
  from: { space: string; device: string; path: string },
  toUri: string,
): { space: string; device: string; path: string } | { error: string; message: string } {
  const to = parseStoreUri(toUri);
  if (!to) return { error: 'bad_uri', message: 'invalid destination store:// URI' };
  const destEndsWithSlash = toUri.trim().endsWith('/');
  let destPath = to.path;
  if (!destPath || destEndsWithSlash) {
    destPath = destPath
      ? `${destPath.replace(/\/+$/, '')}/${entryBasename(from.path)}`
      : entryBasename(from.path);
  } else {
    try {
      const abs = store.absPath(to.device, to.space, destPath);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        destPath = `${destPath}/${entryBasename(from.path)}`;
      }
    } catch {
      /* treat as file path */
    }
  }
  if (!destPath) return { error: 'bad_path', message: 'destination path required' };
  return { space: to.space, device: to.device, path: destPath };
}

function requireLocalFileUri(
  raw: unknown,
  self: string,
): { space: string; device: string; path: string } | { error: string; message: string } {
  const uri = requireUri(raw);
  if (!uri) return { error: 'bad_uri', message: 'uri required' };
  const parsed = parseStoreUri(uri);
  if (!parsed) return { error: 'bad_uri', message: 'invalid store:// URI' };
  if (parsed.device !== self) {
    return { error: 'acl_denied', message: '只能操作本机储物袋' };
  }
  if (!parsed.path) return { error: 'bad_path', message: 'path required' };
  return parsed;
}

storeRouter.post('/copy', (req: Request, res: Response) => {
  try {
    const body = req.body as { fromUri?: string; toUri?: string };
    const self = hubStoreDeviceId();
    const from = requireLocalFileUri(body.fromUri, self);
    if ('error' in from) {
      res.status(httpStatusForError(from.error)).json({ error: from.message, code: from.error });
      return;
    }
    const toUri = requireUri(body.toUri);
    if (!toUri) {
      res.status(400).json({ error: 'toUri required', code: 'bad_uri' });
      return;
    }
    const store = getPeerLocalStore();
    const dest = resolveDestLocation(store, from, toUri);
    if ('error' in dest) {
      res.status(httpStatusForError(dest.error)).json({ error: dest.message, code: dest.error });
      return;
    }
    if (dest.device !== self) {
      res.status(403).json({ error: '只能写入本机储物袋', code: 'acl_denied' });
      return;
    }
    store.copy(
      { deviceId: from.device, space: from.space, path: from.path },
      { deviceId: dest.device, space: dest.space, path: dest.path },
    );
    res.json({ ok: true, uri: buildUri(dest.space, dest.device, dest.path) });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'internal';
    const status = httpStatusForError(code);
    res.status(status).json({
      error: err instanceof Error ? err.message : String(err),
      code,
    });
  }
});

storeRouter.post('/move', (req: Request, res: Response) => {
  try {
    const body = req.body as { fromUri?: string; toUri?: string };
    const self = hubStoreDeviceId();
    const from = requireLocalFileUri(body.fromUri, self);
    if ('error' in from) {
      res.status(httpStatusForError(from.error)).json({ error: from.message, code: from.error });
      return;
    }
    const toUri = requireUri(body.toUri);
    if (!toUri) {
      res.status(400).json({ error: 'toUri required', code: 'bad_uri' });
      return;
    }
    const store = getPeerLocalStore();
    const dest = resolveDestLocation(store, from, toUri);
    if ('error' in dest) {
      res.status(httpStatusForError(dest.error)).json({ error: dest.message, code: dest.error });
      return;
    }
    if (dest.device !== self) {
      res.status(403).json({ error: '只能写入本机储物袋', code: 'acl_denied' });
      return;
    }
    store.move(
      { deviceId: from.device, space: from.space, path: from.path },
      { deviceId: dest.device, space: dest.space, path: dest.path },
    );
    res.json({ ok: true, uri: buildUri(dest.space, dest.device, dest.path) });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'internal';
    const status = httpStatusForError(code);
    res.status(status).json({
      error: err instanceof Error ? err.message : String(err),
      code,
    });
  }
});

function revealInOs(absPath: string, isDir: boolean): void {
  if (process.platform === 'darwin') {
    const args = isDir ? [absPath] : ['-R', absPath];
    spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    const args = isDir ? [absPath] : [`/select,${absPath}`];
    spawn('explorer', args, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [isDir ? absPath : dirname(absPath)], { detached: true, stdio: 'ignore' }).unref();
}

/** Open a local store path in the OS file manager. This machine only. */
storeRouter.post('/reveal', (req: Request, res: Response) => {
  try {
    const body = req.body as { uri?: string };
    const self = hubStoreDeviceId();
    const uri = requireUri(body.uri);
    if (!uri) {
      res.status(400).json({ error: 'uri required', code: 'bad_uri' });
      return;
    }
    const parsed = parseStoreUri(uri);
    if (!parsed) {
      res.status(400).json({ error: 'invalid store:// URI', code: 'bad_uri' });
      return;
    }
    if (parsed.device !== self) {
      res.status(403).json({
        error: '只能在本机打开目录',
        code: 'acl_denied',
      });
      return;
    }
    const store = getPeerLocalStore();
    const abs = store.absPath(parsed.device, parsed.space, parsed.path || undefined);
    if (!existsSync(abs)) {
      res.status(404).json({ error: 'path not found', code: 'not_found' });
      return;
    }
    const st = statSync(abs);
    const openPath = realpathSync(abs);
    revealInOs(openPath, st.isDirectory());
    res.json({ ok: true, uri, path: openPath, kind: st.isDirectory() ? 'dir' : 'file' });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'internal';
    res.status(httpStatusForError(code)).json({
      error: err instanceof Error ? err.message : String(err),
      code,
    });
  }
});
