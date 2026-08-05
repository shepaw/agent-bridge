import { mkdtempSync, rmSync } from 'node:fs';
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
});
