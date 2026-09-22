import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import { PeerLocalStore } from '../src/peer/peer-local-store.js';
import {
  BACKUP_POLL_MS,
  nextBackupDelay,
  planPeerBackup,
  reconcilePeerBackup,
  replicateToRemote,
  shouldRetryBackup,
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
      if (op === 'write.begin') {
        return remote.writeBegin({
          deviceId: dev,
          space,
          path,
          size: typeof payload.size === 'number' ? payload.size : -1,
          sha256: typeof payload.sha256 === 'string' ? payload.sha256 : '',
          uploadId: typeof payload.upload_id === 'string' ? payload.upload_id : undefined,
        });
      }
      if (op === 'write.chunk') {
        return remote.writeChunk(
          dev,
          String(payload.upload_id ?? ''),
          typeof payload.offset === 'number' ? payload.offset : 0,
          Buffer.from(String(payload.data ?? ''), 'base64'),
        );
      }
      if (op === 'commit') {
        const ids = Array.isArray(payload.upload_ids) ? payload.upload_ids.map(String) : [];
        return remote.commit(dev, space, ids);
      }
      if (op === 'delete') {
        return remote.delete(dev, space, path);
      }
      return { _error: 'bad_op' };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'internal';
      return { _error: code, message: err instanceof Error ? err.message : String(err) };
    }
  };
}

describe('planPeerBackup', () => {
  const self = 'aaaaaaaaaaaaaaaa';
  const peer = 'bbbbbbbbbbbbbbbb';

  it('keeps the pouch here and does not pull a peer that has not named us', () => {
    expect(planPeerBackup({
      peerFingerprint: peer,
      announcedMaster: null,
      remoteMaster: null,
      selfId: self,
    })).toEqual({ announce: self, pull: false, push: false });
  });

  it('pushes to the device we named, and pulls a peer that named us', () => {
    expect(planPeerBackup({
      peerFingerprint: peer,
      announcedMaster: self,
      remoteMaster: peer,
      selfId: self,
    })).toEqual({ announce: peer, pull: true, push: true });
  });

  it('stops pulling after the peer clears the claim, and does not push to anyone else', () => {
    expect(planPeerBackup({
      peerFingerprint: peer,
      announcedMaster: 'cccccccccccccccc',
      remoteMaster: 'dddddddddddddddd',
      selfId: self,
    })).toEqual({ announce: 'dddddddddddddddd', pull: false, push: false });
  });
});

describe('shouldRetryBackup', () => {
  const done = { pulled: 1, skipped: 0, incomplete: 0, complete: true };
  const dropped = { pulled: 0, skipped: 0, incomplete: 2, complete: true };
  const shortPage = { pulled: 0, skipped: 0, incomplete: 0, complete: false };

  it('retries dropped files, and a short listing only once', () => {
    expect(shouldRetryBackup([done], 0)).toBe(false);
    expect(shouldRetryBackup([dropped], 0)).toBe(true);
    expect(shouldRetryBackup([dropped], 2)).toBe(true);
    expect(shouldRetryBackup([dropped], 3)).toBe(false);
    expect(shouldRetryBackup([shortPage], 0)).toBe(true);
    expect(shouldRetryBackup([shortPage], 1)).toBe(false);
  });

  it('keeps looking while the peer is still connected', () => {
    expect(nextBackupDelay([done], 0, true)).toBe(BACKUP_POLL_MS);
    expect(nextBackupDelay([done], 0, false)).toBeNull();
    expect(nextBackupDelay([dropped], 0, true)).toBe(5_000);
    expect(nextBackupDelay([shortPage], 1, true)).toBe(BACKUP_POLL_MS);
  });
});

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
    expect(stats.pulled).toBe(3);
    expect(stats.complete).toBe(true);
    expect(seen.has('runtime')).toBe(true);
    expect(seen.has('files')).toBe(true);
    expect(master.read(device, 'files', 'new.txt').data.toString()).toBe('from-phone');
    expect(master.read(device, 'files', 'changed.txt').data.toString()).toBe('bbbb');
    expect(master.read(device, 'files', 'only-here.txt').data.toString()).toBe('keep');
    expect(master.read(device, 'runtime', 'private.txt').data.toString()).toBe('secret');
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

  it('retries a read that fails once and still stores the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const device = 'aaaaaaaaaaaaaaaa';
    const remote = new PeerLocalStore(join(dir, 'remote'));
    const master = new PeerLocalStore(join(dir, 'master'));
    seed(remote, device, 'files', 'note.txt', 'hello');
    const inner = remoteCall(remote, device);
    let reads = 0;
    const call: StoreCaller = async (op, payload) => {
      if (op === 'read') {
        reads += 1;
        if (reads === 1) return { _error: 'master_offline' };
      }
      return inner(op, payload);
    };
    const stats = await reconcilePeerBackup({
      store: master,
      deviceId: device,
      call,
      spaces: ['files'],
    });
    expect(stats.incomplete).toBe(0);
    expect(stats.pulled).toBe(1);
    expect(master.read(device, 'files', 'note.txt').data.toString()).toBe('hello');
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

  it('does not treat a full page without a cursor as finished', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const master = new PeerLocalStore(join(dir, 'master'));
    const call: StoreCaller = async (op, payload) => {
      if (op === 'list') {
        const limit = typeof payload.limit === 'number' ? payload.limit : 500;
        return {
          entries: Array.from({ length: limit }, (_, i) => ({
            path: `f/${i}.txt`,
            kind: 'file',
            size: 1,
          })),
          next_cursor: null,
        };
      }
      return { _error: 'not_found' };
    };
    const stats = await reconcilePeerBackup({
      store: master,
      deviceId: 'aaaaaaaaaaaaaaaa',
      call,
      spaces: ['files'],
    });
    expect(stats.complete).toBe(false);
  });

  it('pushes this device pouch, including a private space, onto the remote master', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const device = 'aaaaaaaaaaaaaaaa';
    const local = new PeerLocalStore(join(dir, 'local'));
    const remote = new PeerLocalStore(join(dir, 'remote'));
    seed(local, device, 'runtime', 'secret.txt', 'keep-me');
    seed(local, device, 'files', 'node_modules/pkg/a.txt', 'skip');
    seed(local, device, 'files', 'note.txt', 'send');
    const stats = await replicateToRemote({
      store: local,
      deviceId: device,
      call: remoteCall(remote, device),
      spaces: ['runtime', 'files'],
    });
    expect(stats.pulled).toBe(2);
    expect(remote.read(device, 'runtime', 'secret.txt').data.toString()).toBe('keep-me');
    expect(remote.read(device, 'files', 'note.txt').data.toString()).toBe('send');
    expect(() => remote.read(device, 'files', 'node_modules/pkg/a.txt')).toThrow();
  });

  it('removes a directory of files from the remote master after a local delete', async () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-backup-'));
    const device = 'aaaaaaaaaaaaaaaa';
    const local = new PeerLocalStore(join(dir, 'local'));
    const remote = new PeerLocalStore(join(dir, 'remote'));
    seed(local, device, 'files', 'notes/keep.txt', 'gone');
    seed(remote, device, 'files', 'notes/keep.txt', 'gone');
    local.delete(device, 'files', 'notes');
    await replicateToRemote({
      store: local,
      deviceId: device,
      call: remoteCall(remote, device),
      spaces: ['files'],
    });
    expect(() => remote.read(device, 'files', 'notes/keep.txt')).toThrow();
  });
});
