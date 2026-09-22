/**
 * Pouch backup in two directions:
 * - A peer that names this hub as master: pull their whole pouch into
 *   `<root>/<their device>/`. Clearing the claim stops the pull; files stay.
 * - This hub names another device as master: push this hub's pouch there.
 *   When this hub is its own master, nothing is pushed.
 *
 * A missing remote path is not a delete. Only an explicit delete (or a
 * tombstone we ourselves recorded) removes a copy.
 */

import { loadPairedPeers } from './peer-store.js';
import {
  ALL_SPACES,
  getPeerLocalStore,
  MAX_CHUNK,
  type PeerLocalStore,
} from './peer-local-store.js';
import { peerHasLiveConnection } from './peer-connection.js';
import { callStoreOnPeerId } from './peer-store-protocol.js';
import {
  configuredRemoteMaster,
  selfStoreDeviceId,
} from './peer-master.js';

export type StoreCaller = (
  op: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ReconcileStats {
  pulled: number;
  skipped: number;
  incomplete: number;
  /** False when a page came back full and without next_cursor. */
  complete: boolean;
}

const BACKUP_PAGE = 500;
const BACKUP_RETRY_LIMIT = 3;
const BACKUP_RETRY_BASE_MS = 5_000;
const inFlight = new Map<string, Promise<ReconcileStats>>();
const pushTail = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emptyStats(): ReconcileStats {
  return { pulled: 0, skipped: 0, incomplete: 0, complete: true };
}

export function backupPathExcluded(path: string): boolean {
  return path.split('/').some((part) => part === 'node_modules' || part === '.git');
}

/** Pull a peer's pouch. Concurrent calls for the same device share one run. */
export function startPeerBackup(peerId: string, deviceId: string): Promise<ReconcileStats> {
  const id = deviceId.trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(id)) return Promise.resolve(emptyStats());
  const existing = inFlight.get(`pull:${id}`);
  if (existing) return existing;
  const job = reconcilePeerBackup({
    store: getPeerLocalStore(),
    deviceId: id,
    call: (op, payload) => callStoreOnPeerId(peerId, op, payload),
  }).finally(() => {
    inFlight.delete(`pull:${id}`);
  });
  inFlight.set(`pull:${id}`, job);
  return job;
}

export interface PeerBackupPlan {
  /** Fingerprint to send in sync.hello, or empty when this hub has no identity yet. */
  announce: string;
  /** This peer already named us master, so copy their pouch in. */
  pull: boolean;
  /** We named this peer master, so copy our pouch out. */
  push: boolean;
}

/**
 * What to do with one paired device.
 * `announce` is our master (ourselves, when we keep the pouch here) so the
 * peer can start or stop pulling. Pull and push are independent.
 */
export function planPeerBackup(opts: {
  peerFingerprint: string;
  announcedMaster: string | null;
  remoteMaster: string | null;
  selfId: string;
}): PeerBackupPlan {
  const peer = opts.peerFingerprint.trim().toLowerCase();
  const selfId = opts.selfId.trim().toLowerCase();
  const remote = opts.remoteMaster?.trim().toLowerCase() || null;
  const announced = opts.announcedMaster?.trim().toLowerCase() || null;
  return {
    announce: remote && remote !== selfId ? remote : selfId,
    pull: announced !== null && announced === selfId,
    push: remote !== null && remote === peer,
  };
}

function selfIdOrEmpty(): string {
  try {
    return selfStoreDeviceId();
  } catch {
    return '';
  }
}

function announceMaster(peerId: string, master: string): Promise<void> {
  if (!/^[a-f0-9]{16}$/.test(master)) return Promise.resolve();
  return callStoreOnPeerId(peerId, 'sync.hello', { master }).then(() => undefined);
}

/**
 * Retry a run that dropped files or stopped on a list error.
 * A peer that never pages is tried only once more; repeated file failures
 * stop after {@link BACKUP_RETRY_LIMIT}.
 */
