import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('list prefix matches a path segment and pages past the first screen', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    for (const path of ['src/a.txt', 'src2/b.txt', 'src/c.txt']) {
      const content = Buffer.from(path);
      const sha = createHash('sha256').update(content).digest('hex');
      const begin = store.writeBegin({
        deviceId: device,
        space: 'files',
        path,
        size: content.length,
        sha256: sha,
      });
      store.writeChunk(device, begin.upload_id, 0, content);
      store.commit(device, 'files', [begin.upload_id]);
    }
    const prefixed = store.list(device, 'files', 'src');
    expect(prefixed.map((entry) => entry.path).sort()).toEqual(['src/a.txt', 'src/c.txt']);

    const first = store.listPage({ deviceId: device, space: 'files', limit: 1, computeHash: false });
    expect(first.entries).toHaveLength(1);
    expect(first.next_cursor).toBe(first.entries[0]!.path);
    const rest: string[] = [];
    let cursor = first.next_cursor ?? undefined;
    while (cursor) {
      const page = store.listPage({
        deviceId: device,
        space: 'files',
        limit: 1,
        computeHash: false,
        cursor,
      });
      rest.push(...page.entries.map((entry) => entry.path));
      cursor = page.next_cursor ?? undefined;
    }
    expect([first.entries[0]!.path, ...rest]).toEqual(['src/a.txt', 'src/c.txt', 'src2/b.txt']);
  });

  it('list keeps dotfiles only when includeHidden is set', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('hidden');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: '.keep',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content);
    store.commit(device, 'files', [begin.upload_id]);
    expect(store.list(device, 'files')).toHaveLength(0);
    const hidden = store.listPage({
      deviceId: device,
      space: 'files',
      includeHidden: true,
      computeHash: false,
    });
    expect(hidden.entries.map((entry) => entry.path)).toEqual(['.keep']);
  });

  it('list finishes when a directory symlink points at an ancestor', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const base = join(dir, device, 'files');
    mkdirSync(join(base, 'nested'), { recursive: true });
    writeFileSync(join(base, 'nested', 'a.txt'), 'a');
    symlinkSync(base, join(base, 'nested', 'loop'));
    const entries = store.list(device, 'files');
    expect(entries.map((entry) => entry.path)).toContain('nested/a.txt');
  });

  it('commit requires sha256 and size, and resumes a chunked upload', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const missing = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'no-hash.txt',
      size: 1,
      sha256: '',
    });
    store.writeChunk(device, missing.upload_id, 0, Buffer.from('x'));
    const rejected = store.commit(device, 'files', [missing.upload_id], 9);
    expect(rejected.failed).toEqual([{ upload_id: missing.upload_id, code: 'integrity_required' }]);
    expect(store.appliedSeq(device)).toBe(0);
    expect(existsSync(join(dir, device, 'files', 'no-hash.txt'))).toBe(false);

    const content = Buffer.from('abcdefgh');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'big.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content.subarray(0, 4));
    store.writeChunk(device, begin.upload_id, 4, content.subarray(4));
    expect(store.writeChunk(device, begin.upload_id, 0, content.subarray(0, 4)).received).toBe(8);
    expect(() => store.writeChunk(device, begin.upload_id, 100, Buffer.from('z'))).toThrow(
      expect.objectContaining({ code: 'resume', received: 8 }),
    );
    expect(
      store.writeBegin({
        deviceId: device,
        space: 'files',
        path: 'big.txt',
        size: content.length,
        sha256: sha,
        uploadId: begin.upload_id,
      }).received,
    ).toBe(8);
    const committed = store.commit(device, 'files', [begin.upload_id]);
    expect(committed.failed).toEqual([]);
    expect(store.read(device, 'files', 'big.txt').data.toString()).toBe('abcdefgh');
    const first = store.read(device, 'files', 'big.txt', 0, 3);
    expect(first).toMatchObject({ size: 8, eof: false });
    expect(first.data.toString()).toBe('abc');
    const rest = store.read(device, 'files', 'big.txt', 6, 10);
    expect(rest.data.toString()).toBe('gh');
    expect(rest.eof).toBe(true);
    const past = store.read(device, 'files', 'big.txt', 8, 4);
    expect(past.data.length).toBe(0);
    expect(past.eof).toBe(true);
  });

  it('gcStaging removes abandoned uploads and keeps a fresh one', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const stale = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'stale.txt',
      size: 1,
      sha256: 'abc',
    });
    const fresh = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'fresh.txt',
      size: 1,
      sha256: 'abc',
    });
    const staleMeta = join(dir, '.staging', device, stale.upload_id, 'meta.json');
    const old = new Date(Date.now() - 60_000);
    utimesSync(staleMeta, old, old);
    expect(store.gcStaging(1_000)).toBe(1);
    expect(existsSync(staleMeta)).toBe(false);
    expect(existsSync(join(dir, '.staging', device, fresh.upload_id, 'meta.json'))).toBe(true);
  });

  it('accepts a later chunk before the gap in front of it is filled', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('aaabbbccc');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'gap.txt',
      size: content.length,
      sha256: sha,
    });
    expect(store.writeChunk(device, begin.upload_id, 6, content.subarray(6)).received).toBe(0);
    expect(store.writeChunk(device, begin.upload_id, 3, content.subarray(3, 6)).received).toBe(0);
    expect(store.writeChunk(device, begin.upload_id, 0, content.subarray(0, 3)).received).toBe(9);
    expect(store.commit(device, 'files', [begin.upload_id]).failed).toEqual([]);
    expect(store.read(device, 'files', 'gap.txt').data.toString()).toBe('aaabbbccc');
  });

  it('resuming an upload refreshes it so a following sweep keeps it', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('abcdefgh');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'paused.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content.subarray(0, 3));
    const meta = join(dir, '.staging', device, begin.upload_id, 'meta.json');
    const old = new Date(Date.now() - 60_000);
    utimesSync(meta, old, old);
    expect(store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'paused.txt',
      size: content.length,
      sha256: sha,
    }).received).toBe(3);
    expect(store.gcStaging(1_000)).toBe(0);
    expect(existsSync(meta)).toBe(true);
  });

  it('delete records a tombstone and cursors are per device', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const other = 'bbbbbbbbbbbbbbbb';
    const content = Buffer.from('gone');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'gone.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content);
    store.commit(device, 'files', [begin.upload_id], 2);
    store.delete(device, 'files', 'gone.txt', 3);
    expect(existsSync(join(dir, device, 'files', 'gone.txt'))).toBe(false);
    expect(store.tombstone(device, 'files', 'gone.txt')).toEqual({ size: content.length, sha256: sha });
    const tombDir = join(dir, '.tombstones', device);
    expect(readdirSync(tombDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(existsSync(join(dir, '.tombstones', `${device}.json`))).toBe(false);
    expect(store.appliedSeq(device)).toBe(3);

    store.setAppliedSeq(other, 7);
    expect(store.appliedSeq(device)).toBe(3);
    expect(store.appliedSeq(other)).toBe(7);
    expect(existsSync(join(dir, '.cursors', `${device}.json`))).toBe(true);
    expect(existsSync(join(dir, '.cursors', `${other}.json`))).toBe(true);
  });

  it('delete of a directory tombstones each file and does not follow a symlink', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const write = (path: string, text: string) => {
      const content = Buffer.from(text);
      const sha = createHash('sha256').update(content).digest('hex');
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
    write('notes/keep.txt', 'keep');
    write('notes/node_modules/pkg/a.txt', 'skip');
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, device, 'files', 'notes', 'linked'));
    store.delete(device, 'files', 'notes');
    expect(store.tombstone(device, 'files', 'notes/keep.txt')?.sha256).toBe(
      createHash('sha256').update('keep').digest('hex'),
    );
    expect(store.tombstone(device, 'files', 'notes/node_modules/pkg/a.txt')).toBeNull();
    expect(store.tombstone(device, 'files', 'notes')).toBeNull();
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(dir, device, 'files', 'notes'))).toBe(false);
  });

  it('a corrupt cursor is not reported as synced through 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    mkdirSync(join(dir, '.cursors'), { recursive: true });
    writeFileSync(join(dir, '.cursors', `${device}.json`), '{', 'utf-8');
    expect(store.cursorState(device)).toEqual({ appliedSeq: 0, reliable: false });
    const resp = handleInboundStoreFrame(
      { type: 'store', ns: 'store', op: 'sync.hello', v: 1, req_id: 'h1', device },
      { peerId: 'peer-1', callerDeviceId: device, store },
    );
    expect(resp?.op).toBe('result');
    expect((resp as { data?: Record<string, unknown> }).data).toEqual({ reconcile: true });
  });

  it('reads a legacy shared cursor until the device cursor is rewritten', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    writeFileSync(join(dir, '.cursors.json'), JSON.stringify({ [device]: 4 }), 'utf-8');
    expect(store.cursorState(device)).toEqual({ appliedSeq: 4, reliable: true });
    store.setAppliedSeq(device, 5);
    expect(store.appliedSeq(device)).toBe(5);
    expect(store.cursorState(device).reliable).toBe(true);
  });

  it('backup inventory skips node_modules and symlinks that leave the space', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const write = (path: string, text: string) => {
      const content = Buffer.from(text);
      const sha = createHash('sha256').update(content).digest('hex');
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
    write('note.txt', 'keep');
    write('node_modules/pkg/a.txt', 'skip');
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(outside, join(dir, device, 'files', 'linked'));
    const backup = store.listPage({
      deviceId: device,
      space: 'files',
      includeHidden: true,
      forBackup: true,
      computeHash: false,
    });
    expect(backup.entries.map((entry) => entry.path)).toEqual(['note.txt']);
    const browse = store.list(device, 'files');
    expect(browse.some((entry) => entry.path.startsWith('node_modules/'))).toBe(true);
  });

  it('workspace backup skips build caches and keeps them in other spaces', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const write = (space: string, path: string) => {
      const content = Buffer.from(path);
      const sha = createHash('sha256').update(content).digest('hex');
      const begin = store.writeBegin({
        deviceId: device,
        space,
        path,
        size: content.length,
        sha256: sha,
      });
      store.writeChunk(device, begin.upload_id, 0, content);
      store.commit(device, space, [begin.upload_id]);
    };
    write('workspaces', 'src/app.ts');
    write('workspaces', 'dist/app.js');
    write('workspaces', '.venv/lib/python');
    write('files', 'dist/keep.txt');
    const workspace = store.listPage({
      deviceId: device,
      space: 'workspaces',
      includeHidden: true,
      forBackup: true,
      computeHash: false,
    });
    expect(workspace.entries.map((entry) => entry.path)).toEqual(['src/app.ts']);
    const files = store.listPage({
      deviceId: device,
      space: 'files',
      includeHidden: true,
      forBackup: true,
      computeHash: false,
    });
    expect(files.entries.map((entry) => entry.path)).toEqual(['dist/keep.txt']);
  });

  it('a legacy tombstone list is split, and one bad file does not drop the rest', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    mkdirSync(join(dir, '.tombstones'), { recursive: true });
    writeFileSync(
      join(dir, '.tombstones', `${device}.json`),
      JSON.stringify({
        entries: [
          { space: 'files', path: 'old.txt', size: 1, sha256: 'aa' },
          { space: 'files', path: 'also.txt', size: 2, sha256: 'bb' },
        ],
      }),
    );
    const content = Buffer.from('gone');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'gone.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content);
    store.commit(device, 'files', [begin.upload_id]);
    store.delete(device, 'files', 'gone.txt');
    expect(existsSync(join(dir, '.tombstones', `${device}.json`))).toBe(false);
    expect(store.tombstone(device, 'files', 'old.txt')).toEqual({ size: 1, sha256: 'aa' });
    expect(store.tombstone(device, 'files', 'also.txt')).toEqual({ size: 2, sha256: 'bb' });
    expect(store.tombstone(device, 'files', 'gone.txt')?.sha256).toBe(sha);
    const tombDir = join(dir, '.tombstones', device);
    const names = readdirSync(tombDir).filter((name) => name.endsWith('.json'));
    writeFileSync(join(tombDir, names[0]!), '{', 'utf-8');
    expect(store.listTombstones(device).length).toBe(2);
  });

  it('a peer that names a caller as master can be read, and clearing the claim keeps files', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const owner = 'bbbbbbbbbbbbbbbb';
    const caller = 'cccccccccccccccc';
    const content = Buffer.from('private');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: owner,
      space: 'runtime',
      path: 'secret.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(owner, begin.upload_id, 0, content);
    store.commit(owner, 'runtime', [begin.upload_id]);

    const denied = handleInboundStoreFrame(
      { type: 'store', ns: 'store', op: 'read', v: 1, req_id: 'p1', space: 'runtime', device: owner, path: 'secret.txt' },
      { peerId: 'peer-1', callerDeviceId: caller, store },
    );
    expect(denied?.op).toBe('error');

    const hello = handleInboundStoreFrame(
      { type: 'store', ns: 'store', op: 'sync.hello', v: 1, req_id: 'h2', master: caller },
      { peerId: 'peer-1', callerDeviceId: owner, store },
    );
    expect(hello?.op).toBe('result');
    expect(store.announcedMaster(owner)).toBe(caller);

    const allowed = handleInboundStoreFrame(
      { type: 'store', ns: 'store', op: 'read', v: 1, req_id: 'p2', space: 'runtime', device: owner, path: 'secret.txt' },
      { peerId: 'peer-1', callerDeviceId: caller, store },
    );
    expect(allowed?.op).toBe('result');

    handleInboundStoreFrame(
      { type: 'store', ns: 'store', op: 'sync.hello', v: 1, req_id: 'h3', master: '' },
      { peerId: 'peer-1', callerDeviceId: owner, store },
    );
    expect(store.announcedMaster(owner)).toBeNull();
    expect(store.read(owner, 'runtime', 'secret.txt').data.toString()).toBe('private');
  });

  it('writeBegin resumes an open upload for the same path', () => {
    dir = mkdtempSync(join(tmpdir(), 'peer-store-'));
    const store = new PeerLocalStore(dir);
    const device = 'aaaaaaaaaaaaaaaa';
    const content = Buffer.from('abcdef');
    const sha = createHash('sha256').update(content).digest('hex');
    const begin = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'resume.txt',
      size: content.length,
      sha256: sha,
    });
    store.writeChunk(device, begin.upload_id, 0, content.subarray(0, 3));
    const again = store.writeBegin({
      deviceId: device,
      space: 'files',
      path: 'resume.txt',
      size: content.length,
      sha256: sha,
    });
    expect(again.upload_id).toBe(begin.upload_id);
    expect(again.received).toBe(3);
  });
});
