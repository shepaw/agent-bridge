/**
 * Minimal filesystem store for the hub peer service.
 *
 * Layout mirrors the app/Nexuspouch model:
 *   <root>/<device_id>/<space>/<relpath>
 *   <root>/.staging/<device_id>/<upload_id>/…
 *   <root>/.cursors/<device_id>.json — applied_seq for that device
 *   <root>/.tombstones/<device_id>/<key>.json — one explicit delete each
 *   <root>/.tombstones/<device_id>.json — legacy combined delete list
 *   <root>/.cursors.json — legacy shared cursor map (read fallback only)
 *
 * Supports list / meta / read and write.begin / write.chunk / commit / delete
 * so a phone can mirror its pouch here when the hub is master.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, normalize, relative, sep } from 'node:path';
import { peerStoreRoot } from '../paths.js';

export const SHARED_SPACES = new Set(['artifacts', 'files', 'workspaces', 'public']);
export const ALL_SPACES = new Set([
  'runtime',
  'artifacts',
  'files',
  'public',
  'attachments',
  'backups',
  // Canonical cognition space (soul.md / entries); 'memory' is the legacy
  // alias the app still reads for fallback.
  'cognition',
  'memory',
  'sessions',
  'workspaces',
  'agents',
]);
export const MAX_CHUNK = 64 * 1024;

/** Dependency and VCS trees are never part of a backup, in any space. */
const BACKUP_DIR_SKIP = new Set(['node_modules', '.git']);
/**
 * Workspaces point at a real project. Build and tool caches stay on the
 * source machine; copying them fills the master disk.
 */
const WORKSPACE_BACKUP_DIR_SKIP = new Set([
  ...BACKUP_DIR_SKIP,
  'dist',
  'build',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
]);

/** True when a backup must not copy or delete this path. */
export function isBackupExcluded(space: string, path: string): boolean {
  const skip = space === 'workspaces' ? WORKSPACE_BACKUP_DIR_SKIP : BACKUP_DIR_SKIP;
  return path.split('/').some((part) => skip.has(part));
}

/** Cap on files scanned per device when enumerating backup mirrors. */
export const MAX_BACKUP_WALK_FILES = 50_000;

/** Per-space usage within a mirrored device pouch. */
export interface BackupSpaceInfo {
  space: string;
  files: number;
  bytes: number;
}

/** A device that mirrored its pouch into this hub (this hub acting as master). */
export interface BackupDeviceInfo {
  fingerprint: string;
  spaces: BackupSpaceInfo[];
  totalFiles: number;
  totalBytes: number;
  /** Newest file mtime across the mirror (ms). */
  lastModified: number;
  /** Sync progress from the per-device cursor. */
  lastSyncSeq: number;
  /** False when the cursor file is unreadable; lastSyncSeq is then not a confirmation. */
  cursorReliable: boolean;
}

export interface StoreEntryJson {
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  /** Present when listing with finite `depth` (dirs included). */
  kind?: 'file' | 'dir';
}

export interface StoreLocation {
  deviceId: string;
  space: string;
  path: string;
}

interface StagingMeta {
  deviceId: string;
  space: string;
  path: string;
  size: number;
  sha256: string;
  received: number;
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return false;
  const parts = rel.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    // Allow `.hidden`-style segments (common in workspace abs paths) but
    // still reject `.` / `..` and empty parts (path traversal).
    if (part === '' || part === '.' || part === '..') {
      return false;
    }
  }
  return true;
}

function normalizeDeviceId(deviceId: string): string | null {
  const id = deviceId.trim().toLowerCase();
  return /^[a-f0-9]{16}$/.test(id) ? id : null;
}

/** `src` matches `src` and `src/a`, and does not match `src2`. */
function matchesPrefix(path: string, prefix?: string): boolean {
  if (!prefix) return true;
  const p = prefix.replace(/^\/+|\/+$/g, '');
  if (!p) return true;
  return path === p || path.startsWith(`${p}/`);
}

/** A directory can hold files matching `prefix` (segment match, not a string prefix). */
function dirCouldMatch(dirRel: string, prefix?: string): boolean {
  if (!prefix) return true;
  const p = prefix.replace(/^\/+|\/+$/g, '');
  if (!p || !dirRel) return true;
  return dirRel === p || dirRel.startsWith(`${p}/`) || p.startsWith(`${dirRel}/`);
}

function heapPush(heap: ListedNode[], node: ListedNode): void {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.path <= heap[i]!.path) break;
    const tmp = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(heap: ListedNode[]): ListedNode | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0 || top === last) return top;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const left = i * 2 + 1;
    const right = left + 1;
    let smallest = i;
    if (left < heap.length && heap[left]!.path < heap[smallest]!.path) smallest = left;
    if (right < heap.length && heap[right]!.path < heap[smallest]!.path) smallest = right;
    if (smallest === i) break;
    const tmp = heap[i]!;
    heap[i] = heap[smallest]!;
    heap[smallest] = tmp;
    i = smallest;
  }
  return top;
}

