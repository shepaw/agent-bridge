import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { executeStoreTool, StoreToolsClient } from '../src/store-tools.js';

describe('store tools (Nexuspouch HTTP)', () => {
  let server: Server;
  let base = '';
  const files = new Map<string, Buffer>();

  const frame = (op: string, payload: unknown) => ({ op, payload });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/v1/store' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const { op, payload } = JSON.parse(raw) as { op: string; payload: any };
          if (op === 'write.begin') {
            files.set(payload.path, Buffer.alloc(0));
            return send(200, { op: 'result', data: { upload_id: `u-${payload.path}` } });
          }
          if (op === 'write.chunk') {
            const cur = files.get(payload.upload_id.replace('u-', '')) ?? Buffer.alloc(0);
            const part = Buffer.from(payload.data as string, 'base64');
            files.set(payload.upload_id.replace('u-', ''), Buffer.concat([cur, part]));
            return send(200, { op: 'result', data: { received: payload.offset + part.length } });
          }
          if (op === 'commit') {
            const path = (payload.upload_ids as string[])[0].replace('u-', '');
            const bytes = files.get(path) ?? Buffer.alloc(0);
            const sha = createHash('sha256').update(bytes).digest('hex');
            return send(200, {
              op: 'result',
              data: {
                committed: [{ path, sha256: sha, size: bytes.length }],
                failed: [],
                files: [{ path, sha256: sha, size: bytes.length }],
              },
            });
          }
          return send(400, { error: 'bad_op', message: 'unhandled op' });
        });
        return;
      }
      if (url.pathname === '/api/v1/uri/resolve') {
        const uri = url.searchParams.get('uri') ?? '';
        const path = uri.split('/').slice(3).join('/');
        const bytes = files.get(path);
        if (!bytes) return send(400, { error: 'not_found', message: 'no such file' });
        return send(200, {
          uri,
          meta: { kind: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        });
      }
      if (url.pathname === '/api/v1/read') {
        const uri = url.searchParams.get('uri') ?? '';
        const path = uri.split('/').slice(3).join('/');
        const bytes = files.get(path);
        if (!bytes) return send(400, { error: 'not_found', message: 'no such file' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(bytes);
        return;
      }
      send(404, { error: 'not_found', message: 'no route' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('write -> read roundtrip', async () => {
    const client = new StoreToolsClient(base, 'tok', 'aaaaaaaaaaaaaaaa');
    const written = await executeStoreTool(
      'store_write',
      { filename: 't-1/out.txt', content: 'hello store tools', space: 'artifacts' },
      client,
    );
    expect(written.ok).toBe(true);
    const uri = (written.data as { uri: string }).uri;
    expect(uri).toBe('store://artifacts/aaaaaaaaaaaaaaaa/t-1/out.txt');

    const meta = await executeStoreTool('store_meta', { uri }, client);
    expect(meta.ok).toBe(true);
    expect((meta.data as { meta: { size: number } }).meta.size).toBe('hello store tools'.length);

    const read = await executeStoreTool('store_read', { uri }, client);
    expect(read.ok).toBe(true);
    expect((read.data as { encoding: string; content: string }).content).toBe('hello store tools');
  });

  it('unknown tool and missing file error mapping', async () => {
    const client = new StoreToolsClient(base, 'tok', 'aaaaaaaaaaaaaaaa');
    const unknown = await executeStoreTool('store_nope', {}, client);
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('bad_op');

    const missing = await executeStoreTool(
      'store_meta',
      { uri: 'store://artifacts/aaaaaaaaaaaaaaaa/nope.txt' },
      client,
    );
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('not_found');
  });
});
