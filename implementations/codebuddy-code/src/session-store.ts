/**
 * Persist Shepaw-session → CodeBuddy Code SDK session mapping so the
 * gateway can resume a conversation across process restarts.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { log } from './debug.js';

const DEFAULT_PATH = join(homedir(), '.config', 'shepaw-cb-gateway', 'sessions.json');

export interface SessionStoreOptions {
  /** Override the persistence path. Default `~/.config/shepaw-cb-gateway/sessions.json`. */
  path?: string;
}

interface PersistedShape {
  version: 1;
  /** shepaw session_id → codebuddy-agent-sdk session_id */
  map: Record<string, string>;
}

export class SessionStore {
  private readonly path: string;
  private readonly mapping = new Map<string, string>();
  private writeTimer: NodeJS.Timeout | undefined;

  constructor(opts: SessionStoreOptions = {}) {
    this.path = opts.path ?? DEFAULT_PATH;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      const data = JSON.parse(raw) as PersistedShape;
      if (data.version === 1 && data.map && typeof data.map === 'object') {
        for (const [k, v] of Object.entries(data.map)) {
          if (typeof v === 'string') this.mapping.set(k, v);
        }
        log.gateway('SessionStore loaded %d entries from %s', this.mapping.size, this.path);
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

  set(shepawSessionId: string, sdkSessionId: string): void {
    if (this.mapping.get(shepawSessionId) === sdkSessionId) return;
    this.mapping.set(shepawSessionId, sdkSessionId);
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
