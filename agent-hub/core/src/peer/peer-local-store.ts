/**
 * Minimal filesystem store for the hub peer service.
 *
 * Layout mirrors the app/Nexuspouch model:
 *   <root>/<device_id>/<space>/<relpath>
 *   <root>/.staging/<device_id>/<upload_id>/…
 *   <root>/.cursors/<device_id>.json — applied_seq for that device
 *   <root>/.tombstones/<device_id>.json — explicit deletes
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
  openSync,
  readdirSync,
  readFileSync,
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

function isCommitTmpName(name: string): boolean {
  return /^\..+\.[0-9a-f-]{36}\.tmp$/i.test(name);
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

    const skipName = (name: string): boolean => {
      if (name === '.' || name === '..' || isCommitTmpName(name)) return true;
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
      const walk = (dir: string, rel: string): void => {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (skipName(name)) continue;
          const abs = join(dir, name);
          const childRel = rel ? `${rel}/${name}` : name;
          let st: Stats;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            if (markDir(abs)) walk(abs, childRel);
          } else if (st.isFile() && matchesPrefix(childRel, prefix)) {
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
      walk(base, '');
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
    const bytes = readFileSync(entry.abs);
    return {
      path: entry.path,
      size: entry.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
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
    const bytes = readFileSync(abs);
    return {
      kind: 'file',
      size: st.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
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
    const len = Math.min(Math.max(1, length), MAX_CHUNK, Math.max(0, size - offset));
    const fd = readFileSync(abs);
    const slice = fd.subarray(offset, offset + len);
    return { data: slice, size, eof: offset + slice.length >= size };
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
    const uploadId = opts.uploadId ?? randomUUID();
    const staging = join(this.root, '.staging', opts.deviceId, uploadId);
    const metaPath = join(staging, 'meta.json');
    if (opts.uploadId && existsSync(metaPath)) {
      const existing = JSON.parse(readFileSync(metaPath, 'utf-8')) as StagingMeta;
      if (
        existing.deviceId !== opts.deviceId ||
        existing.space !== opts.space ||
        existing.path !== opts.path
      ) {
        throw Object.assign(new Error('staging_state'), { code: 'staging_state' });
      }
      return { upload_id: uploadId, received: existing.received };
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
    if (offset < meta.received && offset + data.length <= meta.received) {
      return { received: meta.received };
    }
    if (offset !== meta.received) {
      throw Object.assign(new Error('resume'), { code: 'resume', received: meta.received });
    }
    if (data.length === 0) return { received: meta.received };
    const fd = openSync(dataPath, 'r+');
    try {
      writeSync(fd, data, 0, data.length, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    meta.received = offset + data.length;
    atomicWriteFile(metaPath, JSON.stringify(meta));
    return { received: meta.received };
  }

  commit(
    deviceId: string,
    space: string,
    uploadIds: string[],
    uptoSeq?: number,
  ): { failed: unknown[]; applied_seq?: number } {
    const failed: unknown[] = [];
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
        const data = readFileSync(join(staging, 'data.bin'));
        const sha = createHash('sha256').update(data).digest('hex');
        if (meta.sha256 !== sha || meta.size !== data.length) {
          failed.push({ upload_id: uploadId, code: 'hash_mismatch' });
          continue;
        }
        const dest = resolveUnder(this.root, deviceId, space, ...meta.path.split('/'));
        atomicWriteFile(dest, data);
        this.clearTombstonePath(deviceId, space, meta.path);
        rmSync(staging, { recursive: true, force: true });
      } catch (e) {
        failed.push({
          upload_id: uploadId,
          code: (e as { code?: string }).code ?? 'internal',
        });
      }
    }
    if (typeof uptoSeq === 'number' && failed.length === 0) {
      this.setAppliedSeq(deviceId, uptoSeq);
      return { failed, applied_seq: uptoSeq };
    }
    return { failed, applied_seq: this.appliedSeq(deviceId) };
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
    try {
      if (statSync(abs).isFile()) {
        const data = readFileSync(abs);
        this.putTombstone(deviceId, {
          space,
          path,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        });
      }
    } catch {
      /* still remove the path */
    }
    rmSync(abs, { recursive: true, force: true });
    if (typeof uptoSeq === 'number') this.setAppliedSeq(deviceId, uptoSeq);
    return { applied_seq: this.appliedSeq(deviceId) };
  }

  /** Drop abandoned uploads so a failed transfer cannot fill the disk. */
  gcStaging(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const root = join(this.root, '.staging');
    if (!existsSync(root)) return 0;
    const now = Date.now();
    let removed = 0;
    let devices: string[];
    try {
      devices = readdirSync(root);
    } catch {
      return 0;
    }
    for (const device of devices) {
      const deviceDir = join(root, device);
      let uploads: string[];
      try {
        if (!statSync(deviceDir).isDirectory()) continue;
        uploads = readdirSync(deviceDir);
      } catch {
        continue;
      }
      for (const uploadId of uploads) {
        const dir = join(deviceDir, uploadId);
        let mtime = 0;
        try {
          const meta = join(dir, 'meta.json');
          mtime = statSync(existsSync(meta) ? meta : dir).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtime < maxAgeMs) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
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

  private putTombstone(deviceId: string, entry: TombstoneEntry): void {
    const id = normalizeDeviceId(deviceId);
    if (!id || !entry.sha256) return;
    const next = this.readTombstones(id).filter(
      (item) => item.space !== entry.space || item.path !== entry.path,
    );
    next.push(entry);
    this.writeTombstones(id, next);
  }

  private clearTombstonePath(deviceId: string, space: string, path: string): void {
    const id = normalizeDeviceId(deviceId);
    if (!id) return;
    const all = this.readTombstones(id);
    const next = all.filter((item) => item.space !== space || item.path !== path);
    if (next.length === all.length) return;
    this.writeTombstones(id, next);
  }

  private tombstoneFile(id: string): string {
    return join(this.root, '.tombstones', `${id}.json`);
  }

  private readTombstones(id: string): TombstoneEntry[] {
    const file = this.tombstoneFile(id);
    if (!existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { entries?: TombstoneEntry[] };
      return Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  private writeTombstones(id: string, entries: TombstoneEntry[]): void {
    const file = this.tombstoneFile(id);
    if (entries.length === 0) {
      if (existsSync(file)) rmSync(file, { force: true });
      return;
    }
    atomicWriteFile(file, JSON.stringify({ entries }));
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
