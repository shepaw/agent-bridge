/**
 * Host filesystem browse helpers (Hub machine absolute paths).
 *
 * Used by the dashboard HTTP API and peer `fs_browse_req` so paired apps can
 * pick cwd / additionalDirectories the same way as the Hub UI.
 */

import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface FsBrowseEntry {
  name: string;
  path: string;
  type: 'dir';
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
}

/** Expand ~ and resolve to an absolute path. Empty → user home. */
export function resolveBrowsePath(raw: string | undefined): string {
  const input = (raw ?? '').trim();
  if (input.length === 0) return homedir();

  let expanded = input;
  if (input === '~') {
    expanded = homedir();
  } else if (input.startsWith('~/') || input.startsWith('~\\')) {
    expanded = join(homedir(), input.slice(2));
  }

  const absolute = resolve(expanded);
  if (!isAbsolute(absolute)) {
    throw new Error(`Resolved path is not absolute: ${absolute}`);
  }
  return absolute;
}

function parentOf(absolutePath: string): string | null {
  const parent = dirname(absolutePath);
  if (parent === absolutePath) return null;
  return parent;
}

export async function browseDirectory(rawPath: string | undefined): Promise<FsBrowseResult> {
  const absolute = resolveBrowsePath(rawPath);

  let st;
  try {
    st = await fsp.stat(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw Object.assign(new Error(`Directory does not exist: ${absolute}`), { status: 400 });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw Object.assign(new Error(`Permission denied: ${absolute}`), { status: 400 });
    }
    throw err;
  }

  if (!st.isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${absolute}`), { status: 400 });
  }

  let names: string[];
  try {
    names = await fsp.readdir(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw Object.assign(new Error(`Permission denied: ${absolute}`), { status: 400 });
    }
    throw err;
  }

  const entries: FsBrowseEntry[] = [];
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const childPath = join(absolute, name);
    try {
      const childSt = await fsp.lstat(childPath);
      if (childSt.isSymbolicLink()) {
        try {
          const target = await fsp.stat(childPath);
          if (!target.isDirectory()) continue;
        } catch {
          continue;
        }
      } else if (!childSt.isDirectory()) {
        continue;
      }
      entries.push({ name, path: childPath, type: 'dir' });
    } catch {
      // Skip unreadable entries
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    path: absolute,
    parent: parentOf(absolute),
    entries,
  };
}

/** Peer control-plane: list host directories for workspace pickers. */
export async function handleFsBrowseReq(
  obj: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : '';
  const rawPath = typeof obj.path === 'string' ? obj.path : undefined;
  try {
    const result = await browseDirectory(rawPath);
    return {
      type: 'fs_browse_resp',
      request_id: requestId,
      ok: true,
      path: result.path,
      parent: result.parent,
      entries: result.entries,
    };
  } catch (err) {
    return {
      type: 'fs_browse_resp',
      request_id: requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
