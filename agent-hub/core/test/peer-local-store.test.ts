import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import { PeerLocalStore } from '../src/peer/peer-local-store.js';
import { handleInboundStoreFrame } from '../src/peer/peer-store-protocol.js';

describe('PeerLocalStore', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('write → list → read roundtrip', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('hello pouch');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'notes/a.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content);
    const committed = store.commit(device, 'files', [begin.upload_id], 1);
    expect(committed.failed).toEqual([]);
    expect(committed.applied_seq).toBe(1);

    const entries = store.list(device, 'files');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('notes/a.txt');

    const { data, eof } = store.read(device, 'files', 'notes/a.txt');
    expect(data.toString('utf-8')).toBe('hello pouch');
    expect(eof).toBe(true);
    expect(store.appliedSeq(device)).toBe(1);
  });

  it('inbound list/read ACL allows shared cross-device', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const owner = 'bbbbbbbbbbbbbbbb';
    const caller = 'cccccccccccccccc';
    const content = Buffer.from('shared');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: owner,
      space: 'artifacts',
      path: 'out.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(owner, begin.upload_id, 0, content);
    store.commit(owner, 'artifacts', [begin.upload_id]);

    const listResp = handleInboundStoreFrame(
      {
        type: 'store',
        ns: 'store',
        op: 'list',
        v: 1,
        req_id: 'r1',
        space: 'artifacts',
        device: owner,
      },
      { peerId: 'peer-1', callerDeviceId: caller, store },
    );
    expect(listResp?.op).toBe('result');
    const entries = (listResp as { data?: { entries?: unknown[] } }).data?.entries;
    expect(entries).toHaveLength(1);
  });

  it('inbound rejects private cross-device read', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const owner = 'bbbbbbbbbbbbbbbb';
    const caller = 'cccccccccccccccc';
    const resp = handleInboundStoreFrame(
      {
        type: 'store',
        ns: 'store',
        op: 'list',
        v: 1,
        req_id: 'r2',
        space: 'attachments',
        device: owner,
      },
      { peerId: 'peer-1', callerDeviceId: caller, store },
    );
    expect(resp?.op).toBe('error');
    expect((resp as { code?: string }).code).toBe('acl_denied');
  });

  it('list with depth=1 returns agent dirs for layer-by-layer browse', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'dddddddddddddddd';
    const agentA = '11111111-1111-1111-1111-111111111111';
    const agentB = '22222222-2222-2222-2222-222222222222';
    // Seed agents/<uuid>/note.txt under each agent folder.
    for (const agent of [agentA, agentB]) {
      const content = Buffer.from(`hi ${agent}`);
      const sha = createHash('sha256').update(content).digest('hex');
      const begin = store.writeBegin({
        deviceId: device,
        space: 'agents',
        path: `${agent}/note.txt`,
        size: content.length,
        sha256: sha,
      });
      store.writeChunk(device, begin.upload_id, 0, content);
      store.commit(device, 'agents', [begin.upload_id]);
    }

    const root = store.list(device, 'agents', undefined, 1000, 1);
    expect(root).toHaveLength(2);
    expect(root.every((e) => e.kind === 'dir')).toBe(true);
    expect(root.map((e) => e.path).sort()).toEqual([agentA, agentB].sort());

    const one = store.list(device, 'agents', agentA, 1000, 1);
    expect(one).toHaveLength(1);
    expect(one[0]!.kind).toBe('file');
    expect(one[0]!.path).toBe(`${agentA}/note.txt`);
  });

  it('meta reports directories (including symlink targets) as kind=dir', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'ffffffffffffffff';
    mkdirSync(join(dir, device, 'workspaces', 'Users', 'foo'), { recursive: true });
    const meta = store.meta(device, 'workspaces', 'Users/foo');
    expect(meta.kind).toBe('dir');
  });

  it('list skips hashing when computeHash is false', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = '0123456789abcdef';
    const content = Buffer.from('skip-hash');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'a.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content);
    store.commit(device, 'files', [begin.upload_id]);
    const hashed = store.list(device, 'files', undefined, 1000, 1, true);
    expect(hashed[0]!.sha256).toBe(sha);
    const skipped = store.list(device, 'files', undefined, 1000, 1, false);
    expect(skipped[0]!.sha256).toBe('');
  });

  it('list depth via inbound frame', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'eeeeeeeeeeeeeeee';
    mkdirSync(join(dir, device, 'agents', 'agent-x'), { recursive: true });
    const resp = handleInboundStoreFrame(
      {
        type: 'store',
        ns: 'store',
        op: 'list',
        v: 1,
        req_id: 'r3',
        space: 'agents',
        device,
        depth: 1,
      },
      { peerId: 'peer-1', callerDeviceId: device, store },
    );
    expect(resp?.op).toBe('result');
    const entries = (resp as { data?: { entries?: Array<{ path: string; kind?: string }> } })
      .data?.entries;
    expect(entries).toEqual([
      expect.objectContaining({ path: 'agent-x', kind: 'dir' }),
    ]);
  });

  it('copy then move a file', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('payload');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'a.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content);
    store.commit(device, 'files', [begin.upload_id]);

    store.copy(
      { deviceId: device, space: 'files', path: 'a.txt' },
      { deviceId: device, space: 'files', path: 'b.txt' },
    );
    expect(store.read(device, 'files', 'b.txt').data.toString()).toBe('payload');

    store.move(
      { deviceId: device, space: 'files', path: 'b.txt' },
      { deviceId: device, space: 'artifacts', path: 'c.txt' },
    );
    expect(() => store.read(device, 'files', 'b.txt')).toThrow();
    expect(store.read(device, 'files', 'a.txt').data.toString()).toBe('payload');
    expect(store.read(device, 'artifacts', 'c.txt').data.toString()).toBe('payload');
  });

  it('copy refuses existing destination', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('x');
    const sha = createHash('sha256').update(content).digest('hex');
    const write = (path: string) => {
      const begin = store.writeBegin({
        deviceId: device,
        space: 'files',
        path,
        size: content.length,
        sha256: sha,
      });
      store.writeChunk(device, begin.upload_id, 0, content);
      store.commit(device, 'files', [begin.upload_id]);
    };
    write('a.txt');
    write('b.txt');
    expect(() =>
      store.copy(
        { deviceId: device, space: 'files', path: 'a.txt' },
        { deviceId: device, space: 'files', path: 'b.txt' },
      ),
    ).toThrow(/exists/);
  });

  it('listBackupDevices enumerates mirrors, excluding self and non-device entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const self = 'deadbeefdeadbeef';
    const devA = 'aaaaaaaaaaaaaaaa';
    const devB = 'bbbbbbbbbbbbbbbb';
    const write = (device: string, space: string, path: string, text: string) => {
      const content = Buffer.from(text);
      const sha = createHash('sha256').update(content).digest('hex');
      const begin = store.writeBegin({ deviceId: device, space, path, size: content.length, sha256: sha });
      store.writeChunk(device, begin.upload_id, 0, content);
      store.commit(device, space, [begin.upload_id], 1);
    };

    write(self, 'files', 'self.txt', 'self'); // own device — must be excluded
    write(devA, 'files', 'a.txt', 'hello');
    write(devA, 'artifacts', 'note.md', 'world');
    write(devB, 'files', 'b.txt', 'backup');
    mkdirSync(join(dir, '.staging'), { recursive: true }); // not a device dir

    const devices = store.listBackupDevices(self);
    expect(devices.map((d) => d.fingerprint).sort()).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);

    const a = devices.find((d) => d.fingerprint === devA)!;
    expect(a.spaces.map((s) => s.space).sort()).toEqual(['artifacts', 'files']);
    expect(a.totalFiles).toBe(2);
    expect(a.totalBytes).toBe('hello'.length + 'world'.length);
    expect(a.lastSyncSeq).toBe(1);

    const b = devices.find((d) => d.fingerprint === devB)!;
    expect(b.totalFiles).toBe(1);
    expect(b.totalBytes).toBe('backup'.length);
  });

  it('removeBackupDevice deletes the mirror and clears the sync cursor', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const self = 'deadbeefdeadbeef';
    const dev = 'cccccccccccccccc';
    const content = Buffer.from('data');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({ deviceId: dev, space: 'files', path: 'x.txt', size: content.length, sha256: sha });
    store.writeChunk(dev, begin.upload_id, 0, content);
    store.commit(dev, 'files', [begin.upload_id], 5);
    expect(store.appliedSeq(dev)).toBe(5);

    store.removeBackupDevice(dev, self);
    expect(existsSync(join(dir, dev))).toBe(false);
    expect(store.appliedSeq(dev)).toBe(0);
    expect(store.listBackupDevices(self)).toHaveLength(0);
  });

  it('removeBackupDevice refuses self and invalid fingerprints', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const self = 'deadbeefdeadbeef';
    expect(() => store.removeBackupDevice(self, self)).toThrow();
    expect(() => store.removeBackupDevice('../../etc', self)).toThrow();
    expect(() => store.removeBackupDevice('nothex!!', self)).toThrow();
  });
});