export function shouldRetryBackup(stats: readonly ReconcileStats[], attempt: number): boolean {
  if (attempt >= BACKUP_RETRY_LIMIT) return false;
  const failedFiles = stats.some((item) => item.incomplete > 0);
  if (failedFiles) return true;
  return stats.some((item) => !item.complete) && attempt === 0;
}

/** Drop a pending retry. Safe when this peer still has another live connection. */
export function cancelPeerBackupRetries(peerId: string): void {
  const timer = retryTimers.get(peerId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(peerId);
}

function enqueuePush<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
  const prev = pushTail.get(deviceId) ?? Promise.resolve();
  const run = prev.then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  pushTail.set(deviceId, settled);
  void settled.finally(() => {
    if (pushTail.get(deviceId) === settled) pushTail.delete(deviceId);
  });
  return run;
}

/**
 * On connect: tell the peer who our master is, pull if they named us,
 * and push if we named them. The caller must already be able to send.
 * A run that did not finish is tried again while this peer stays connected.
 */
export function onPeerConnectedForBackup(peerId: string, fingerprint: string): Promise<void> {
  return runPeerBackup(peerId, fingerprint, 0);
}

async function runPeerBackup(peerId: string, fingerprint: string, attempt: number): Promise<void> {
  const id = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(id)) return;
  if (attempt > 0 && !peerHasLiveConnection(peerId)) return;
  if (attempt === 0) cancelPeerBackupRetries(peerId);
  const selfId = selfIdOrEmpty();
  const plan = planPeerBackup({
    peerFingerprint: id,
    announcedMaster: getPeerLocalStore().announcedMaster(id),
    remoteMaster: configuredRemoteMaster(),
    selfId,
  });
  const stats: ReconcileStats[] = [];
  const tasks: Promise<unknown>[] = [];
  if (attempt === 0) {
    tasks.push(announceMaster(peerId, plan.announce).catch(() => undefined));
  }
  if (plan.pull) {
    tasks.push(startPeerBackup(peerId, id).then((item) => {
      stats.push(item);
    }));
  }
  if (plan.push) {
    tasks.push(pushLocalPouch(peerId).then((item) => {
      stats.push(item);
    }));
  }
  await Promise.all(tasks);
  if (!shouldRetryBackup(stats, attempt) || !peerHasLiveConnection(peerId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(peerId);
    if (!peerHasLiveConnection(peerId)) return;
    void runPeerBackup(peerId, id, attempt + 1).catch(() => undefined);
  }, BACKUP_RETRY_BASE_MS * (attempt + 1));
  timer.unref();
  retryTimers.set(peerId, timer);
}

/**
 * Master setting changed while peers may already be connected.
 * Each live peer hears the new claim; the chosen master gets the pouch now.
 */
export function syncMasterChoiceToLivePeers(): void {
  const selfId = selfIdOrEmpty();
  const remote = configuredRemoteMaster();
  for (const peer of loadPairedPeers()) {
    if (!peerHasLiveConnection(peer.id)) continue;
    const plan = planPeerBackup({
      peerFingerprint: peer.fingerprint,
      announcedMaster: null,
      remoteMaster: remote,
      selfId,
    });
    void announceMaster(peer.id, plan.announce).catch(() => undefined);
    if (plan.push) void pushLocalPouch(peer.id).catch(() => undefined);
  }
}

/** Push this hub's pouch to the paired device that is our master. */
export function pushLocalPouch(peerId: string): Promise<ReconcileStats> {
  let self = '';
  try {
    self = selfStoreDeviceId();
  } catch {
    return Promise.resolve(emptyStats());
  }
  const existing = inFlight.get(`push:${self}`);
  if (existing) return existing;
  const job = enqueuePush(self, () => replicateToRemote({
    store: getPeerLocalStore(),
    deviceId: self,
    call: (op, payload) => callStoreOnPeerId(peerId, op, payload),
  })).finally(() => {
    inFlight.delete(`push:${self}`);
  });
  inFlight.set(`push:${self}`, job);
  return job;
}