function isCommitTmpName(name: string): boolean {
  return /^\..+\.[0-9a-f-]{36}\.tmp$/i.test(name);
}

/** An upload that never received a byte is abandoned this long after it was begun. */
export const STAGING_EMPTY_AGE_MS = 10 * 60 * 1000;
/** Any unfinished upload is abandoned this long after its last write. */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Uploads inspected by one {@link PeerLocalStore.gcStaging} call. */
export const STAGING_GC_SCAN = 2_000;
/**
 * Wall-clock ceiling for one {@link PeerLocalStore.gcStaging} call.
 *
 * Reclaiming is unlink-bound, not scan-bound: removing an entry from a
 * `.staging` tree that has grown huge costs milliseconds per upload, so a
 * count-only bound can still block the event loop for seconds. The budget is
 * what keeps a pass short enough that a write waiting behind it stays well
 * inside the peer call timeout.
 */
export const STAGING_GC_BUDGET_MS = 250;

/**
 * Staging directory name for one object.
 *
 * Derived from space+path so resuming a write is a single lookup instead of a
 * scan of every staged upload — a `.staging` that has grown large must not
 * make each write slower than the last.
 */
function stagingKey(space: string, path: string): string {
  return createHash('sha256').update(`${space}\0${path}`).digest('hex').slice(0, 32);
}

