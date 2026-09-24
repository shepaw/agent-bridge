/**
 * Atomic replacement for the small JSON state files under the hub root.
 *
 * The temp name carries a random suffix because more than one process holds
 * these files — the hub CLI and the peer daemon both persist turn and approval
 * state. With a fixed `<path>.tmp` the two writers collide: whoever renames
 * first removes the file the other is still about to chmod, and the loser dies
 * on an ENOENT from an operation that cannot legitimately fail.
 */

import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export function atomicWriteFile(dest: string, data: string, mode = 0o600): void {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(dest)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, data, { mode });
  if (process.platform !== 'win32') chmodSync(tmp, mode);
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
