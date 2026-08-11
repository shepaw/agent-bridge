/**
 * Dashboard store (储物袋) routes — local PeerLocalStore via executeLocalStoreOp.
 * Does not require the Peer service to be running.
 */

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  ALL_SPACES,
  MAX_CHUNK,
  executeLocalStoreOp,
  getPeerLocalStore,
  hubStoreDeviceId,
  loadOrCreateHubConfig,
  parseStoreUri,
  agentPrivateStoreUri,
  workspaceStoreUri,
} from '@shepaw/agent-hub-core';

export const storeRouter = Router();

const MAX_WRITE_BYTES = 5 * 1024 * 1024;

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
    code === 'staging_state'
  ) {
    return 400;
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

storeRouter.get('/health', (_req: Request, res: Response) => {
  try {
    const deviceId = hubStoreDeviceId();
    const store = getPeerLocalStore();
    res.json({
      ok: true,
      deviceId,
      storeRoot: store.root,
      spaces: SPACE_LIST,
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

storeRouter.get('/list', (req: Request, res: Response) => {
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
    const payload: Record<string, unknown> = {
      space: parsed.space,
      device: parsed.device,
      path: parsed.path || undefined,
      limit: 1000,
    };
    if (Number.isFinite(depth) && depth > 0) payload.depth = depth;

    const result = executeLocalStoreOp('list', payload, self);
    if (sendOpError(res, result)) return;

    const entries = Array.isArray(result.entries) ? result.entries : [];
    res.json({
      uri: buildUri(parsed.space, parsed.device, parsed.path),
      space: parsed.space,
      device: parsed.device,
      path: parsed.path,
      parent: parentStoreUri(parsed.space, parsed.device, parsed.path),
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.get('/meta', (req: Request, res: Response) => {
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
    const result = executeLocalStoreOp(
      'meta',
      { space: parsed.space, device: parsed.device, path: parsed.path },
      self,
    );
    if (sendOpError(res, result)) return;
    res.json({ uri, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

storeRouter.get('/read', (req: Request, res: Response) => {
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
    const meta = executeLocalStoreOp(
      'meta',
      { space: parsed.space, device: parsed.device, path: parsed.path },
      self,
    );
    if (sendOpError(res, meta)) return;

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
    const bytes = Buffer.concat(chunks);

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
      sha256: typeof meta.sha256 === 'string' ? meta.sha256 : createHash('sha256').update(bytes).digest('hex'),
      mtime: meta.mtime,
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

    const self = hubStoreDeviceId();
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

function parentStoreUri(space: string, device: string, path: string): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  return buildUri(space, device, parts.join('/'));
}