/** SHA-256 of a file without reading it all into memory. */
function hashFile(abs: string): { size: number; sha256: string } {
  const hash = createHash('sha256');
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(MAX_CHUNK);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, size);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      size += n;
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** Write `data` via a temp file in the same directory, fsync, then rename. */
function atomicWriteFile(dest: string, data: Buffer | string): void {
  ensureDir(dirname(dest));
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

interface TombstoneEntry {
  space: string;
  path: string;
  size: number;
  sha256: string;
}

interface ListedNode {
  abs: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
  mtime: number;
}

function resolveUnder(root: string, ...segments: string[]): string {
  const target = normalize(join(root, ...segments));
  const rel = relative(root, target);
  if (rel.startsWith('..') || (!target.startsWith(root + sep) && target !== root)) {
    throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
  }
  return target;
}

export class PeerLocalStore {
  readonly root: string;

  constructor(root: string = peerStoreRoot()) {
    this.root = root;
    ensureDir(this.root);
  }

  private cursorsPath(): string {
    return join(this.root, '.cursors.json');
  }

  /**
   * Cursor for one device. A missing file is a reliable 0 (nothing confirmed).
   * A corrupt file is unreliable: callers must reconcile content instead of
   * treating the device as synced through 0.
   */
  cursorState(deviceId: string): { appliedSeq: number; reliable: boolean } {
    const id = normalizeDeviceId(deviceId);
    if (!id) return { appliedSeq: 0, reliable: true };
    const file = this.cursorFile(id);
    if (!existsSync(file)) return this.legacyCursor(id);
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { applied_seq?: unknown };
      if (typeof raw?.applied_seq !== 'number' || !Number.isFinite(raw.applied_seq)) {
        return { appliedSeq: 0, reliable: false };
      }
      return { appliedSeq: raw.applied_seq, reliable: true };
    } catch {
      return { appliedSeq: 0, reliable: false };
    }
  }

  appliedSeq(deviceId: string): number {
    return this.cursorState(deviceId).appliedSeq;
  }

  setAppliedSeq(deviceId: string, seq: number): void {
    const id = normalizeDeviceId(deviceId);
    if (!id || !Number.isFinite(seq)) return;
    const file = this.cursorFile(id);
    ensureDir(dirname(file));
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = this.cursorState(id);
      if (cur.reliable && seq <= cur.appliedSeq) return;
      atomicWriteFile(file, JSON.stringify({ applied_seq: seq }));
      const check = this.cursorState(id);
      if (check.reliable && check.appliedSeq >= seq) return;
    }
  }

  private cursorFile(id: string): string {
    return join(this.root, '.cursors', `${id}.json`);
  }

  private legacyCursor(id: string): { appliedSeq: number; reliable: boolean } {
    const path = this.cursorsPath();
    if (!existsSync(path)) return { appliedSeq: 0, reliable: true };
    try {
      const map = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return { appliedSeq: 0, reliable: false };
      }
      if (!(id in map)) return { appliedSeq: 0, reliable: true };
      const value = map[id];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { appliedSeq: 0, reliable: false };
      }
      return { appliedSeq: value, reliable: true };
    } catch {
      return { appliedSeq: 0, reliable: false };
    }
  }

  /**
   * List entries under a device/space.
   *
   * - `depth` omitted / ≤0: legacy recursive file list (no dir rows).
   * - `depth` ≥1: layer-limited listing from `prefix` as the start directory;
   *   includes `kind: 'dir'` so agents can traverse one folder at a time
   *   (e.g. `agents/<uuid>/…`, `workspaces/…`).
   */
  list(
    deviceId: string,
    space: string,
    prefix?: string,
    limit = 1000,
    depth?: number,
    computeHash = true,
  ): StoreEntryJson[] {
    return this.listPage({ deviceId, space, prefix, limit, depth, computeHash }).entries;
  }

  /**
   * Inventory page. Paths are sorted. `cursor` is the last path of the previous
   * page. Dotfiles are included only when `includeHidden` is set. Prefixes match
   * on a path segment (`src` does not include `src2`).
   */
  listPage(opts: {
    deviceId: string;
    space: string;
    prefix?: string;
    limit?: number;
    depth?: number;
    computeHash?: boolean;
    cursor?: string;
    includeHidden?: boolean;
    /** Backup inventory: skip dependency/build trees and symlinks that leave this space. */
    forBackup?: boolean;
  }): { entries: StoreEntryJson[]; next_cursor: string | null } {
    const {
      deviceId,
      space,
      prefix,
      limit = 1000,
      depth,
      computeHash = true,
      cursor,
      includeHidden = false,
      forBackup = false,
    } = opts;
    if (!ALL_SPACES.has(space)) {
      throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
    }
    const cap = Math.max(1, Math.min(limit, 5000));
    const base = resolveUnder(this.root, deviceId, space);
    if (!existsSync(base)) return { entries: [], next_cursor: null };

    const maxDepth = typeof depth === 'number' && depth > 0 ? depth : 0;
    const seenDirs = new Set<string>();
    const pending: ListedNode[] = [];

    const spaceReal = (() => {
      try {
        return realpathSync(base);
      } catch {
        return base;
      }
    })();
    const leavesSpace = (abs: string): boolean => {
      if (!forBackup) return false;
      try {
        const real = realpathSync(abs);
        return real !== spaceReal && !real.startsWith(spaceReal + sep);
      } catch {
        return true;
      }
    };

    const skipName = (name: string): boolean => {
      if (name === '.' || name === '..' || isCommitTmpName(name)) return true;
      if (forBackup && isBackupExcluded(space, name)) return true;
      if (!includeHidden && name.startsWith('.')) return true;
      return false;
    };

    const markDir = (abs: string): boolean => {
      let key: string;
      try {
        if (!statSync(abs).isDirectory()) return false;
        key = realpathSync(abs);
      } catch {
        return false;
      }
      if (seenDirs.has(key)) return false;
      seenDirs.add(key);
      return true;
    };

    if (maxDepth > 0) {
      const startRel = (prefix ?? '').replace(/^\/+|\/+$/g, '');
      if (startRel && !isSafeRelPath(startRel)) {
        throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
      }
      const startDir = startRel
        ? resolveUnder(this.root, deviceId, space, ...startRel.split('/'))
        : base;
      if (!markDir(startDir)) return { entries: [], next_cursor: null };
      const walkShallow = (dir: string, rel: string, remaining: number): void => {
        if (remaining < 1) return;
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (skipName(name)) continue;
          const abs = join(dir, name);
          if (leavesSpace(abs)) continue;
          const childRel = rel ? `${rel}/${name}` : name;
          let st: Stats;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            pending.push({ abs, path: childRel, kind: 'dir', size: 0, mtime: st.mtimeMs });
            if (remaining > 1 && markDir(abs)) walkShallow(abs, childRel, remaining - 1);
          } else if (st.isFile()) {
            pending.push({
              abs,
              path: childRel,
              kind: 'file',
              size: st.size,
              mtime: st.mtimeMs,
            });
          }
        }
      };
      walkShallow(startDir, startRel, maxDepth);
    } else if (markDir(base)) {
      // Expand one directory when its path is next. The heap holds the frontier,
      // so a deep tree is not copied into memory before the page is cut.
      const heap: ListedNode[] = [];
      const expand = (dir: string, rel: string): void => {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (skipName(name)) continue;
          const abs = join(dir, name);
          if (leavesSpace(abs)) continue;
          const childRel = rel ? `${rel}/${name}` : name;
          let st: Stats;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            if (!dirCouldMatch(childRel, prefix) || !markDir(abs)) continue;
            heapPush(heap, { abs, path: childRel, kind: 'dir', size: 0, mtime: st.mtimeMs });
          } else if (st.isFile() && matchesPrefix(childRel, prefix)) {
            heapPush(heap, {
              abs,
              path: childRel,
              kind: 'file',
              size: st.size,
              mtime: st.mtimeMs,
            });
          }
        }
      };
      expand(base, '');
      const page: ListedNode[] = [];
      let more = false;
      while (heap.length > 0) {
        const node = heapPop(heap);
        if (!node) break;
        if (node.kind === 'dir') {
          expand(node.abs, node.path);
          continue;
        }
        if (cursor && !(node.path > cursor)) continue;
        if (page.length < cap) page.push(node);
        else {
          more = true;
          break;
        }
      }
      return {
        entries: page.map((entry) => this.entryJson(entry, computeHash)),
        next_cursor: more ? (page[page.length - 1]?.path ?? null) : null,
      };
    }

    pending.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const after = cursor ? pending.filter((entry) => entry.path > cursor) : pending;
    const page = after.slice(0, cap);
    const next = after.length > cap ? (page[page.length - 1]?.path ?? null) : null;
    return {
      entries: page.map((entry) => this.entryJson(entry, computeHash)),
      next_cursor: next,
    };
  }

  private entryJson(entry: ListedNode, computeHash: boolean): StoreEntryJson {
    if (entry.kind === 'dir' || !computeHash) {
      return {
        path: entry.path,
        size: entry.kind === 'dir' ? 0 : entry.size,
        sha256: '',
        mtime: entry.mtime,
        kind: entry.kind,
      };
    }
    const hashed = hashFile(entry.abs);
    return {
      path: entry.path,
      size: hashed.size,
      sha256: hashed.sha256,
      mtime: entry.mtime,
      kind: 'file',
    };
  }

  meta(deviceId: string, space: string, path: string): Record<string, unknown> {
    if (!isSafeRelPath(path)) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    const abs = resolveUnder(this.root, deviceId, space, ...path.split('/'));
    if (!existsSync(abs)) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      return {
        kind: 'dir',
        size: 0,
        sha256: '',
        mtime: st.mtimeMs,
      };
    }
    if (!st.isFile()) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    const hashed = hashFile(abs);
    return {
      kind: 'file',
      size: hashed.size,
      sha256: hashed.sha256,
      mtime: st.mtimeMs,
    };
  }

  read(
    deviceId: string,
    space: string,
    path: string,
    offset = 0,
    length = MAX_CHUNK,
  ): { data: Buffer; size: number; eof: boolean } {
    if (!isSafeRelPath(path)) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    const abs = resolveUnder(this.root, deviceId, space, ...path.split('/'));
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    const size = statSync(abs).size;
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    if (start >= size) {
      return { data: Buffer.alloc(0), size, eof: true };
    }
    const len = Math.min(Math.max(1, length), MAX_CHUNK, size - start);
    const data = Buffer.alloc(len);
    const fd = openSync(abs, 'r');
    try {
      const n = readSync(fd, data, 0, len, start);
      const slice = n === len ? data : data.subarray(0, n);
      return { data: slice, size, eof: start + n >= size };
    } finally {
      closeSync(fd);
    }
  }

  writeBegin(opts: {
    deviceId: string;
    space: string;
    path: string;
    size: number;
    sha256: string;
    uploadId?: string;
  }): { upload_id: string; received: number } {
    if (!ALL_SPACES.has(opts.space) || !isSafeRelPath(opts.path)) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    const open = opts.uploadId
      ? null
      : this.findOpenStaging(opts.deviceId, opts.space, opts.path);
    // A fresh upload is named from space+path so its own retry resumes the one
    // directory instead of adding another. Callers that resume a specific
    // transfer still pass their own upload_id.
    const uploadId = opts.uploadId ?? open?.uploadId ?? stagingKey(opts.space, opts.path);
    const staging = join(this.root, '.staging', opts.deviceId, uploadId);
    const metaPath = join(staging, 'meta.json');
    if ((opts.uploadId || open) && existsSync(metaPath)) {
      const existing = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagingMeta;
      if (
        existing.deviceId !== opts.deviceId ||
        existing.space !== opts.space ||
        existing.path !== opts.path
      ) {
        throw Object.assign(new Error('staging_state'), { code: 'staging_state' });
      }
      if (
        open &&
        (existing.sha256 !== opts.sha256 || existing.size !== opts.size)
      ) {
        /* different object: start a new upload below */
      } else {
        // Refresh mtime so a later staging sweep does not drop an upload we just resumed.
        atomicWriteFile(metaPath, JSON.stringify(existing));
        return { upload_id: uploadId, received: existing.received };
      }
    }
    ensureDir(staging);
    const meta: StagingMeta = {
      deviceId: opts.deviceId,
      space: opts.space,
      path: opts.path,
      size: opts.size,
      sha256: opts.sha256,
      received: 0,
    };
    atomicWriteFile(metaPath, JSON.stringify(meta));
    writeFileSync(join(staging, 'data.bin'), Buffer.alloc(0));
    return { upload_id: uploadId, received: 0 };
  }

  writeChunk(
    deviceId: string,
    uploadId: string,
    offset: number,
    data: Buffer,
  ): { received: number } {
    const staging = join(this.root, '.staging', deviceId, uploadId);
    const metaPath = join(staging, 'meta.json');
    if (!existsSync(metaPath)) {
      throw Object.assign(new Error('staging_state'), { code: 'staging_state' });
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagingMeta;
    if (data.length > MAX_CHUNK) {
      throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
    }
    const dataPath = join(staging, 'data.bin');
    if (!existsSync(dataPath)) writeFileSync(dataPath, Buffer.alloc(0));
    const sizeOnDisk = statSync(dataPath).size;
    if (sizeOnDisk > meta.received) {
      meta.received = sizeOnDisk;
      atomicWriteFile(metaPath, JSON.stringify(meta));
    }
    if (data.length === 0) return { received: meta.received };
    if (offset < meta.received && offset + data.length <= meta.received) {
      return { received: meta.received };
    }
    if (offset > meta.received && offset + data.length <= meta.size) {
      // A later block arrived first. Keep it until the gap in front is filled.
      const ahead = join(staging, 'ahead', String(offset));
      ensureDir(dirname(ahead));
      writeFileSync(ahead, data);
      return { received: meta.received };
    }
    if (offset !== meta.received) {
      throw Object.assign(new Error('resume'), { code: 'resume', received: meta.received });
    }
    const fd = openSync(dataPath, 'r+');
    try {
      writeSync(fd, data, 0, data.length, offset);
      meta.received = offset + data.length;
      const aheadDir = join(staging, 'ahead');
      while (existsSync(join(aheadDir, String(meta.received)))) {
        const extra = readFileSync(join(aheadDir, String(meta.received)));
        writeSync(fd, extra, 0, extra.length, meta.received);
        rmSync(join(aheadDir, String(meta.received)));
        meta.received += extra.length;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    atomicWriteFile(metaPath, JSON.stringify(meta));
    return { received: meta.received };
  }

  commit(
    deviceId: string,
    space: string,
    uploadIds: string[],
    uptoSeq?: number,
  ): { failed: unknown[]; applied_seq?: number; paths: string[] } {
    const failed: unknown[] = [];
    const paths: string[] = [];
    for (const uploadId of uploadIds) {
      try {
        const staging = join(this.root, '.staging', deviceId, uploadId);
        const meta = JSON.parse(
          readFileSync(join(staging, 'meta.json'), 'utf-8'),
        ) as StagingMeta;
        if (meta.space !== space || meta.deviceId !== deviceId) {
          failed.push({ upload_id: uploadId, code: 'acl_denied' });
          continue;
        }
        if (!meta.sha256 || meta.size < 0) {
          failed.push({ upload_id: uploadId, code: 'integrity_required' });
          continue;
        }
        const dataPath = join(staging, 'data.bin');
        const hashed = hashFile(dataPath);
        if (meta.sha256 !== hashed.sha256 || meta.size !== hashed.size) {
          failed.push({ upload_id: uploadId, code: 'hash_mismatch' });
          continue;
        }
        const dest = resolveUnder(this.root, deviceId, space, ...meta.path.split('/'));
        ensureDir(dirname(dest));
        const staged = openSync(dataPath, 'r+');
        try {
          fsyncSync(staged);
        } finally {
          closeSync(staged);
        }
        renameSync(dataPath, dest);
        this.clearTombstonePath(deviceId, space, meta.path);
        rmSync(staging, { recursive: true, force: true });
        paths.push(meta.path);
      } catch (e) {
        failed.push({
          upload_id: uploadId,
          code: (e as { code?: string }).code ?? 'internal',
        });
      }
    }
    if (typeof uptoSeq === 'number' && failed.length === 0) {
      this.setAppliedSeq(deviceId, uptoSeq);
      return { failed, applied_seq: uptoSeq, paths };
    }
    return { failed, applied_seq: this.appliedSeq(deviceId), paths };
  }

  delete(
    deviceId: string,
    space: string,
    path: string,
    uptoSeq?: number,
  ): { applied_seq?: number } {
    if (!isSafeRelPath(path)) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    const abs = resolveUnder(this.root, deviceId, space, ...path.split('/'));
    if (!existsSync(abs)) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    this.tombstoneTree(deviceId, space, abs, path);
    rmSync(abs, { recursive: true, force: true });
    if (typeof uptoSeq === 'number') this.setAppliedSeq(deviceId, uptoSeq);
    return { applied_seq: this.appliedSeq(deviceId) };
  }

  /**
   * Resume an unfinished upload for the same object, if one is still staged.
   * One directory lookup — never a scan of the whole `.staging` tree.
   */
  findOpenStaging(
    deviceId: string,
    space: string,
    path: string,
  ): { uploadId: string; received: number; size: number; sha256: string } | null {
    const uploadId = stagingKey(space, path);
    const metaPath = join(this.root, '.staging', deviceId, uploadId, 'meta.json');
    if (!existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagingMeta;
      if (meta.space !== space || meta.path !== path || meta.deviceId !== deviceId) {
        return null;
      }
      return {
        uploadId,
        received: meta.received,
        size: meta.size,
        sha256: meta.sha256,
      };
    } catch {
      return null;
    }
  }

  /** Master fingerprint announced by this device, or null when it has not chosen one. */
  announcedMaster(deviceId: string): string | null {
    const id = normalizeDeviceId(deviceId);
    if (!id) return null;
    const file = this.masterFile(id);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { master?: unknown };
      const master = typeof raw.master === 'string' ? raw.master.trim().toLowerCase() : '';
      return /^[a-f0-9]{16}$/.test(master) ? master : null;
    } catch {
      return null;
    }
  }

  /**
   * Record that `deviceId` named `master` as its backup master.
   * `null` clears the claim. The mirrored files stay on disk either way.
   */
  setAnnouncedMaster(deviceId: string, master: string | null): void {
    const id = normalizeDeviceId(deviceId);
    if (!id) return;
    const file = this.masterFile(id);
    if (master === null || !/^[a-f0-9]{16}$/i.test(master)) {
      if (existsSync(file)) rmSync(file, { force: true });
      return;
    }
    atomicWriteFile(file, JSON.stringify({ master: master.toLowerCase() }));
  }

  listTombstones(deviceId: string): TombstoneEntry[] {
    const id = normalizeDeviceId(deviceId);
    if (!id) return [];
    return this.readTombstones(id);
  }

  private masterFile(id: string): string {
    return join(this.root, '.masters', `${id}.json`);
  }

  /**
   * Drop abandoned uploads so a failed transfer cannot fill the disk.
   *
   * Bounded on purpose, by both `maxScan` uploads and `maxMs` elapsed, so a
   * `.staging` that has grown huge cannot block the event loop for seconds —
   * each device directory is streamed rather than read whole, and the time
   * budget ends the pass even when unlinking is what is slow. Callers that
   * need to drain a large pile call this again.
   *
   * `emptyAgeMs` only ever shortens the life of an upload: one that never
   * received a byte cannot still be in flight, so it is not worth keeping for
   * the full `maxAgeMs`.
   */
  gcStaging(
    maxAgeMs = STAGING_MAX_AGE_MS,
    maxScan = STAGING_GC_SCAN,
    emptyAgeMs = STAGING_EMPTY_AGE_MS,
    maxMs = STAGING_GC_BUDGET_MS,
  ): number {
    const root = join(this.root, '.staging');
    // One clock for the whole pass: ages are judged against its start, and the
    // same reference ends the pass once the budget is gone.
    const now = Date.now();
    let removed = 0;
    let scanned = 0;
    const spent = (): boolean => scanned >= maxScan || Date.now() - now >= maxMs;
    let devices: string[];
    try {
      devices = readdirSync(root);
    } catch {
      return 0;
    }
    for (const device of devices) {
      if (spent()) break;
      const deviceDir = join(root, device);
      let dir;
      try {
        if (!statSync(deviceDir).isDirectory()) continue;
        dir = opendirSync(deviceDir);
      } catch {
        continue;
      }
      try {
        for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
          if (spent()) return removed;
          scanned += 1;
          if (!entry.isDirectory()) continue;
          const uploadDir = join(deviceDir, entry.name);
          const metaPath = join(uploadDir, 'meta.json');
          let mtime = 0;
          let received = 0;
          try {
            if (existsSync(metaPath)) {
              mtime = statSync(metaPath).mtimeMs;
              const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagingMeta;
              received = typeof meta.received === 'number' ? meta.received : 0;
            } else {
              mtime = statSync(uploadDir).mtimeMs;
            }
          } catch {
            continue;
          }
          const limit = received > 0 ? maxAgeMs : Math.min(maxAgeMs, emptyAgeMs);
          if (now - mtime < limit) continue;
          rmSync(uploadDir, { recursive: true, force: true });
          removed += 1;
        }
      } finally {
        try {
          dir.closeSync();
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }

  tombstone(
    deviceId: string,
    space: string,
    path: string,
  ): { size: number; sha256: string } | null {
    const id = normalizeDeviceId(deviceId);
    if (!id) return null;
    const hit = this.readTombstones(id).find((entry) => entry.space === space && entry.path === path);
    if (!hit?.sha256) return null;
    return { size: hit.size, sha256: hit.sha256 };
  }

  /**
   * Record every real file under `abs` before it is removed.
   * Symlinks are not followed, and dependency or git trees are skipped:
   * a later backup must be able to delete those copies, not copy them.
   */
  private tombstoneTree(deviceId: string, space: string, abs: string, rel: string): void {
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === '.' || name === '..' || isBackupExcluded(space, name)) continue;
        const child = rel ? `${rel}/${name}` : name;
        this.tombstoneTree(deviceId, space, join(abs, name), child);
      }
      return;
    }
    if (!st.isFile()) return;
    try {
      const hashed = hashFile(abs);
      this.putTombstone(deviceId, {
        space,
        path: rel,
        size: hashed.size,
        sha256: hashed.sha256,
      });
    } catch {
      /* still remove the path */
    }
  }

  private putTombstone(deviceId: string, entry: TombstoneEntry): void {
    const id = normalizeDeviceId(deviceId);
    if (!id || !entry.sha256) return;
    this.migrateLegacyTombstones(id);
    atomicWriteFile(this.tombstoneEntryPath(id, entry.space, entry.path), JSON.stringify(entry));
  }

  private clearTombstonePath(deviceId: string, space: string, path: string): void {
    const id = normalizeDeviceId(deviceId);
    if (!id) return;
    this.migrateLegacyTombstones(id);
    const file = this.tombstoneEntryPath(id, space, path);
    if (existsSync(file)) rmSync(file, { force: true });
  }

  /** Legacy combined file. New deletes are one file each so two processes cannot drop each other's entries. */
  private tombstoneFile(id: string): string {
    return join(this.root, '.tombstones', `${id}.json`);
  }

  private tombstoneDir(id: string): string {
    return join(this.root, '.tombstones', id);
  }

  private tombstoneEntryPath(id: string, space: string, path: string): string {
    const key = createHash('sha256').update(`${space}\0${path}`).digest('hex');
    return join(this.tombstoneDir(id), `${key}.json`);
  }

  private readTombstones(id: string): TombstoneEntry[] {
    const merged = new Map<string, TombstoneEntry>();
    for (const entry of this.readLegacyTombstones(id)) {
      merged.set(`${entry.space}\0${entry.path}`, entry);
    }
    const dir = this.tombstoneDir(id);
    if (existsSync(dir)) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const entry = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as TombstoneEntry;
          if (!entry || typeof entry.path !== 'string' || typeof entry.space !== 'string' || !entry.sha256) {
            continue;
          }
          merged.set(`${entry.space}\0${entry.path}`, entry);
        } catch {
          continue;
        }
      }
    }
    return [...merged.values()];
  }

  private readLegacyTombstones(id: string): TombstoneEntry[] {
    const file = this.tombstoneFile(id);
    if (!existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { entries?: TombstoneEntry[] };
      return Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  /** Split the legacy list into per-path files, then drop it. Concurrent splits write the same paths. */
  private migrateLegacyTombstones(id: string): void {
    const legacy = this.readLegacyTombstones(id);
    if (!existsSync(this.tombstoneFile(id))) return;
    for (const entry of legacy) {
      if (!entry.sha256 || !entry.path || !entry.space) continue;
      const dest = this.tombstoneEntryPath(id, entry.space, entry.path);
      if (!existsSync(dest)) {
        atomicWriteFile(dest, JSON.stringify(entry));
      }
    }
    rmSync(this.tombstoneFile(id), { force: true });
  }

  /**
   * Enumerate devices that have mirrored a pouch into this hub (this hub acting
   * as master). Excludes self and non-device entries (`.staging`, dotfiles).
   * The per-device walk is bounded so a huge mirror can't stall the dashboard.
   */
  listBackupDevices(selfDeviceId: string): BackupDeviceInfo[] {
    const DEVICE_DIR = /^[a-f0-9]{16}$/i;
    const out: BackupDeviceInfo[] = [];
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return out;
    }
    for (const name of names.sort()) {
      if (!DEVICE_DIR.test(name)) continue;
      if (name.toLowerCase() === selfDeviceId.toLowerCase()) continue;
      const deviceAbs = join(this.root, name);
      let st: Stats;
      try {
        st = statSync(deviceAbs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      const spaces: BackupSpaceInfo[] = [];
      let totalFiles = 0;
      let totalBytes = 0;
      let lastModified = 0;
      let scanned = 0;
      const walkSpace = (dir: string, stats: BackupSpaceInfo): void => {
        if (scanned >= MAX_BACKUP_WALK_FILES) return;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries.sort()) {
          if (scanned >= MAX_BACKUP_WALK_FILES) return;
          if (entry.startsWith('.')) continue;
          const abs = join(dir, entry);
          let es: Stats;
          try {
            es = statSync(abs);
          } catch {
            continue;
          }
          if (es.isDirectory()) {
            walkSpace(abs, stats);
          } else if (es.isFile()) {
            scanned += 1;
            stats.files += 1;
            stats.bytes += es.size;
            if (es.mtimeMs > lastModified) lastModified = es.mtimeMs;
          }
        }
      };

      for (const space of [...ALL_SPACES].sort()) {
        const spaceAbs = join(deviceAbs, space);
        try {
          if (!existsSync(spaceAbs) || !statSync(spaceAbs).isDirectory()) continue;
        } catch {
          continue;
        }
        const stats: BackupSpaceInfo = { space, files: 0, bytes: 0 };
        walkSpace(spaceAbs, stats);
        if (stats.files > 0) {
          spaces.push(stats);
          totalFiles += stats.files;
          totalBytes += stats.bytes;
        }
      }

      const cursor = this.cursorState(name);
      out.push({
        fingerprint: name,
        spaces,
        totalFiles,
        totalBytes,
        lastModified,
        lastSyncSeq: cursor.appliedSeq,
        cursorReliable: cursor.reliable,
      });
    }
    return out;
  }

  /**
   * Remove a device's mirrored pouch (backup cleanup). Refuses self and
   * non-device entries; also clears the device's sync cursor.
   */
  removeBackupDevice(fingerprint: string, selfDeviceId: string): void {
    if (!/^[a-f0-9]{16}$/i.test(fingerprint)) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    if (fingerprint.toLowerCase() === selfDeviceId.toLowerCase()) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    const abs = resolveUnder(this.root, fingerprint);
    if (!existsSync(abs)) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    rmSync(abs, { recursive: true, force: true });
    this.clearAppliedSeq(fingerprint);
    const id = fingerprint.toLowerCase();
    const tomb = this.tombstoneFile(id);
    if (existsSync(tomb)) rmSync(tomb, { force: true });
    const tombDir = this.tombstoneDir(id);
    if (existsSync(tombDir)) rmSync(tombDir, { recursive: true, force: true });
    const staging = join(this.root, '.staging', id);
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }

  private clearAppliedSeq(deviceId: string): void {
    const id = normalizeDeviceId(deviceId);
    if (!id) return;
    const file = this.cursorFile(id);
    if (existsSync(file)) rmSync(file, { force: true });
    this.clearLegacyKey(id);
  }

  private clearLegacyKey(id: string): void {
    const path = this.cursorsPath();
    if (!existsSync(path)) return;
    let map: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      map = parsed;
    } catch {
      return;
    }
    if (!(id in map)) return;
    delete map[id];
    atomicWriteFile(path, JSON.stringify(map, null, 2));
  }

  /**
   * Absolute path under the store root. Does not follow the final symlink.
   * Empty `path` resolves to the space directory.
   */
  absPath(deviceId: string, space: string, path?: string): string {
    if (!ALL_SPACES.has(space)) {
      throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
    }
    if (!path) return resolveUnder(this.root, deviceId, space);
    if (!isSafeRelPath(path)) {
      throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    }
    return resolveUnder(this.root, deviceId, space, ...path.split('/'));
  }

  copy(from: StoreLocation, to: StoreLocation): void {
    const src = this.absPath(from.deviceId, from.space, from.path);
    const dest = this.absPath(to.deviceId, to.space, to.path);
    if (!existsSync(src)) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    if (src === dest) {
      throw Object.assign(new Error('source and destination are the same'), { code: 'bad_path' });
    }
    if (existsSync(dest)) {
      throw Object.assign(new Error('destination exists'), { code: 'exists' });
    }
    ensureDir(dirname(dest));
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dest, { recursive: true, force: false });
    } else if (st.isFile()) {
      copyFileSync(src, dest);
    } else {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
  }

  move(from: StoreLocation, to: StoreLocation): void {
    const src = this.absPath(from.deviceId, from.space, from.path);
    const dest = this.absPath(to.deviceId, to.space, to.path);
    if (!existsSync(src)) {
      throw Object.assign(new Error('not_found'), { code: 'not_found' });
    }
    if (src === dest) {
      throw Object.assign(new Error('source and destination are the same'), { code: 'bad_path' });
    }
    if (existsSync(dest)) {
      throw Object.assign(new Error('destination exists'), { code: 'exists' });
    }
    ensureDir(dirname(dest));
    try {
      renameSync(src, dest);
    } catch {
      this.copy(from, to);
      rmSync(src, { recursive: true, force: true });
    }
  }
}

let _store: PeerLocalStore | undefined;

export function getPeerLocalStore(): PeerLocalStore {
  if (!_store) _store = new PeerLocalStore();
  return _store;
}

export function resetPeerLocalStoreForTest(root: string): PeerLocalStore {
  _store = new PeerLocalStore(root);
  return _store;
}
