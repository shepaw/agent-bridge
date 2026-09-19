import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  dropManagedCliSessions,
  readManagedAcpSessionIds,
  readManagedAcpSessionIdsForSync,
} from '../src/sessions-list.js';

describe('readManagedAcpSessionIds', () => {
  it('returns mapped and orphaned upstream ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shepaw-sessions-list-'));
    const path = join(dir, 'sessions.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        map: {
          'app-chat-1': 'acp-live',
          'acp-adopted': 'acp-adopted',
        },
        orphanedSdkIds: ['acp-fork-old', ''],
      }),
      'utf-8',
    );

    expect(await readManagedAcpSessionIds(path)).toEqual(
      new Set(['acp-live', 'acp-adopted', 'acp-fork-old']),
    );
  });

  it('returns empty for missing or invalid stores', async () => {
    expect(await readManagedAcpSessionIds(undefined)).toEqual(new Set());
    expect(await readManagedAcpSessionIds('/no/such/sessions.json')).toEqual(new Set());
    const dir = await mkdtemp(join(tmpdir(), 'shepaw-sessions-list-bad-'));
    const path = join(dir, 'sessions.json');
    await writeFile(path, '{not json', 'utf-8');
    expect(await readManagedAcpSessionIds(path)).toEqual(new Set());
  });

  it('defaults to sessions.json next to the CLI sync manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shepaw-sessions-sibling-'));
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify({ version: 1, map: { app: 'acp-sibling' } }),
      'utf-8',
    );
    expect(
      await readManagedAcpSessionIdsForSync({ syncPath: join(dir, 'cursor-ide-sync.json') }),
    ).toEqual(new Set(['acp-sibling']));
  });
});

describe('dropManagedCliSessions', () => {
  it('keeps only sessions ACP does not already manage', () => {
    const out = dropManagedCliSessions(
      [{ sessionId: 'native' }, { sessionId: 'acp-live' }, { sessionId: 'acp-fork-old' }],
      new Set(['acp-live', 'acp-fork-old']),
    );
    expect(out.map((s) => s.sessionId)).toEqual(['native']);
  });
});
