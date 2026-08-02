import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from '../src/index.js';

describe('SessionStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-store-'));
    path = join(dir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the shepaw→sdk mapping across reloads', async () => {
    const store = new SessionStore({ path });
    store.set('shepaw-1', 'sdk-a');
    await store.flush();

    const reloaded = new SessionStore({ path });
    await reloaded.load();
    expect(reloaded.get('shepaw-1')).toBe('sdk-a');
    expect(reloaded.findShepawIdBySdkId('sdk-a')).toBe('shepaw-1');
  });

  it('persists orphaned sdk ids across reloads', async () => {
    const store = new SessionStore({ path });
    store.set('shepaw-1', 'sdk-a');
    store.markOrphaned('sdk-old');
    await store.flush();

    const reloaded = new SessionStore({ path });
    await reloaded.load();
    expect(reloaded.isOrphaned('sdk-old')).toBe(true);
    expect(reloaded.orphanedSdkSessionIds()).toEqual(new Set(['sdk-old']));
    expect(reloaded.isOrphaned('sdk-a')).toBe(false);
  });

  it('revives an orphaned id when a mapping is (re)established to it', async () => {
    const store = new SessionStore({ path });
    store.markOrphaned('sdk-a');
    expect(store.isOrphaned('sdk-a')).toBe(true);

    store.set('shepaw-9', 'sdk-a');
    expect(store.isOrphaned('sdk-a')).toBe(false);
    await store.flush();

    const reloaded = new SessionStore({ path });
    await reloaded.load();
    expect(reloaded.isOrphaned('sdk-a')).toBe(false);
  });

  it('ignores empty orphan ids and dedupes repeats', async () => {
    const store = new SessionStore({ path });
    store.markOrphaned('');
    store.markOrphaned('sdk-x');
    store.markOrphaned('sdk-x');
    expect(store.orphanedSdkSessionIds()).toEqual(new Set(['sdk-x']));
  });

  it('established ids exclude identity (adopted) pre-seeds', () => {
    const store = new SessionStore({ path });
    store.set('shepaw-1', 'sdk-a');
    store.set('sdk-adopted', 'sdk-adopted');
    expect(store.establishedSdkSessionIds()).toEqual(new Set(['sdk-a']));
  });
});
