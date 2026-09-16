import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { listCodexDiskSessions } from '../src/disk-history/codex.js';
import {
  previewCodexSync,
  runCodexSync,
  loadCodexSyncManifest,
} from '../src/codex-sync.js';

const prevHome = process.env.HOME;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

describe('codex CLI disk history', () => {
  it('lists sessions for matching session_meta cwd only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-codex-cli-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/my-app';
    const otherCwd = '/Users/test/workspace/other-app';
    const sessionId = '019e2e33-cb8d-7461-a14b-ae97aaf7f3bb';
    const dir = join(root, '.codex', 'sessions', '2026', '05', '16');
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, `rollout-2026-05-16T08-33-26-${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, cwd, timestamp: '2026-05-16T00:33:26.925Z' },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T00:33:30.604Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello codex' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const otherId = '019e2e33-cb8d-7461-a14b-ae97aaf7f3cc';
    await writeFile(
      join(dir, `rollout-2026-05-16T09-00-00-${otherId}.jsonl`),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: otherId, cwd: otherCwd, timestamp: '2026-05-16T01:00:00.000Z' },
        }),
        JSON.stringify({
          timestamp: '2026-05-16T01:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'other project' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const listed = await listCodexDiskSessions(cwd);
    expect(listed.length).toBe(1);
    expect(listed[0]!.sessionId).toBe(sessionId);
    expect(listed[0]!.title).toContain('hello codex');
    expect(await listCodexDiskSessions(otherCwd)).toHaveLength(1);
  });
});

describe('codex sync manifest', () => {
  it('preview and sync only pending sessions for the instance cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-codex-sync-'));
    process.env.HOME = root;
    const cwd = '/Users/test/workspace/agent-bridge';
    const sessionId = '019e2e33-cb8d-7461-a14b-ae97aaf7f3bb';
    const dir = join(root, '.codex', 'sessions', '2026', '05', '16');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `rollout-2026-05-16T08-33-26-${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, cwd, timestamp: '2026-05-16T00:33:26.925Z' },
        }),
        JSON.stringify({
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'sync me from codex' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const syncPath = join(root, 'codex-sync.json');
    const preview = await previewCodexSync({ cwd, syncPath });
    expect(preview.pending.length).toBe(1);

    const result = await runCodexSync({ cwd, syncPath });
    expect(result.added).toBe(1);

    const manifest = await loadCodexSyncManifest(syncPath);
    expect(manifest?.sessions[sessionId]?.title).toContain('sync me from codex');
  });
});
