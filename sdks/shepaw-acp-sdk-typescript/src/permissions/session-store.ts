/**
 * Persist Shepaw-session → agent SDK session mapping so the gateway can
 * resume a conversation across process restarts.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionsPath, type GatewayStorageConfig } from '../storage-paths.js';
import { log } from './log.js';

export interface SessionStoreOptions {
  /**
   * Storage configuration. Provide either a full `path` override or a
   * `gatewayDirName` (via {@link GatewayStorageConfig}) to compute the
   * default `~/.config/<gatewayDirName>/sessions.json`.
   */
  path?: string;
  gatewayDirName?: string;
}

interface PersistedShape {
  version: 1;
  /** shepaw session_id → agent-sdk session_id */
  map: Record<string, string>;
  /**
   * Agent-sdk session ids that were abandoned when their Shepaw conversation
   * forked to a fresh upstream session (restore failed / stale auth). They
   * still exist agent-side but must never resurface in session/list sync —
   * otherwise the app adopts the orphaned half as a duplicate session.
   */
  orphanedSdkIds?: string[];
}

export class SessionStore {
  private readonly path: string;
  private readonly mapping = new Map<string, string>();
  private readonly orphaned = new Set<string>();
  private writeTimer: NodeJS.Timeout | undefined;

  /** Bound orphan-set growth; oldest entries drop first (insertion order). */
  private static readonly MAX_ORPHANED = 1000;

  constructor(opts: SessionStoreOptions = {}) {
    if (opts.path !== undefined) {
      this.path = opts.path;
    } else if (opts.gatewayDirName !== undefined) {
      const cfg: GatewayStorageConfig = { gatewayDirName: opts.gatewayDirName };
      this.path = sessionsPath(cfg);
    } else {
      throw new Error(
        'SessionStore requires either `path` or `gatewayDirName` in its options.',
      );
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      const data = JSON.parse(raw) as PersistedShape;
      if (data.version === 1 && data.map && typeof data.map === 'object') {
        for (const [k, v] of Object.entries(data.map)) {
          if (typeof v === 'string') this.mapping.set(k, v);
        }
        if (Array.isArray(data.orphanedSdkIds)) {
          for (const id of data.orphanedSdkIds) {
            if (typeof id === 'string' && id.length > 0) this.orphaned.add(id);
          }
        }
        log.gateway(
          'SessionStore loaded %d entries (%d orphaned) from %s',
          this.mapping.size,
          this.orphaned.size,
          this.path,
        );
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.gateway('SessionStore: no existing file at %s (fresh start)', this.path);
      } else {
        log.gateway('SessionStore load failed: %s', e.message);
      }
    }
  }

  get(shepawSessionId: string): string | undefined {
    return this.mapping.get(shepawSessionId);
  }

  /**
   * Reverse lookup: find the shepaw session id that maps to a given upstream
   * agent-sdk session id. Used when listing sessions so an already-known
   * session is surfaced under the app's own id instead of the raw upstream id.
   */
  findShepawIdBySdkId(sdkSessionId: string): string | undefined {
    for (const [shepawId, sdkId] of this.mapping) {
      if (sdkId === sdkSessionId) return shepawId;
    }
    return undefined;
  }

  /** All upstream agent-sdk session ids we have mapped (for session-list filtering). */
  allSdkSessionIds(): ReadonlySet<string> {
    return new Set(this.mapping.values());
  }

  /**
   * Upstream ids from real app chats (shepaw id ≠ upstream id).
   *
   * List-adopt pre-seeds use the same id for both sides; those must not bypass
   * untitled-session filtering or empty warmup ghosts keep resurfacing.
   */
  establishedSdkSessionIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const [shepawId, sdkId] of this.mapping) {
      if (shepawId !== sdkId) ids.add(sdkId);
    }
    return ids;
  }

  set(shepawSessionId: string, sdkSessionId: string): void {
    // (Re)establishing a mapping to an id revives it — it is no longer orphaned.
    const deorphaned = this.orphaned.delete(sdkSessionId);
    if (this.mapping.get(shepawSessionId) === sdkSessionId) {
      if (deorphaned) this.schedulePersist();
      return;
    }
    this.mapping.set(shepawSessionId, sdkSessionId);
    this.schedulePersist();
  }

  /**
   * Record an upstream agent-sdk session id whose Shepaw conversation forked
   * to a new upstream session. Orphans are excluded from session/list sync so
   * the app never adopts the abandoned half as a duplicate session.
   */
  markOrphaned(sdkSessionId: string): void {
    if (sdkSessionId.length === 0 || this.orphaned.has(sdkSessionId)) return;
    this.orphaned.add(sdkSessionId);
    while (this.orphaned.size > SessionStore.MAX_ORPHANED) {
      const oldest = this.orphaned.values().next().value;
      if (oldest === undefined) break;
      this.orphaned.delete(oldest);
    }
    this.schedulePersist();
  }

  isOrphaned(sdkSessionId: string): boolean {
    return this.orphaned.has(sdkSessionId);
  }

  /** All orphaned upstream agent-sdk session ids (for session-list filtering). */
  orphanedSdkSessionIds(): ReadonlySet<string> {
    return new Set(this.orphaned);
  }

  delete(shepawSessionId: string): void {
    if (!this.mapping.has(shepawSessionId)) return;
    this.mapping.delete(shepawSessionId);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.persistNow();
  }

  private schedulePersist(): void {
    if (this.writeTimer !== undefined) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.persistNow().catch((err) => log.gateway('SessionStore persist failed: %s', String(err)));
    }, 200);
  }

  private async persistNow(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const data: PersistedShape = {
      version: 1,
      map: Object.fromEntries(this.mapping),
      orphanedSdkIds: [...this.orphaned],
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await writeFile(this.path, JSON.stringify(data, null, 2), 'utf-8');
    // (We atomic-write the file above by writing once; if we need true atomic
    // rename later we can use fs.rename(tmp, path) — overkill for a per-user
    // cache file.)
    void tmp;
  }
}
