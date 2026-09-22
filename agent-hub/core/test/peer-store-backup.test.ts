import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import { PeerLocalStore } from '../src/peer/peer-local-store.js';
import {
  reconcilePeerBackup,
  type StoreCaller,
} from '../src/peer/peer-store-backup.js';

function seed(store: PeerLocalStore, device: string, space: string, path: string, text: string): void {
  const content = Buffer.from(text);
  const sha = createHash('sha256').update(content).digest('hex');
  const begin = store.writeBegin({
    deviceId: device,
    space,
    path,
    size: content.length,
    sha256: sha,
  });
  for (let offset = 0; offset < content.length; offset += 64 * 1024) {
    store.writeChunk(device, begin.upload_id, offset, content.subarray(offset, offset + 64 * 1024));
  }
  const committed = store.commit(device, space, [begin.upload_id]);
  if (committed.failed.length > 0) throw new Error('seed failed');
}

function remoteCall(remote: PeerLocalStore, device: string): StoreCaller {
  return async (op, payload) => {
    const space = String(payload.space ?? '');
    const path = typeof payload.path === 'string' ? payload.path : '';
    const dev = String(payload.device ?? device);
    try {
      if (op === 'list') {
        const page = remote.listPage({
          deviceId: dev,
          space,
          limit: typeof payload.limit === 'number' ? payload.limit : 500,
          computeHash: payload.hash !== false,
          includeHidden: payload.include_hidden === true,
          cursor: typeof payload.cursor === 'string' ? payload.cursor : undefined,
        });
        return { entries: page.entries, next_cursor: page.next_cursor };
      }
      if (op === 'meta') return remote.meta(dev, space, path);
      if (op === 'read') {
        const read = remote.read(
          dev,
          space,
          path,
          typeof payload.offset === 'number' ? payload.offset : 0,
          typeof payload.length === 'number' ? payload.length : 64 * 1024,
        );
        return { data: read.data.toString('base64'), size: read.size, eof: read.eof };
      }
      return { _error: 'bad_op' };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'internal';
      return { _error: code, message: err instanceof Error ? err.message : String(err) };
    }
  };
}

describe('reconcilePeerBackup', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('pulls missing and changed shared files and keeps local-only files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const device = 'aaaaaaaaaaaaaaaa';
    const remote = new PeerLocalStore(join(dir, 'remote'));
    const master = new PeerLocalStore(join(dir, 'master'));
    seed(remote, device, 'files', 'new.txt', 'from-phone');
    seed(remote, device, 'files', 'same.txt', 'aaaa');
    seed(remote, device, 'files', 'changed.txt', 'bbbb');
    seed(remote, device, 'runtime', 'private.txt', 'secret');
    seed(master, device, 'files', 'same.txt', 'aaaa');
    seed(master, device, 'files', 'changed.txt', 'aaaa');
    seed(master, device, 'files', 'only-here.txt', 'keep');

    const seen = new Set<string>();
    const call: StoreCaller = async (op, payload) => {
      seen.add(String(payload.space));
      const limit = payload.space === 'files' ? 1 : payload.limit;
      return remoteCall(remote, device)(op, { ...payload, limit });
    };
    const stats = await reconcilePeerBackup({ store: master, deviceId: device, call });
    expect(stats.pulled).toBe(2);
    expect(seen.has('runtime')).toBe(false);
    expect(seen.has('files')).toBe(true);
    expect(master.read(device, 'files', 'new.txt').data.toString()).toBe('from-phone');
    expect(master.read(device, 'files', 'changed.txt').data.toString()).toBe('bbbb');
    expect(master.read(device, 'files', 'only-here.txt').data.toString()).toBe('keep');
    expect(() => master.read(device, 'runtime', 'private.txt')).toThrow();
  });

  it('does not resurrect a tombstoned file until the remote bytes change', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const device = 'aaaaaaaaaaaaaaaa';
    const remote = new PeerLocalStore(join(dir, 'remote'));
    const master = new PeerLocalStore(join(dir, 'master'));
    seed(remote, device, 'artifacts', 'note.txt', 'v1');
    seed(master, device, 'artifacts', 'note.txt', 'v1');
    master.delete(device, 'artifacts', 'note.txt');

    const first = await reconcilePeerBackup({
      store: master,
      deviceId: device,
      call: remoteCall(remote, device),
    });
    expect(first.pulled).toBe(0);
    expect(() => master.read(device, 'artifacts', 'note.txt')).toThrow();

    seed(remote, device, 'artifacts', 'note.txt', 'v2');
    const second = await reconcilePeerBackup({
      store: master,
      deviceId: device,
      call: remoteCall(remote, device),
    });
    expect(second.pulled).toBe(1);
    expect(master.read(device, 'artifacts', 'note.txt').data.toString()).toBe('v2');
    expect(master.tombstone(device, 'artifacts', 'note.txt')).toBeNull();
  });

  it('pulls a file when the peer returns the whole object on every read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const device = 'aaaaaaaaaaaaaaaa';
    const remote = new PeerLocalStore(join(dir, 'remote'));
    const master = new PeerLocalStore(join(dir, 'master'));
    const text = 'x'.repeat(70 * 1024);
    seed(remote, device, 'public', 'wide.txt', text);
    const inner = remoteCall(remote, device);
    const call: StoreCaller = async (op, payload) => {
      if (op !== 'read') return inner(op, payload);
      return { data: Buffer.from(text).toString('base64'), size: text.length, eof: true };
    };
    const stats = await reconcilePeerBackup({ store: master, deviceId: device, call });
    expect(stats.pulled).toBe(1);
    const meta = master.meta(device, 'public', 'wide.txt');
    expect(meta.size).toBe(text.length);
    expect(meta.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });
});
