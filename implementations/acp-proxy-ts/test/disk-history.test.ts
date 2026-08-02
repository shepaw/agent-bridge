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
  it('coalesces consecutive assistant entries into one reply turn', async () => {
    // Regression: Claude Code writes one assistant line per text/tool segment;
    // tool_result user lines extract to '' and vanish, leaving back-to-back
    // assistant entries. The app renders one bubble per history message, so an
    // unmerged list made a single streamed reply reappear as several bubbles.
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-'));
    const cwd = '/tmp/shepaw-claude-proj';
    const dir = join(root, '.claude', 'projects', claudeProjectSlug(cwd));
    await mkdir(dir, { recursive: true });
    const sessionId = 'sess-claude-2';
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-01T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'fix the bug' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-01T10:00:05.000Z',
          message: { content: [{ type: 'text', text: 'Let me look.' }] },
        }),
        // tool_result user line — no text blocks, must be skipped entirely.
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-07-01T10:00:06.000Z',
          message: { content: [{ type: 'tool_result', content: 'file contents' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2026-07-01T10:00:10.000Z',
          message: { content: [{ type: 'text', text: 'Found it.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a3',
          timestamp: '2026-07-01T10:00:20.000Z',
          message: { content: [{ type: 'text', text: 'Fixed, tests pass.' }] },
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
          content: 'fix the bug',
          created_at: '2026-07-01T10:00:00.000Z',
          message_id: 'u1',
        },
        {
          role: 'agent',
          content: 'Let me look.\n\nFound it.\n\nFixed, tests pass.',
          // First segment's timestamp/message_id win — matches the live bubble.
          created_at: '2026-07-01T10:00:05.000Z',
          message_id: 'a1',
        },
      ]);
    } finally {
      process.env.HOME = prev;
    }
  });
  it('splits thinking/tool_use blocks into the progress section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-'));
    const cwd = '/tmp/shepaw-claude-proj';
    const dir = join(root, '.claude', 'projects', claudeProjectSlug(cwd));
    await mkdir(dir, { recursive: true });
    const sessionId = 'sess-claude-3';
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-01T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'run ls' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-01T10:00:05.000Z',
          message: {
            content: [
              { type: 'thinking', thinking: 'User wants a listing.' },
              { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
              { type: 'text', text: 'Here is the listing.' },
            ],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const messages = await loadClaudeCodeHistory(sessionId, cwd);
      expect(messages).toHaveLength(2);
      const agent = messages![1];
      expect(agent.content).toBe('Here is the listing.');
      expect(agent.progress_content).toBe(
        'User wants a listing.\n[completed] Bash\n```\nls -la\n```',
      );
      expect(agent.progress_title).toBe('Bash');
      expect(agent.progress_auto_collapse).toBe(true);
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

  it('does not duplicate the final answer carried by task_complete', async () => {
    // task_complete.last_agent_message repeats the final assistant message;
    // without the guard it surfaced as an extra bubble (or duplicated text
    // inside the coalesced reply).
    const root = await mkdtemp(join(tmpdir(), 'shepaw-codex-'));
    const sessionId = '019e2e33-cb8d-7461-a14b-ae97aaf7f3bb';
    const dir = join(root, '.codex', 'sessions', '2026', '05', '16');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-05-16T08-33-26-${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-05-16T00:33:30.604Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run tests' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T00:33:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'All green.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T00:33:36.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', last_agent_message: 'All green.' },
        }),
        // A task_complete with NEW text (summary not streamed before) must
        // still be kept — merged into the same reply turn with a boundary.
        JSON.stringify({
          timestamp: '2026-05-16T00:33:37.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', last_agent_message: 'Summary: 12 passed.' },
        }),
      ].join('\n'),
      'utf-8',
    );

    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const messages = await loadCodexHistory(sessionId);
      expect(messages).toEqual([
        {
          role: 'user',
          content: 'run tests',
          created_at: '2026-05-16T00:33:30.604Z',
        },
        {
          role: 'agent',
          content: 'All green.\n\nSummary: 12 passed.',
          created_at: '2026-05-16T00:33:35.000Z',
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

describe('loadCodexHistory progress', () => {
  it('maps reasoning/function_call/local_shell_call into the progress section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-codex-'));
    const sessionId = '019e2e33-cb8d-7461-a14b-ae97aaf7f3bb';
    const dir = join(root, '.codex', 'sessions', '2026', '05', '16');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-05-16T08-33-26-${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-05-16T00:33:30.604Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'build it' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T00:33:31.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Need to compile first.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T00:33:32.000Z',
          type: 'response_item',
          payload: { type: 'local_shell_call', action: { command: ['npm', 'run', 'build'] } },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T00:33:33.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Build passed.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const messages = await loadCodexHistory(sessionId);
      expect(messages).toHaveLength(2);
      const agent = messages![1];
      expect(agent.content).toBe('Build passed.');
      expect(agent.progress_content).toBe(
        'Need to compile first.\n[completed] Shell\n```\nnpm run build\n```',
      );
      expect(agent.progress_title).toBe('Shell');
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('loadOpencodeHistory progress', () => {
  it('maps tool/reasoning parts into the progress section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-oc-'));
    const sessionId = 'ses_prog';
    const msgId = 'msg_prog';
    const dataHome = join(root, 'share');
    await mkdir(join(dataHome, 'opencode', 'storage', 'message', sessionId), { recursive: true });
    await mkdir(join(dataHome, 'opencode', 'storage', 'part', msgId), { recursive: true });
    await writeFile(
      join(dataHome, 'opencode', 'storage', 'message', sessionId, `${msgId}.json`),
      JSON.stringify({ id: msgId, role: 'assistant', time: { created: 1_720_000_000_000 } }),
      'utf-8',
    );
    const partDir = join(dataHome, 'opencode', 'storage', 'part', msgId);
    await writeFile(
      join(partDir, 'prt_1.json'),
      JSON.stringify({ type: 'reasoning', text: 'Thinking it over.' }),
      'utf-8',
    );
    await writeFile(
      join(partDir, 'prt_2.json'),
      JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'go test ./...' } },
      }),
      'utf-8',
    );
    await writeFile(
      join(partDir, 'prt_3.json'),
      JSON.stringify({ type: 'text', text: 'Tests pass.' }),
      'utf-8',
    );

    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = dataHome;
    try {
      const messages = await loadOpencodeHistory(sessionId);
      expect(messages).toHaveLength(1);
      const agent = messages![0];
      expect(agent.content).toBe('Tests pass.');
      expect(agent.progress_content).toBe(
        'Thinking it over.\n[completed] bash\n```\ngo test ./...\n```',
      );
      expect(agent.progress_title).toBe('bash');
    } finally {
      process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });
});
