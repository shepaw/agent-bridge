import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { listOpencodeDiskSessions } from '../src/disk-history/opencode.js';
import {
  previewOpencodeSync,
  runOpencodeSync,
  loadOpencodeSyncManifest,
} from '../src/opencode-sync.js';

const prevHome = process.env.HOME;
const prevXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdg;
});

function storageRoot(root: string): string {
  return join(root, 'opencode', 'storage');
}

describe('opencode CLI disk history', () => {
  it('lists sessions for matching directory only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-opencode-cli-'));
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = root;
    const cwd = '/Users/test/workspace/my-app';
    const otherCwd = '/Users/test/workspace/other-app';
    const sessionId = 'ses_test123';
    const projectId = 'proj123';
    const sessionDir = join(storageRoot(root), 'session', projectId);
    const messageDir = join(storageRoot(root), 'message', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(messageDir, { recursive: true });

    await writeFile(
      join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        directory: cwd,
        title: 'Fix the bug',
        time: { created: 1768575943569, updated: 1768575952695 },
      }),
      'utf-8',
    );

    const msgId = 'msg_1';
    await writeFile(
      join(messageDir, `${msgId}.json`),
      JSON.stringify({ id: msgId, role: 'user', time: { created: 1768575943569 } }),
      'utf-8',
    );
    await mkdir(join(storageRoot(root), 'part', msgId), { recursive: true });
    await writeFile(
      join(storageRoot(root), 'part', msgId, 'prt_1.json'),
      JSON.stringify({ type: 'text', text: 'hello opencode' }),
      'utf-8',
    );

    const otherId = 'ses_other456';
    await writeFile(
      join(sessionDir, `${otherId}.json`),
      JSON.stringify({
        id: otherId,
        directory: otherCwd,
        title: 'Other project',
        time: { created: 1768575943569, updated: 1768575952695 },
      }),
      'utf-8',
    );

    const listed = await listOpencodeDiskSessions(cwd);
    expect(listed.length).toBe(1);
    expect(listed[0]!.sessionId).toBe(sessionId);
    expect(listed[0]!.title).toContain('hello opencode');
  });
});

describe('opencode sync manifest', () => {
  it('preview and sync pending sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shepaw-opencode-sync-'));
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = root;
    const cwd = '/Users/test/workspace/agent-bridge';
    const sessionId = 'ses_sync789';
    const projectId = 'proj789';
    const sessionDir = join(storageRoot(root), 'session', projectId);
    const messageDir = join(storageRoot(root), 'message', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(messageDir, { recursive: true });

    await writeFile(
      join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        directory: cwd,
        title: 'Sync me',
        time: { created: 1768575943569, updated: 1768575952695 },
      }),
      'utf-8',
    );

    const msgId = 'msg_sync';
    await writeFile(
      join(messageDir, `${msgId}.json`),
      JSON.stringify({ id: msgId, role: 'user', time: { created: 1768575943569 } }),
      'utf-8',
    );
    await mkdir(join(storageRoot(root), 'part', msgId), { recursive: true });
    await writeFile(
      join(storageRoot(root), 'part', msgId, 'prt_1.json'),
      JSON.stringify({ type: 'text', text: 'sync me from opencode' }),
      'utf-8',
    );

    const syncPath = join(root, 'opencode-sync.json');
    const preview = await previewOpencodeSync({ cwd, syncPath });
    expect(preview.pending.length).toBe(1);

    const result = await runOpencodeSync({ cwd, syncPath });
    expect(result.added).toBe(1);

    const manifest = await loadOpencodeSyncManifest(syncPath);
    expect(manifest?.sessions[sessionId]?.title).toContain('sync me from opencode');
  });
});
