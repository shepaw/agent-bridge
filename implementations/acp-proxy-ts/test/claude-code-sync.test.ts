import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  listClaudeCodeDiskSessions,
  loadClaudeCodeHistory,
} from '../src/disk-history/claude-code.js';
import {
  previewClaudeCodeSync,
  runClaudeCodeSync,
  loadClaudeCodeSyncManifest,
} from '../src/claude-code-sync.js';
import { claudeProjectSlug } from '../src/disk-history/util.js';

const prevHome = process.env.HOME;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe('claude code CLI disk history', () => {
  it('lists sessions for matching workspace slug only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-cli-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/my-app';
    const slug = claudeProjectSlug(cwd);
    const sessionId = 'sess-cli-abc123';
    const dir = join(root, '.claude', 'projects', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-01T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'hello cli' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-07-01T10:00:05.000Z',
          message: { content: [{ type: 'text', text: 'hi from cli' }] },
        }),
      ].join('\n'),
      'utf-8',
    );

    const messages = await loadClaudeCodeHistory(sessionId, cwd);
    expect(messages).not.toBeNull();
    expect(messages!.length).toBe(2);
    expect(messages![0]!.content).toBe('hello cli');

    const listed = await listClaudeCodeDiskSessions(cwd);
    expect(listed.length).toBe(1);
    expect(listed[0]!.sessionId).toBe(sessionId);
    expect(listed[0]!.title).toContain('hello cli');

    expect(await listClaudeCodeDiskSessions('/other/project')).toEqual([]);
  });
});

describe('claude code sync manifest', () => {
  it('preview and sync only pending sessions for the instance cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-sync-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/agent-bridge';
    const slug = claudeProjectSlug(cwd);
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const dir = join(root, '.claude', 'projects', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-01T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'sync me from cli' }] },
      }),
      'utf-8',
    );

    const syncPath = join(root, 'claude-code-sync.json');
    const preview = await previewClaudeCodeSync({ cwd, syncPath });
    expect(preview.pending.length).toBe(1);
    expect(preview.synced.length).toBe(0);

    const result = await runClaudeCodeSync({ cwd, syncPath });
    expect(result.added).toBe(1);
    expect(result.total).toBe(1);

    const preview2 = await previewClaudeCodeSync({ cwd, syncPath });
    expect(preview2.pending.length).toBe(0);
    expect(preview2.synced.length).toBe(1);

    const manifest = await loadClaudeCodeSyncManifest(syncPath);
    expect(manifest?.cwd).toBe(cwd);
    expect(manifest?.sessions[sessionId]?.title).toContain('sync me from cli');
  });

  it('excludes sessions already mapped in sessions.json from pending sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-acp-skip-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/agent-bridge';
    const slug = claudeProjectSlug(cwd);
    const dir = join(root, '.claude', 'projects', slug);
    await mkdir(dir, { recursive: true });

    const managedId = 'managed-acp-session';
    const nativeId = 'native-cli-session';
    for (const [sessionId, text] of [
      [managedId, 'already chatting via acp'],
      [nativeId, 'native cli only'],
    ] as const) {
      await writeFile(
        join(dir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-01T10:00:00.000Z',
          message: { content: [{ type: 'text', text }] },
        }),
        'utf-8',
      );
    }

    const sessionStorePath = join(root, 'sessions.json');
    await writeFile(
      sessionStorePath,
      JSON.stringify({ version: 1, map: { 'app-1': managedId } }),
      'utf-8',
    );

    const syncPath = join(root, 'claude-code-sync.json');
    const preview = await previewClaudeCodeSync({ cwd, syncPath, sessionStorePath });
    expect(preview.pending.map((s) => s.sessionId)).toEqual([nativeId]);

    const result = await runClaudeCodeSync({ cwd, syncPath, sessionStorePath });
    expect(result.added).toBe(1);
    const manifest = await loadClaudeCodeSyncManifest(syncPath);
    expect(Object.keys(manifest?.sessions ?? {})).toEqual([nativeId]);
  });

  it('does not bleed sessions when cwd changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-claude-sync2-'));
    const syncPath = join(root, 'claude-code-sync.json');
    const cwdA = '/Users/test/project-a';
    const cwdB = '/Users/test/project-b';

    await runClaudeCodeSync({
      cwd: cwdA,
      syncPath,
      sessionIds: ['fake-id'],
    });

    process.env.HOME = root;
    const preview = await previewClaudeCodeSync({ cwd: cwdB, syncPath });
    expect(preview.synced.length).toBe(0);
  });
});
