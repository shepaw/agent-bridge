import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runShepawCli } from '../src/shepaw-cli.js';
import { buildSessionCreatePayload } from '../src/shepaw-cli-session.js';

function lastJson(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

describe('buildSessionCreatePayload', () => {
  it('builds a dm payload from flags + env fallbacks', () => {
    const out = buildSessionCreatePayload({
      kind: 'dm',
      flags: {
        reason: 'context_too_long',
        summary: 'Keep the auth token flow',
      },
      env: {
        SHEPAW_STORE_CHANNEL: 'dm_abc',
        SHEPAW_STORE_AGENT_ID: 'cursor-1',
      },
    });
    expect(out).toEqual({
      ok: true,
      payload: {
        kind: 'dm',
        channel_id: 'dm_abc',
        agent_id: 'cursor-1',
        agent_name: 'cursor-1',
        reason: 'context_too_long',
        summary: 'Keep the auth token flow',
        post_first_message: true,
        suggest_switch: true,
      },
    });
  });

  it('parses group handoff-json', () => {
    const out = buildSessionCreatePayload({
      kind: 'group',
      flags: {
        channel: 'group_1',
        agent_id: 'admin-1',
        reason: 'topic_shift',
        'handoff-json':
          '{"task":{"user_goal":"ship","acceptance_criteria":["ok"],"status":"in_progress"}}',
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.kind).toBe('group');
    expect(out.payload.handoff).toMatchObject({
      task: { user_goal: 'ship' },
    });
  });

  it('rejects dm without summary or handoff', () => {
    const out = buildSessionCreatePayload({
      kind: 'dm',
      flags: { reason: 'topic_shift', channel: 'dm_x', agent_id: 'a' },
    });
    expect(out).toEqual({
      ok: false,
      error: 'Provide --summary or --handoff-json',
    });
  });
});

describe('shepaw chat session create HTTP', () => {
  let server: Server;
  let base = '';
  let lastBody: Record<string, unknown> | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/v1/chat/session-create') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          lastBody = JSON.parse(raw) as Record<string, unknown>;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              new_session_id: 'dm_new_1',
              session_action: { new_session_id: 'dm_new_1' },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no addr');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts dm create to Hub session-create', async () => {
    const lines: string[] = [];
    const code = await runShepawCli(
      [
        'chat',
        'session',
        'create',
        '--reason',
        'context_too_long',
        '--summary',
        'Keep auth',
      ],
      {
        env: {
          SHEPAW_HUB_STORE_URL: base,
          SHEPAW_STORE_CHANNEL: 'dm_old',
          SHEPAW_STORE_AGENT_ID: 'eng-1',
        },
        stdout: (t) => lines.push(t),
      },
    );
    expect(code).toBe(0);
    expect(lastJson(lines)).toMatchObject({
      success: true,
      new_session_id: 'dm_new_1',
    });
    expect(lastBody).toMatchObject({
      kind: 'dm',
      channel_id: 'dm_old',
      agent_id: 'eng-1',
      reason: 'context_too_long',
      summary: 'Keep auth',
    });
  });

  it('posts group create', async () => {
    const lines: string[] = [];
    const code = await runShepawCli(
      [
        'chat',
        'group',
        'session',
        'create',
        '--reason',
        'topic_shift',
        '--handoff-json',
        '{"task":{"user_goal":"next"}}',
      ],
      {
        env: {
          SHEPAW_HUB_STORE_URL: base,
          SHEPAW_STORE_CHANNEL: 'group_9',
          SHEPAW_STORE_AGENT_ID: 'admin-1',
        },
        stdout: (t) => lines.push(t),
      },
    );
    expect(code).toBe(0);
    expect(lastBody).toMatchObject({
      kind: 'group',
      channel_id: 'group_9',
    });
  });
});
