/**
 * Minimal filesystem store for the hub peer service.
 *
 * Layout mirrors the app/Nexuspouch model:
 *   <root>/<device_id>/<space>/<relpath>
 *   <root>/.staging/<device_id>/<upload_id>/…
 *   <root>/.cursors.json  — applied_seq per device (sync.hello)
 *
 * Supports list / meta / read and write.begin / write.chunk / commit / delete
 * so a phone can mirror its pouch here when the hub is master.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { peerStoreRoot } from '../paths.js';

export const SHARED_SPACES = new Set(['artifacts', 'files', 'workspaces', 'public']);
export const ALL_SPACES = new Set([
  'runtime',
  'artifacts',
  'files',
  'public',
  'attachments',
  'backups',
  'memory',
  'sessions',
  'workspaces',
  'agents',
]);
export const MAX_CHUNK = 64 * 1024;

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

  appliedSeq(deviceId: string): number {
    try {
      const raw = JSON.parse(readFileSync(this.cursorsPath(), 'utf-8')) as Record<string, number>;
      return raw[deviceId] ?? 0;
    } catch {
      return 0;
    }
  }

  setAppliedSeq(deviceId: string, seq: number): void {
    let map: Record<string, number> = {};
    try {
      map = JSON.parse(readFileSync(this.cursorsPath(), 'utf-8')) as Record<string, number>;
    } catch {
      /* empty */
    }
    const prev = map[deviceId] ?? 0;
    if (seq > prev) map[deviceId] = seq;
    writeFileSync(this.cursorsPath(), JSON.stringify(map, null, 2));
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
    if (!ALL_SPACES.has(space)) {
      throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
    }
    const base = resolveUnder(this.root, deviceId, space);
    if (!existsSync(base)) return [];
    const out: StoreEntryJson[] = [];
    const maxDepth = typeof depth === 'number' && depth > 0 ? depth : 0;

    const fileEntry = (abs: string, childRel: string, st: Stats): StoreEntryJson => {
      if (!computeHash) {
        return {
          path: childRel,
          size: st.size,
          sha256: '',
          mtime: st.mtimeMs,
          kind: 'file',
        };
      }
      const bytes = readFileSync(abs);
      return {
        path: childRel,
        size: st.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mtime: st.mtimeMs,
        kind: 'file',
      };
    };

    if (maxDepth > 0) {
      const startRel = (prefix ?? '').replace(/^\/+|\/+$/g, '');
      if (startRel && !isSafeRelPath(startRel)) {
        throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
      }
      const startDir = startRel
        ? resolveUnder(this.root, deviceId, space, ...startRel.split('/'))
        : base;
      if (!existsSync(startDir) || !statSync(startDir).isDirectory()) {
        return [];
      }
      const walkShallow = (dir: string, rel: string, remaining: number): void => {
        if (out.length >= limit || remaining < 1) return;
        for (const name of readdirSync(dir)) {
          if (out.length >= limit) return;
          if (name.startsWith('.')) continue;
          const abs = join(dir, name);
          const childRel = rel ? `${rel}/${name}` : name;
          let st;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            out.push({
              path: childRel,
              size: 0,
              sha256: '',
              mtime: st.mtimeMs,
              kind: 'dir',
            });
            if (remaining > 1) walkShallow(abs, childRel, remaining - 1);
          } else if (st.isFile()) {
            out.push(fileEntry(abs, childRel, st));
          }
        }
      };
      walkShallow(startDir, startRel, maxDepth);
      return out;
    }

    const walk = (dir: string, rel: string): void => {
      if (out.length >= limit) return;
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const abs = join(dir, name);
        const childRel = rel ? `${rel}/${name}` : name;
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(abs, childRel);
        } else if (st.isFile()) {
          if (prefix && !childRel.startsWith(prefix)) continue;
          out.push(fileEntry(abs, childRel, st));
          if (out.length >= limit) return;
        }
      }
    };
    walk(base, '');
    return out;
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
    ensureDir(staging);
    const meta: StagingMeta = {
      deviceId: opts.deviceId,
      space: opts.space,
      path: opts.path,
      size: opts.size,
      sha256: opts.sha256,
      received: 0,
    };
    writeFileSync(join(staging, 'meta.json'), JSON.stringify(meta));
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
    if (offset !== meta.received) {
      throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
    }
    if (data.length > MAX_CHUNK) {
      throw Object.assign(new Error('bad_op'), { code: 'bad_op' });
    }
    const dataPath = join(staging, 'data.bin');
    const prev = existsSync(dataPath) ? readFileSync(dataPath) : Buffer.alloc(0);
    const next = Buffer.concat([prev, data]);
    writeFileSync(dataPath, next);
    meta.received = next.length;
    writeFileSync(metaPath, JSON.stringify(meta));
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
        const data = readFileSync(join(staging, 'data.bin'));
        const sha = createHash('sha256').update(data).digest('hex');
        if (meta.sha256 && meta.sha256 !== sha) {
          failed.push({ upload_id: uploadId, code: 'hash_mismatch' });
          continue;
        }
        if (meta.size >= 0 && meta.size !== data.length) {
          failed.push({ upload_id: uploadId, code: 'hash_mismatch' });
          continue;
        }
        const dest = resolveUnder(this.root, deviceId, space, ...meta.path.split('/'));
        ensureDir(dirname(dest));
        writeFileSync(dest, data);
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
    rmSync(abs, { recursive: true, force: true });
    if (typeof uptoSeq === 'number') this.setAppliedSeq(deviceId, uptoSeq);
    return { applied_seq: this.appliedSeq(deviceId) };
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
