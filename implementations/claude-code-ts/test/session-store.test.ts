import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from '../src/session-store.js';

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shepaw-session-store-'));
  storePath = join(dir, 'sessions.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('SessionStore', () => {
  it('load() on a missing file is a no-op', async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    expect(store.get('anything')).toBeUndefined();
  });

  it('set() persists to disk (debounced) and is readable after load()', async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    store.set('shepaw-s1', 'sdk-uuid-1');
    expect(store.get('shepaw-s1')).toBe('sdk-uuid-1');

    // Wait past the 200 ms debounce window.
    await wait(300);
    const raw = await readFile(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as { version: number; map: Record<string, string> };
    expect(parsed.version).toBe(1);
    expect(parsed.map['shepaw-s1']).toBe('sdk-uuid-1');

    // Fresh store should re-read it.
    const other = new SessionStore({ path: storePath });
    await other.load();
    expect(other.get('shepaw-s1')).toBe('sdk-uuid-1');
  });

  it('set() same value twice does not schedule an extra write', async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    store.set('s1', 'v1');
    store.set('s1', 'v1'); // no-op
    await store.flush();

    const raw = await readFile(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as { map: Record<string, string> };
    expect(parsed.map).toEqual({ s1: 'v1' });
  });

  it('flush() writes immediately, bypassing the debounce', async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    store.set('s1', 'v1');
    await store.flush();
    const raw = await readFile(storePath, 'utf-8');
    expect(JSON.parse(raw).map.s1).toBe('v1');
  });

  it('load() ignores a corrupt file without throwing', async () => {
    // Write garbage to storePath, then load.
    await (await import('node:fs/promises')).writeFile(storePath, 'not json', 'utf-8');
    const store = new SessionStore({ path: storePath });
    await store.load(); // should not throw
    expect(store.get('anything')).toBeUndefined();
  });
});
