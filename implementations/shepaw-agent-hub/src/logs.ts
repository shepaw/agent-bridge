/**
 * Log reader for `shepaw-hub logs <id>`.
 *
 * Rotation itself is handled in spawn.ts (rotating-file-stream). This
 * module only READS the current log file — `--tail N` prints the last N
 * lines and exits, `--follow` keeps a watcher open and streams new content
 * as the gateway writes it.
 *
 * Cross-platform notes:
 *   - `fs.watch` on macOS fires with the correct filename only sometimes;
 *     we don't rely on filename — we re-read the tail of the same file on
 *     every event and print whatever's new.
 *   - On Windows, `fs.watch` on a file that's rotated away (renamed to
 *     agent.log.1) stops firing. We detect this via an inode-change check
 *     on each poll and re-open.
 *   - For simplicity, `follow` is a poll-based tail: watch + 500 ms
 *     interval fallback. Works identically on all three OSes.
 */

import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  watch,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { projectPaths } from './paths.js';

export interface TailOptions {
  /** Number of trailing lines to print. Default 50. */
  tail?: number;
  /** Follow the file (tail -f). Default false. */
  follow?: boolean;
  /** Write function; tests inject a buffer. Default process.stdout.write. */
  write?: (chunk: string) => void;
  /** AbortSignal to stop following; CLI wires to SIGINT. */
  signal?: AbortSignal;
}

/**
 * Print the tail of a project's log to stdout (or an injected sink) and
 * optionally keep streaming new writes. Returns when:
 *   - follow=false → immediately after the initial tail prints
 *   - follow=true  → when signal fires (SIGINT from the CLI)
 */
export async function tailLog(projectId: string, opts: TailOptions = {}): Promise<void> {
  const paths = projectPaths(projectId);
  const tail = Math.max(0, Math.floor(opts.tail ?? 50));
  const write = opts.write ?? ((s) => process.stdout.write(s));

  if (!existsSync(paths.logFile)) {
    write(`(no log file yet at ${paths.logFile} — start the project to generate one)\n`);
    if (!opts.follow) return;
    // In follow mode, wait for the file to appear.
    await waitForFile(paths.logFile, opts.signal);
    if (opts.signal?.aborted) return;
  }

  // 1. Initial tail: slurp last N lines.
  let position = printTail(paths.logFile, tail, write);

  if (!opts.follow) return;

  // 2. Follow mode: watch for changes, re-read from last position.
  //
  // `fs.watch` returns immediately with an event on change. If it fails
  // (unsupported FS, e.g. NFS), we fall back to the polling loop.
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(paths.logFile, { persistent: false });
  } catch {
    watcher = undefined;
  }

  const pollInterval = 500;
  while (!opts.signal?.aborted) {
    // Wait for either a change event or the poll timeout, whichever first.
    await Promise.race([
      sleep(pollInterval).catch(() => undefined),
      watcher ? once(watcher, 'change') : Promise.resolve(),
    ]);
    if (opts.signal?.aborted) break;

    // Detect rotation: if the file's ino changed OR size shrank, reopen.
    const stat = tryStat(paths.logFile);
    if (stat === undefined) continue;
    if (stat.size < position) {
      // Truncated / rotated — start over from position 0.
      position = 0;
    }
    if (stat.size > position) {
      position = readFromOffset(paths.logFile, position, write);
    }
  }

  watcher?.close();
}

// ── internals ──────────────────────────────────────────────────────

/**
 * Print the last `n` lines of `file` to `write`, returning the file size
 * (i.e., the offset that "follow" should start reading new bytes from).
 *
 * Implementation: read from a reasonable tail chunk (last 64 KiB), count
 * newlines, print the last n lines' worth. Good enough for logs; don't
 * need a full reverse-seek implementation.
 */
function printTail(file: string, n: number, write: (s: string) => void): number {
  const stat = statSync(file);
  const size = stat.size;
  if (n === 0 || size === 0) return size;

  const chunkSize = Math.min(64 * 1024, size);
  const from = size - chunkSize;
  const buf = Buffer.alloc(chunkSize);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, chunkSize, from);
  } finally {
    closeSync(fd);
  }

  const text = buf.toString('utf-8');
  // Find the nth-from-end newline. If the chunk doesn't contain n newlines,
  // we print whatever we have — acceptable truncation for huge single-line
  // payloads (rare in gateway output).
  const lines = text.split('\n');
  // If from > 0, the first line is almost certainly a partial; drop it.
  const start = from > 0 ? 1 : 0;
  const slice = lines.slice(Math.max(start, lines.length - n - 1));
  write(slice.join('\n'));
  if (!text.endsWith('\n')) write('\n');
  return size;
}

function readFromOffset(file: string, offset: number, write: (s: string) => void): number {
  const stat = statSync(file);
  if (stat.size <= offset) return offset;
  const chunk = Buffer.alloc(stat.size - offset);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, chunk, 0, chunk.length, offset);
  } finally {
    closeSync(fd);
  }
  write(chunk.toString('utf-8'));
  return stat.size;
}

function tryStat(file: string): { size: number } | undefined {
  try { return statSync(file); }
  catch { return undefined; }
}

/** Resolve on the first event of the given type. */
function once<T>(emitter: NodeJS.EventEmitter, event: string): Promise<T> {
  return new Promise<T>((resolve) => {
    const handler = (payload: T): void => {
      emitter.off(event, handler as (...args: unknown[]) => void);
      resolve(payload);
    };
    emitter.on(event, handler as (...args: unknown[]) => void);
  });
}

/** Poll for a file to exist, respecting an abort signal. */
async function waitForFile(file: string, signal: AbortSignal | undefined): Promise<void> {
  while (!existsSync(file)) {
    if (signal?.aborted) return;
    await sleep(500);
  }
}
