import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadClaudeCodeHistory } from '../src/disk-history/claude-code.js';
import { loadCodebuddyHistory } from '../src/disk-history/codebuddy.js';
import { loadCodexHistory } from '../src/disk-history/codex.js';
import { loadOpencodeHistory } from '../src/disk-history/opencode.js';
import { claudeProjectSlug, codebuddyProjectSlug, textFromContentBlocks } from '../src/disk-history/util.js';
import { tryLoadDiskHistory } from '../src/disk-history/index.js';

describe('disk-history util', () => {
  it('encodes project slugs', () => {
    expect(claudeProjectSlug('/Users/edenzou/proj')).toBe('-Users-edenzou-proj');
    expect(codebuddyProjectSlug('/Users/edenzou/proj')).toBe('Users-edenzou-proj');
  });

  it('extracts text from content blocks', () => {
    expect(
      textFromContentBlocks([
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: 'hello' },
        { type: 'output_text', text: 'world' },
      ]),
    ).toBe('hello\nworld');
  });
});

describe('loadClaudeCodeHistory', () => {
  it('reads user/assistant timestamps from jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-'));
    const cwd = '/tmp/shepaw-claude-proj';
    const dir = join(root, '.claude', 'projects', claudeProjectSlug(cwd));
    await mkdir(dir, { recursive: true });
    const sessionId = 'sess-claude-1';
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-01T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'hi' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-01T10:00:05.000Z',
          message: { content: [{ type: 'text', text: 'hello' }] },
        }),
      ].join('\n'),
      'utf-8',
    );

    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const messages = await loadClaudeCodeHistory(sessionId, cwd);
      expect(messages).toEqual([
        {
          role: 'user',
          content: 'hi',
          created_at: '2026-07-01T10:00:00.000Z',
          message_id: 'u1',
        },
        {
          role: 'agent',
          content: 'hello',
          created_at: '2026-07-01T10:00:05.000Z',
          message_id: 'a1',
        },
      ]);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('loadCodebuddyHistory', () => {
  it('reads millisecond timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-cb-'));
    const cwd = '/tmp/shepaw-cb-proj';
    const dir = join(root, '.codebuddy', 'projects', codebuddyProjectSlug(cwd));
    await mkdir(dir, { recursive: true });
    const sessionId = 'sess-cb-1';
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'message',
        role: 'user',
        timestamp: 1_720_000_000_000,
        content: [{ type: 'input_text', text: 'ping' }],
      }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: 1_720_000_001_000,
          content: [{ type: 'output_text', text: 'pong' }],
        }),
      'utf-8',
    );

    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const messages = await loadCodebuddyHistory(sessionId, cwd);
      expect(messages?.[0].created_at).toBe(new Date(1_720_000_000_000).toISOString());
      expect(messages?.[1]).toMatchObject({ role: 'agent', content: 'pong' });
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('loadCodexHistory', () => {
  it('reads response_item user messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-codex-'));
    const sessionId = '019e2e33-cb8d-7461-a14b-ae97aaf7f3bb';
    const dir = join(root, '.codex', 'sessions', '2026', '05', '16');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-05-16T08-33-26-${sessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-05-16T00:33:30.604Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi codex' }],
        },
      }),
      'utf-8',
    );

    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const messages = await loadCodexHistory(sessionId);
      expect(messages).toEqual([
        {
          role: 'user',
          content: 'hi codex',
          created_at: '2026-05-16T00:33:30.604Z',
        },
      ]);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('loadOpencodeHistory', () => {
  it('joins text parts with message timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-oc-'));
    const sessionId = 'ses_test1';
    const msgId = 'msg_test1';
    const dataHome = join(root, 'share');
    await mkdir(join(dataHome, 'opencode', 'storage', 'message', sessionId), { recursive: true });
    await mkdir(join(dataHome, 'opencode', 'storage', 'part', msgId), { recursive: true });
    await writeFile(
      join(dataHome, 'opencode', 'storage', 'message', sessionId, `${msgId}.json`),
      JSON.stringify({
        id: msgId,
        role: 'user',
        time: { created: 1_720_000_000_000 },
      }),
      'utf-8',
    );
    await writeFile(
      join(dataHome, 'opencode', 'storage', 'part', msgId, 'prt_1.json'),
      JSON.stringify({ type: 'text', text: 'from opencode' }),
      'utf-8',
    );

    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = dataHome;
    try {
      const messages = await loadOpencodeHistory(sessionId);
      expect(messages).toEqual([
        {
          role: 'user',
          content: 'from opencode',
          created_at: new Date(1_720_000_000_000).toISOString(),
          message_id: msgId,
        },
      ]);
    } finally {
      process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });
});

describe('tryLoadDiskHistory', () => {
  it('returns null for cursor (uses session/load path)', async () => {
    expect(await tryLoadDiskHistory('cursor', 'x', '/tmp')).toBeNull();
  });
});
