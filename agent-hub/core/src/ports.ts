/**
 * Port allocation for `shepaw-hub project add`.
 *
 * Requirements:
 *   - Default starting point: 8090 (matches the gateways' default).
 *   - Skip ports already claimed by other registered projects (hub-internal).
 *   - Skip ports that are actually bound on the local machine right now
 *     (OS-level collision). This catches cases where the user has ANOTHER
 *     service on 8091 that hub doesn't know about.
 *   - Return a deterministic value for tests via `probe` injection.
 *
 * We deliberately do NOT keep the port reserved between allocate and
 * project-add persist — the race window is milliseconds and the failure
 * mode is "two projects get the same port, start fails with EADDRINUSE".
 * Acceptable on a single-user CLI.
 */

import { createServer } from 'node:net';

export interface FindPortOptions {
  /** First port to try (inclusive). Default 8090. */
  start?: number;
  /** Last port to try (inclusive). Default 9090 — 1000-port search space is plenty for 99.99% of hosts. */
  end?: number;
  /** Ports already claimed by other hub projects. The caller passes config.projects.map(p=>p.port). */
  reserved?: ReadonlyArray<number>;
  /**
   * Override the bind-check. Tests inject a fake prober that says "port N is
   * busy" without actually touching the network. Production uses
   * `probeBindable` which opens+closes a socket.
   */
  probe?: (port: number) => Promise<boolean>;
}

/**
 * Find the lowest free TCP port in [start, end] that is neither reserved by
 * the hub nor currently bound on the local machine.
 *
 * Throws `NoFreePortError` if the search exhausts the range — 1000 ports is
 * a lot on a single host, so hitting this usually means the user has
 * misconfigured `--port-range` rather than genuinely running out of ports.
 */
export async function nextFreePort(opts: FindPortOptions = {}): Promise<number> {
  const start = opts.start ?? 8090;
  const end = opts.end ?? 9090;
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new Error(`Invalid start port: ${start}`);
  }
  if (!Number.isInteger(end) || end < start || end > 65535) {
    throw new Error(`Invalid end port: ${end} (must be >= start)`);
  }

  const reserved = new Set(opts.reserved ?? []);
  const probe = opts.probe ?? probeBindable;

  for (let p = start; p <= end; p++) {
    if (reserved.has(p)) continue;
    if (await probe(p)) return p;
  }
  throw new NoFreePortError(
    `No free port in range [${start}..${end}]. ` +
      `Registered projects: ${reserved.size}. ` +
      `Consider specifying --port explicitly or widening --port-range.`,
  );
}

/**
 * Check whether `port` can be bound on 127.0.0.1 right now. Returns true if
 * yes (port is free), false if taken. Binds to loopback on purpose — a port
 * that's free on 0.0.0.0 but occupied on 127.0.0.1 would still collide when
 * the gateway tries to listen with its default host=127.0.0.1.
 *
 * Uses `exclusive: true` so the bind fails on any existing listener, even
 * one with SO_REUSEADDR set — that matches the gateway's behavior.
 */
export function probeBindable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    const cleanup = (): void => {
      try {
        server.removeAllListeners();
        server.close();
      } catch {
        /* ignore — best effort */
      }
    };

    server.once('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      // EADDRINUSE / EACCES → port unusable. Any other error is
      // infrastructure-level (e.g. EMFILE), and treating it as "not free"
      // is the safe default.
      resolve(false);
      // Silence unused-var lint.
      void err;
    });

    server.once('listening', () => {
      cleanup();
      resolve(true);
    });

    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

export class NoFreePortError extends Error {
  override readonly name = 'NoFreePortError';
  constructor(message: string) { super(message); }
}
