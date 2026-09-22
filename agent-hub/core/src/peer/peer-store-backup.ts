/**
 * Master-side backup: when a paired device is online, copy its shared spaces
 * onto this hub. Private spaces stay push-only. A missing remote path is not
 * a delete — only an explicit delete frame removes a local copy.
 */

import {
  getPeerLocalStore,
  MAX_CHUNK,
  SHARED_SPACES,
  type PeerLocalStore,
} from './peer-local-store.js';
import { callStoreOnPeerId } from './peer-store-protocol.js';

export type StoreCaller = (
  op: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ReconcileStats {
  pulled: number;
  skipped: number;
  incomplete: number;
}

const inFlight = new Map<string, Promise<ReconcileStats>>();

function emptyStats(): ReconcileStats {
  return { pulled: 0, skipped: 0, incomplete: 0 };
}

/** Pull shared spaces for one paired device. Concurrent calls share one run. */
export function startPeerBackup(peerId: string, deviceId: string): Promise<ReconcileStats> {
  const id = deviceId.trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(id)) return Promise.resolve(emptyStats());
  const existing = inFlight.get(id);
  if (existing) return existing;
  const job = reconcilePeerBackup({
    store: getPeerLocalStore(),
    deviceId: id,
    call: (op, payload) => callStoreOnPeerId(peerId, op, payload),
  }).finally(() => {
    inFlight.delete(id);
  });
  inFlight.set(id, job);
  return job;
}

export async function reconcilePeerBackup(opts: {
  store: PeerLocalStore;
  deviceId: string;
  call: StoreCaller;
}): Promise<ReconcileStats> {
  const stats = emptyStats();
  const deviceId = opts.deviceId.trim().toLowerCase();
  opts.store.gcStaging();
  for (const space of SHARED_SPACES) {
    await reconcileSpace(opts.store, deviceId, space, opts.call, stats);
  }
  return stats;
}

async function reconcileSpace(
  store: PeerLocalStore,
  deviceId: string,
  space: string,
  call: StoreCaller,
  stats: ReconcileStats,
): Promise<void> {
  const local = await localSizes(store, deviceId, space);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20_000; page++) {
    if (cursor) {
      if (seenCursors.has(cursor)) return;
      seenCursors.add(cursor);
    }
    const listed = await call('list', {
      space,
      device: deviceId,
      hash: false,
      include_hidden: true,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    if (listed._error) return;
    const entries = Array.isArray(listed.entries) ? listed.entries : [];
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as { path?: unknown; size?: unknown; sha256?: unknown; kind?: unknown };
      if (entry.kind === 'dir') continue;
      if (typeof entry.path !== 'string' || !entry.path) continue;
      try {
        const pulled = await reconcileFile(store, deviceId, space, entry, local, call);
        if (pulled === 'pulled') stats.pulled += 1;
        else if (pulled === 'skipped') stats.skipped += 1;
        else stats.incomplete += 1;
      } catch {
        stats.incomplete += 1;
      }
    }
    const next = listed.next_cursor;
    if (typeof next !== 'string' || !next) return;
    cursor = next;
  }
}

async function localSizes(
  store: PeerLocalStore,
  deviceId: string,
  space: string,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20_000; page++) {
    const listed = store.listPage({
      deviceId,
      space,
      limit: 500,
      computeHash: false,
      includeHidden: true,
      cursor,
    });
    for (const entry of listed.entries) {
      if (entry.kind === 'dir') continue;
      sizes.set(entry.path, entry.size);
    }
    if (!listed.next_cursor || seen.has(listed.next_cursor)) break;
    seen.add(listed.next_cursor);
    cursor = listed.next_cursor;
  }
  return sizes;
}

async function reconcileFile(
  store: PeerLocalStore,
  deviceId: string,
  space: string,
  entry: { path?: unknown; size?: unknown; sha256?: unknown },
  local: Map<string, number>,
  call: StoreCaller,
): Promise<'pulled' | 'skipped' | 'incomplete'> {
  const path = String(entry.path);
  const described = await describeRemote(space, deviceId, path, entry, call);
  if (!described) return 'incomplete';
  const tomb = store.tombstone(deviceId, space, path);
  if (tomb && tomb.sha256 === described.sha256 && tomb.size === described.size) {
    return 'skipped';
  }
  const localSize = local.get(path);
  if (localSize !== undefined && localSize === described.size) {
    try {
      const meta = store.meta(deviceId, space, path);
      if (meta.sha256 === described.sha256) return 'skipped';
    } catch {
      /* local file disappeared; pull it */
    }
  }
  await pullFile(store, deviceId, space, path, described, call);
  local.set(path, described.size);
  return 'pulled';
}

async function describeRemote(
  space: string,
  deviceId: string,
  path: string,
  entry: { size?: unknown; sha256?: unknown },
  call: StoreCaller,
): Promise<{ size: number; sha256: string } | null> {
  const listedSha = typeof entry.sha256 === 'string' ? entry.sha256 : '';
  const listedSize = typeof entry.size === 'number' ? entry.size : -1;
  if (listedSha && listedSize >= 0) return { size: listedSize, sha256: listedSha };
  const meta = await call('meta', { space, device: deviceId, path });
  if (meta._error) return null;
  const sha256 = typeof meta.sha256 === 'string' ? meta.sha256 : '';
  const size = typeof meta.size === 'number' ? meta.size : -1;
  if (!sha256 || size < 0) return null;
  return { size, sha256 };
}

async function pullFile(
  store: PeerLocalStore,
  deviceId: string,
  space: string,
  path: string,
  described: { size: number; sha256: string },
  call: StoreCaller,
): Promise<void> {
  const begin = store.writeBegin({
    deviceId,
    space,
    path,
    size: described.size,
    sha256: described.sha256,
  });
  let offset = 0;
  const maxSteps = Math.ceil(described.size / MAX_CHUNK) + 2;
  for (let step = 0; step < maxSteps && offset < described.size; step++) {
    const part = await call('read', {
      space,
      device: deviceId,
      path,
      offset,
      length: MAX_CHUNK,
    });
    if (part._error) {
      throw Object.assign(new Error(String(part._error)), { code: String(part._error) });
    }
    const buf = Buffer.from(String(part.data ?? ''), 'base64');
    if (buf.length === 0) {
      throw Object.assign(new Error('short_read'), { code: 'short_read' });
    }
    const requested = Math.min(MAX_CHUNK, described.size - offset);
    // A peer that ignores offset returns the whole object. Slice that at the
    // requested window; a longer honoured window is just its leading bytes.
    const chunk =
      offset > 0 && buf.length > requested && buf.length >= described.size
        ? buf.subarray(offset, Math.min(buf.length, offset + requested))
        : buf.subarray(0, Math.min(buf.length, requested));
    if (chunk.length === 0) {
      throw Object.assign(new Error('short_read'), { code: 'short_read' });
    }
    store.writeChunk(deviceId, begin.upload_id, offset, chunk);
    offset += chunk.length;
    if (part.eof === true && offset >= described.size) break;
  }
  if (offset !== described.size) {
    throw Object.assign(new Error('short_read'), { code: 'short_read' });
  }
  const committed = store.commit(deviceId, space, [begin.upload_id]);
  if (committed.failed.length > 0) {
    throw Object.assign(new Error('commit_failed'), { code: 'commit_failed' });
  }
}