/** After a local commit or delete, send that one path to the remote master. */
export function scheduleMirrorLocalChange(
  deviceId: string,
  space: string,
  path: string,
  deleted: boolean,
): void {
  const master = configuredRemoteMaster();
  if (!master || deviceId.trim().toLowerCase() !== selfStoreDeviceId()) return;
  if (backupPathExcluded(path)) return;
  const peer = loadPairedPeers().find((item) => item.fingerprint.toLowerCase() === master);
  if (!peer || !peerHasLiveConnection(peer.id)) return;
  void pushOnePath(peer.id, space, path, deleted).catch(() => undefined);
}

export async function reconcilePeerBackup(opts: {
  store: PeerLocalStore;
  deviceId: string;
  call: StoreCaller;
  spaces?: Iterable<string>;
}): Promise<ReconcileStats> {
  const stats = emptyStats();
  const deviceId = opts.deviceId.trim().toLowerCase();
  opts.store.gcStaging();
  const spaces = opts.spaces ?? ALL_SPACES;
  for (const space of spaces) {
    await reconcileSpace(opts.store, deviceId, space, opts.call, stats);
  }
  return stats;
}

export async function replicateToRemote(opts: {
  store: PeerLocalStore;
  deviceId: string;
  call: StoreCaller;
  spaces?: Iterable<string>;
}): Promise<ReconcileStats> {
  const stats = emptyStats();
  const deviceId = opts.deviceId.trim().toLowerCase();
  const spaces = opts.spaces ?? ALL_SPACES;
  for (const space of spaces) {
    await pushSpace(opts.store, deviceId, space, opts.call, stats);
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
      if (seenCursors.has(cursor)) {
        stats.complete = false;
        return;
      }
      seenCursors.add(cursor);
    }
    const listed = await call('list', {
      space,
      device: deviceId,
      hash: false,
      include_hidden: true,
      backup: true,
      limit: BACKUP_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    if (listed._error) {
      stats.complete = false;
      return;
    }
    const entries = Array.isArray(listed.entries) ? listed.entries : [];
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as { path?: unknown; size?: unknown; sha256?: unknown; kind?: unknown };
      if (entry.kind === 'dir') continue;
      if (typeof entry.path !== 'string' || !entry.path || backupPathExcluded(entry.path)) continue;
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
    if (typeof next !== 'string' || !next) {
      if (entries.length >= BACKUP_PAGE) stats.complete = false;
      return;
    }
    cursor = next;
  }
  stats.complete = false;
}

async function pushSpace(
  store: PeerLocalStore,
  deviceId: string,
  space: string,
  call: StoreCaller,
  stats: ReconcileStats,
): Promise<void> {
  const remote = new Map<string, number>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20_000; page++) {
    if (cursor) {
      if (seenCursors.has(cursor)) {
        stats.complete = false;
        break;
      }
      seenCursors.add(cursor);
    }
    const listed = await call('list', {
      space,
      device: deviceId,
      hash: false,
      include_hidden: true,
      backup: true,
      limit: BACKUP_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    if (listed._error) {
      stats.complete = false;
      break;
    }
    const entries = Array.isArray(listed.entries) ? listed.entries : [];
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as { path?: unknown; size?: unknown; kind?: unknown };
      if (entry.kind === 'dir' || typeof entry.path !== 'string') continue;
      if (backupPathExcluded(entry.path)) continue;
      remote.set(entry.path, typeof entry.size === 'number' ? entry.size : -1);
    }
    const next = listed.next_cursor;
    if (typeof next !== 'string' || !next) {
      if (entries.length >= BACKUP_PAGE) stats.complete = false;
      break;
    }
    cursor = next;
  }

  let localCursor: string | undefined;
  const seenLocal = new Set<string>();
  for (let page = 0; page < 20_000; page++) {
    const listed = store.listPage({
      deviceId,
      space,
      limit: BACKUP_PAGE,
      computeHash: false,
      includeHidden: true,
      forBackup: true,
      cursor: localCursor,
    });
    for (const entry of listed.entries) {
      if (entry.kind === 'dir' || backupPathExcluded(entry.path)) continue;
      try {
        const remoteSize = remote.get(entry.path);
        if (remoteSize === entry.size) {
          const localMeta = store.meta(deviceId, space, entry.path);
          const remoteMeta = await call('meta', { space, device: deviceId, path: entry.path });
          if (!remoteMeta._error && remoteMeta.sha256 === localMeta.sha256) {
            stats.skipped += 1;
            continue;
          }
        }
        await pushFile(store, deviceId, space, entry.path, call);
        stats.pulled += 1;
      } catch {
        stats.incomplete += 1;
      }
    }
    if (!listed.next_cursor || seenLocal.has(listed.next_cursor)) break;
    seenLocal.add(listed.next_cursor);
    localCursor = listed.next_cursor;
  }

  for (const tomb of store.listTombstones(deviceId)) {
    if (tomb.space !== space || backupPathExcluded(tomb.path)) continue;
    if (!remote.has(tomb.path)) continue;
    const meta = await call('meta', { space, device: deviceId, path: tomb.path });
    if (meta._error || meta.sha256 !== tomb.sha256 || meta.size !== tomb.size) continue;
    const deleted = await call('delete', { space, device: deviceId, path: tomb.path });
    if (deleted._error) stats.incomplete += 1;
  }
}

function pushOnePath(peerId: string, space: string, path: string, deleted: boolean): Promise<void> {
  const deviceId = selfStoreDeviceId();
  return enqueuePush(deviceId, () => pushOnePathNow(peerId, deviceId, space, path, deleted));
}

async function pushOnePathNow(
  peerId: string,
  deviceId: string,
  space: string,
  path: string,
  deleted: boolean,
): Promise<void> {
  const store = getPeerLocalStore();
  const call: StoreCaller = (op, payload) => callStoreOnPeerId(peerId, op, payload);
  if (deleted) {
    const covered = store.listTombstones(deviceId).some((tomb) =>
      tomb.space === space && (tomb.path === path || tomb.path.startsWith(`${path}/`)),
    );
    if (!covered) return;
    await call('delete', { space, device: deviceId, path });
    return;
  }
  await pushFile(store, deviceId, space, path, call);
}

async function pushFile(
  store: PeerLocalStore,
  deviceId: string,
  space: string,
  path: string,
  call: StoreCaller,
): Promise<void> {
  const meta = store.meta(deviceId, space, path);
  const size = typeof meta.size === 'number' ? meta.size : -1;
  const sha256 = typeof meta.sha256 === 'string' ? meta.sha256 : '';
  if (!sha256 || size < 0 || meta.kind === 'dir') return;
  const begin = await call('write.begin', { space, device: deviceId, path, size, sha256 });
  if (begin._error) {
    throw Object.assign(new Error(String(begin._error)), { code: String(begin._error) });
  }
  const uploadId = String(begin.upload_id ?? '');
  let offset = typeof begin.received === 'number' ? begin.received : 0;
  const maxSteps = Math.ceil(size / MAX_CHUNK) + 2;
  for (let step = 0; step < maxSteps && offset < size; step++) {
    const part = store.read(deviceId, space, path, offset, MAX_CHUNK);
    const chunked = await call('write.chunk', {
      space,
      device: deviceId,
      upload_id: uploadId,
      offset,
      data: part.data.toString('base64'),
    });
    if (chunked._error) {
      throw Object.assign(new Error(String(chunked._error)), { code: String(chunked._error) });
    }
    offset += part.data.length;
    if (part.eof && offset >= size) break;
  }
  if (offset !== size) {
    throw Object.assign(new Error('short_read'), { code: 'short_read' });
  }
  const committed = await call('commit', { space, device: deviceId, upload_ids: [uploadId] });
  if (committed._error || (Array.isArray(committed.failed) && committed.failed.length > 0)) {
    throw Object.assign(new Error('commit_failed'), { code: 'commit_failed' });
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
      limit: BACKUP_PAGE,
      computeHash: false,
      includeHidden: true,
      forBackup: true,
      cursor,
    });
    for (const entry of listed.entries) {
      if (entry.kind === 'dir' || backupPathExcluded(entry.path)) continue;
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
  let offset = begin.received;
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
