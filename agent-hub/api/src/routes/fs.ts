/**
 * Filesystem browse routes for the Hub dashboard.
 *
 * GET /api/fs/browse?path=  — list subdirectories on the Hub host
 */

import { Router, type Request, type Response } from 'express';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const fsRouter = Router();

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

/** Expand ~ and resolve to an absolute path. */
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
      // Follow only real directories; skip symlinks that aren't directories and skip files.
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

fsRouter.get('/browse', async (req: Request, res: Response) => {
  try {
    const raw = typeof req.query.path === 'string' ? req.query.path : undefined;
    const result = await browseDirectory(raw);
    res.json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});
