import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import {
  parseFlags,
  resolveStoreClient,
  runShepawCli,
} from '../src/shepaw-cli.js';

const DEVICE = 'aaaaaaaaaaaaaaaa';

interface Captured {
  lines: string[];
  code: number;
}

function makeIo(env: NodeJS.ProcessEnv): {
  io: Parameters<typeof runShepawCli>[1];
  out: () => Captured;
} {
  const lines: string[] = [];
  return {
    io: { env, stdout: (t) => lines.push(t) },
    out: () => ({ lines, code: 0 }),
  };
}

function lastJson(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe('shepaw-cli parseFlags', () => {
  it('parses --key value, --key=value, bare flags and positionals', () => {
    const { positional, flags } = parseFlags([
      'store',
      'read',
      '--uri',
      'store://files/x/a.txt',
      '--space=artifacts',
      '--verbose',
    ]);
    expect(positional).toEqual(['store', 'read']);
    expect(flags).toEqual({
      uri: 'store://files/x/a.txt',
      space: 'artifacts',
      verbose: 'true',
    });
  });
});

describe('shepaw-cli resolveStoreClient', () => {
  const healthFetch = async (url: string | URL | Request) => {
    void url;
    return new Response(JSON.stringify({ device: DEVICE }), { status: 200 });
  };

  it('prefers NEXUSPOUCH_URL over hub and ROOT default', async () => {
    const client = await resolveStoreClient(
      {
        NEXUSPOUCH_URL: 'http://127.0.0.1:9001',
        SHEPAW_HUB_STORE_URL: 'http://127.0.0.1:9002',
        NEXUSPOUCH_ROOT: '/data',
        NEXUSPOUCH_ADMIN_TOKEN: 'tok',
      },
      healthFetch as typeof fetch,
    );
    expect(client?.base).toBe('http://127.0.0.1:9001');
    expect(client?.token).toBe('tok');
    expect(client?.device).toBe(DEVICE);
  });

  it('falls back to hub store, then to NEXUSPOUCH_ROOT default', async () => {
    const hub = await resolveStoreClient(
      { SHEPAW_PEER_STORE: '1' },
      healthFetch as typeof fetch,
    );
    expect(hub?.base).toBe('http://127.0.0.1:18792');

    const root = await resolveStoreClient(
      { NEXUSPOUCH_ROOT: '/data' },
      healthFetch as typeof fetch,
    );
    expect(root?.base).toBe('http://127.0.0.1:8787');
  });

  it('returns undefined when nothing is configured', async () => {
    expect(await resolveStoreClient({}, healthFetch as typeof fetch)).toBeUndefined();
  });
});

describe('shepaw-cli against mock store API', () => {
  let server: Server;
  let base = '';
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/v1/health') {
        return send(200, { device: DEVICE });
      }
      if (url.pathname === '/api/v1/uri/resolve') {
        const uri = url.searchParams.get('uri') ?? '';
        const key = uri.split('/').slice(4).join('/');
        const bytes = files.get(key);
        if (!bytes) return send(404, { error: 'not_found', message: uri });
        return send(200, { meta: { size: bytes.length, kind: 'file' } });
      }
      if (url.pathname === '/api/v1/read') {
        const uri = url.searchParams.get('uri') ?? '';
        const key = uri.split('/').slice(4).join('/');
        const bytes = files.get(key);
        if (!bytes) return send(404, { error: 'not_found', message: uri });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(bytes);
      }
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
            const path = (payload.upload_id as string).replace('u-', '');
            const part = Buffer.from(payload.data as string, 'base64');
            files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), part]));
            return send(200, { op: 'result', data: {} });
          }
          if (op === 'commit') {
            return send(200, { op: 'result', data: { committed: [], failed: [] } });
          }
          return send(400, { error: 'bad_op', message: op });
        });
        return;
      }
      send(404, { error: 'not_found', message: url.pathname });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no addr');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('write then read roundtrip with Dart-compatible envelope', async () => {
    const env = {
      NEXUSPOUCH_URL: base,
      SHEPAW_STORE_OWNER: 'agent-x',
      SHEPAW_STORE_CHANNEL: 'ch-x',
    };
    const w = makeIo(env);
    const writeCode = await runShepawCli(
      ['store', 'write', '--filename', 'report.md', '--content', '# Q2'],
      w.io,
    );
    expect(writeCode).toBe(0);
    const written = lastJson(w.out().lines);
    expect(written.success).toBe(true);
    expect(written.uri).toBe(
      `store://runtime/${DEVICE}/agent-x/ch-x/artifacts/general/report.md`,
    );
    expect(written.reference).toBe(
      `[report.md](store://runtime/${DEVICE}/agent-x/ch-x/artifacts/general/report.md)`,
    );
    expect(written.note).toMatch(/verbatim/);
    expect(createHash('sha256').update('# Q2').digest('hex')).toBe(written.sha256);

    const r = makeIo(env);
    const readCode = await runShepawCli(
      ['store', 'read', '--uri', written.uri as string],
      r.io,
    );
    expect(readCode).toBe(0);
    const read = lastJson(r.out().lines);
    expect(read).toMatchObject({
      success: true,
      uri: written.uri,
      size: 4,
      encoding: 'text',
      content: '# Q2',
    });
    expect(read.content_base64).toBeUndefined();
  });

  it('write --space artifacts keeps legacy flat path', async () => {
    const env = { NEXUSPOUCH_URL: base };
    const w = makeIo(env);
    const writeCode = await runShepawCli(
      [
        'store',
        'write',
        '--filename',
        'legacy.md',
        '--content',
        'old',
        '--space',
        'artifacts',
        '--task',
        'security',
      ],
      w.io,
    );
    expect(writeCode).toBe(0);
    const written = lastJson(w.out().lines);
    expect(written.uri).toBe(
      `store://artifacts/${DEVICE}/security/legacy.md`,
    );
  });

  it('write splits workflow scoped channel into nested dirs', async () => {
    const env = {
      NEXUSPOUCH_URL: base,
      SHEPAW_STORE_OWNER: 'peeragent_x',
      SHEPAW_STORE_CHANNEL:
        'psess_group_abc__wf_w1__step_s1',
    };
    const w = makeIo(env);
    const code = await runShepawCli(
      ['store', 'write', '--filename', 'a.md', '--content', 'x'],
      w.io,
    );
    expect(code).toBe(0);
    expect(lastJson(w.out().lines).uri).toBe(
      `store://runtime/${DEVICE}/peeragent_x/psess_group_abc/wf_w1__step_s1/artifacts/general/a.md`,
    );
  });

  it('read returns content_base64 for binary', async () => {
    files.set('bin/blob.bin', Buffer.from([0xff, 0x00, 0x01]));
    const env = { NEXUSPOUCH_URL: base };
    const r = makeIo(env);
    const code = await runShepawCli(
      ['store', 'read', '--uri', `store://files/${DEVICE}/bin/blob.bin`],
      r.io,
    );
    expect(code).toBe(0);
    const out = lastJson(r.out().lines);
    expect(out.success).toBe(true);
    expect(out.encoding).toBe('base64');
    expect(out.content_base64).toBe(Buffer.from([0xff, 0x00, 0x01]).toString('base64'));
    expect(out.content).toBeUndefined();
  });

  it('missing --uri is a JSON error with exit 1', async () => {
    const io = makeIo({ NEXUSPOUCH_URL: base });
    const code = await runShepawCli(['store', 'read'], io.io);
    expect(code).toBe(1);
    expect(lastJson(io.out().lines)).toMatchObject({
      success: false,
      error: 'missing --uri',
    });
  });

  it('unknown namespace explains the shim scope', async () => {
    const io = makeIo({ NEXUSPOUCH_URL: base });
    const code = await runShepawCli(['os', 'file.read'], io.io);
    expect(code).toBe(1);
    expect(lastJson(io.out().lines).error).toMatch(/only 'shepaw store/);
  });

  it('no backend configured is a JSON error', async () => {
    const io = makeIo({});
    const code = await runShepawCli(
      ['store', 'read', '--uri', `store://files/${DEVICE}/a.txt`],
      io.io,
    );
    expect(code).toBe(1);
    expect(lastJson(io.out().lines).error).toMatch(/no store backend/);
  });

  it('--help prints usage with exit 0', async () => {
    const io = makeIo({});
    const code = await runShepawCli(['--help'], io.io);
    expect(code).toBe(0);
    expect(io.out().lines[0]).toContain('shepaw store read');
  });
});
