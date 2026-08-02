import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import {
  promptToPlainText,
  SessionTranscriptSink,
} from '../src/session-transcript-sink.js';
import { StoreToolsClient } from '../src/store-tools.js';

describe('promptToPlainText', () => {
  it('joins text blocks', () => {
    expect(promptToPlainText('hi')).toBe('hi');
    expect(
      promptToPlainText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });
});

describe('SessionTranscriptSink', () => {
  it('fromEnv returns null without device/token', () => {
    expect(SessionTranscriptSink.fromEnv({}, 'claude')).toBeNull();
    expect(
      SessionTranscriptSink.fromEnv(
        { NEXUSPOUCH_URL: 'http://127.0.0.1:8787', NEXUSPOUCH_TRANSCRIPT: 'off' },
        'claude',
      ),
    ).toBeNull();
  });

  describe('flush to sessions', () => {
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
        if (url.pathname === '/api/v1/store' && req.method === 'POST') {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const { op, payload } = JSON.parse(raw) as {
              op: string;
              payload: Record<string, unknown>;
            };
            if (op === 'write.begin') {
              const path = String(payload.path);
              files.set(path, Buffer.alloc(0));
              return send(200, {
                op: 'result',
                data: { upload_id: `u-${path}` },
              });
            }
            if (op === 'write.chunk') {
              const path = String(payload.upload_id).replace(/^u-/, '');
              const cur = files.get(path) ?? Buffer.alloc(0);
              const part = Buffer.from(String(payload.data), 'base64');
              files.set(path, Buffer.concat([cur, part]));
              return send(200, { op: 'result', data: {} });
            }
            if (op === 'commit') {
              const path = String((payload.upload_ids as string[])[0]).replace(/^u-/, '');
              const bytes = files.get(path) ?? Buffer.alloc(0);
              const sha = createHash('sha256').update(bytes).digest('hex');
              return send(200, {
                op: 'result',
                data: { committed: [{ path, sha256: sha, size: bytes.length }] },
              });
            }
            return send(400, { error: 'bad_op', message: op });
          });
          return;
        }
        send(404, { error: 'not_found' });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('writes NDJSON under sessions/<agent>/<session>.jsonl', async () => {
      const client = new StoreToolsClient(base, 'tok', 'aaaaaaaaaaaaaaaa');
      const sink = new SessionTranscriptSink({
        client,
        agent: 'Claude Code',
        debounceMs: 0,
        now: () => 1_700_000_000_000,
      });
      sink.append('sess/1', 'user', 'hello');
      sink.append('sess/1', 'assistant', 'world');
      await sink.flush('sess/1');

      const path = 'claude-code/sess_1.jsonl';
      expect(files.has(path)).toBe(true);
      const text = files.get(path)!.toString('utf8');
      const lines = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { role: string; content: string; agent: string });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        role: 'user',
        content: 'hello',
        agent: 'claude-code',
      });
      expect(lines[1]).toMatchObject({ role: 'assistant', content: 'world' });
    });
  });
});
