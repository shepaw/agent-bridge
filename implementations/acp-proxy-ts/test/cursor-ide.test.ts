import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadCursorIdeHistory,
  listCursorIdeDiskSessions,
  parseCursorIdeUserText,
} from '../src/disk-history/cursor-ide.js';
import {
  previewCursorIdeSync,
  runCursorIdeSync,
  loadCursorIdeSyncManifest,
  shouldBindListedSessionAsAcp,
} from '../src/cursor-ide-sync.js';
import { claudeProjectSlug, cursorProjectSlug } from '../src/disk-history/util.js';

const prevHome = process.env.HOME;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe('parseCursorIdeUserText', () => {
  it('extracts user_query and timestamp', () => {
    const raw =
      '<timestamp>Thursday, Aug 13, 2026, 9:10 PM (UTC+8)</timestamp>\n<user_query>\n重启\n</user_query>';
    const out = parseCursorIdeUserText(raw);
    expect(out.text).toBe('重启');
    expect(out.createdAt).toMatch(/^2026-/);
  });
});

describe('cursor IDE disk history', () => {
  it('loads transcript jsonl for matching workspace slug only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-cursor-ide-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/my-app';
    const slug = cursorProjectSlug(cwd);
    const sessionId = 'aaaa-bbbb-cccc-dddd';
    const dir = join(root, '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          role: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: '<timestamp>Thursday, Aug 13, 2026, 9:10 PM (UTC+8)</timestamp>\n<user_query>\nhello ide</user_query>',
              },
            ],
          },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [{ type: 'text', text: 'hi from ide' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const messages = await loadCursorIdeHistory(sessionId, cwd);
    expect(messages).not.toBeNull();
    expect(messages!.length).toBe(2);
    expect(messages![0]!.role).toBe('user');
    expect(messages![0]!.content).toBe('hello ide');
    expect(messages![1]!.content).toBe('hi from ide');

    const listed = await listCursorIdeDiskSessions(cwd);
    expect(listed.length).toBe(1);
    expect(listed[0]!.sessionId).toBe(sessionId);
    expect(listed[0]!.title).toContain('hello ide');

    // Different cwd → different slug → no sessions.
    expect(await listCursorIdeDiskSessions('/other/project')).toEqual([]);
  });

  it('ignores transcripts stored under the Claude Code leading-dash slug', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-cursor-ide-dash-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/my-app';
    const sessionId = 'dash-slug-session';
    const dir = join(
      root,
      '.cursor',
      'projects',
      claudeProjectSlug(cwd),
      'agent-transcripts',
      sessionId,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>\nwrong slug</user_query>' }] },
      }),
      'utf-8',
    );

    expect(await listCursorIdeDiskSessions(cwd)).toEqual([]);
  });
});

describe('shouldBindListedSessionAsAcp', () => {
  it('keeps ACP sessions bound and leaves Cursor IDE transcripts unbound', () => {
    const ideOnly = new Set(['ide-session']);
    expect(shouldBindListedSessionAsAcp('acp-session', ideOnly)).toBe(true);
    expect(shouldBindListedSessionAsAcp('ide-session', ideOnly)).toBe(false);
    expect(shouldBindListedSessionAsAcp('ide-session', undefined)).toBe(true);
  });
});

describe('cursor IDE sync manifest', () => {
  it('preview and sync only pending sessions for the instance cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-cursor-sync-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/agent-bridge';
    const slug = cursorProjectSlug(cwd);
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const dir = join(root, '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>\nsync me</user_query>' }] },
      }),
      'utf-8',
    );

    const syncPath = join(root, 'cursor-ide-sync.json');
    const preview = await previewCursorIdeSync({ cwd, syncPath });
    expect(preview.pending.length).toBe(1);
    expect(preview.synced.length).toBe(0);

    const result = await runCursorIdeSync({ cwd, syncPath });
    expect(result.added).toBe(1);
    expect(result.total).toBe(1);

    const preview2 = await previewCursorIdeSync({ cwd, syncPath });
    expect(preview2.pending.length).toBe(0);
    expect(preview2.synced.length).toBe(1);

    const manifest = await loadCursorIdeSyncManifest(syncPath);
    expect(manifest?.cwd).toBe(cwd);
    expect(manifest?.sessions[sessionId]?.title).toContain('sync me');
  });

  it('excludes sessions already mapped in sessions.json from pending sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-cursor-acp-skip-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/agent-bridge';
    const slug = cursorProjectSlug(cwd);
    const managedId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const orphanedId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const nativeId = 'cccccccc-1111-2222-3333-444444444444';

    for (const [sessionId, query] of [
      [managedId, 'already in app via acp'],
      [orphanedId, 'abandoned fork half'],
      [nativeId, 'native ide chat'],
    ] as const) {
      const dir = join(root, '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${sessionId}.jsonl`),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: `<user_query>\n${query}</user_query>` }] },
        }),
        'utf-8',
      );
    }

    const sessionStorePath = join(root, 'sessions.json');
    await writeFile(
      sessionStorePath,
      JSON.stringify({
        version: 1,
        map: { 'shepaw-chat-1': managedId },
        orphanedSdkIds: [orphanedId],
      }),
      'utf-8',
    );

    const syncPath = join(root, 'cursor-ide-sync.json');
    const preview = await previewCursorIdeSync({ cwd, syncPath, sessionStorePath });
    expect(preview.onDisk.map((s) => s.sessionId)).toEqual([nativeId]);
    expect(preview.pending.map((s) => s.sessionId)).toEqual([nativeId]);

    const result = await runCursorIdeSync({ cwd, syncPath, sessionStorePath });
    expect(result.added).toBe(1);
    expect(result.total).toBe(1);
    const manifest = await loadCursorIdeSyncManifest(syncPath);
    expect(manifest?.sessions[nativeId]).toBeDefined();
    expect(manifest?.sessions[managedId]).toBeUndefined();
    expect(manifest?.sessions[orphanedId]).toBeUndefined();
  });

  it('does not bleed sessions when cwd changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-cursor-sync2-'));
    const syncPath = join(root, 'cursor-ide-sync.json');
    const cwdA = '/Users/test/project-a';
    const cwdB = '/Users/test/project-b';

    await runCursorIdeSync({
      cwd: cwdA,
      syncPath,
      sessionIds: ['fake-id'],
    });

    process.env.HOME = root;
    const preview = await previewCursorIdeSync({ cwd: cwdB, syncPath });
    expect(preview.synced.length).toBe(0);
  });
});
