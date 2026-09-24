import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  dropManagedCliSessions,
  readManagedAcpSessionIds,
  readManagedAcpSessionIdsForSync,
  sortSessionsByRecency,
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

describe('sortSessionsByRecency', () => {
  it('interleaves IDE-synced sessions with ACP ones by time', () => {
    // Concatenated upstream + disk blocks: the synced conversation is newest but
    // arrives last, which is what made it render below much older ACP sessions.
    const out = sortSessionsByRecency([
      { sessionId: 'acp-sep', updatedAt: '2026-09-10T00:00:00.000Z' },
      { sessionId: 'acp-jul', updatedAt: '2026-07-01T00:00:00.000Z' },
      { sessionId: 'ide-sep', updatedAt: '2026-09-22T15:59:00.000Z' },
    ]);
    expect(out.map((s) => s.sessionId)).toEqual(['ide-sep', 'acp-sep', 'acp-jul']);
  });

  it('compares mixed UTC offsets by instant, not by string', () => {
    const out = sortSessionsByRecency([
      { sessionId: 'utc', updatedAt: '2026-09-22T15:00:00.000Z' },
      { sessionId: 'plus8', updatedAt: '2026-09-22T23:30:00.000+08:00' },
    ]);
    expect(out.map((s) => s.sessionId)).toEqual(['plus8', 'utc']);
  });

  it('keeps timeless sessions in order, after the dated ones', () => {
    const out = sortSessionsByRecency([
      { sessionId: 'no-date-a' },
      { sessionId: 'dated', updatedAt: '2026-09-22T15:00:00.000Z' },
      { sessionId: 'blank', updatedAt: '   ' },
      { sessionId: 'no-date-b' },
    ]);
    expect(out.map((s) => s.sessionId)).toEqual([
      'dated',
      'no-date-a',
      'blank',
      'no-date-b',
    ]);
  });

  it('leaves an all-timeless list untouched', () => {
    const out = sortSessionsByRecency([{ sessionId: 'a' }, { sessionId: 'b' }]);
    expect(out.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});
