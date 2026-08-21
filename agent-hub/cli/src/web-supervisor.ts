/**
 * Supervisor for `shepaw-hub web`: spawns the dashboard (API + UI) as a child
 * process and keeps it alive. This is what makes the dashboard's one-click
 * upgrade + restart work — after `npm install -g` replaces the package on
 * disk, the restart endpoint exits the child and the supervisor respawns it,
 * loading the new code.
 *
 * The child is spawned as `node <cli.js> web --child <original args>`, with
 * the user's own argv passed through verbatim. Environment flags tell the
 * child (and the /api/system routes) that it is supervised:
 *
 *   SHEPAW_HUB_SUPERVISED=1           restart endpoint is allowed
 *   SHEPAW_HUB_INSTALLED_VERSION=x    exact installed version (re-derived per
 *                                     respawn so a post-upgrade restart reports
 *                                     the new version)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readInstalledVersion } from './self-update.js';

export interface WebOptions {
  port: number | string;
  host: string;
  tlsCert?: string;
  tlsKey?: string;
  open?: boolean;
  peer?: boolean;
  gateway?: boolean;
  child?: boolean;
}

/**
 * Extract the dashboard URL from accumulated child output. The line must be
 * complete (newline-terminated) so a chunk split mid-URL cannot open a
 * truncated address; the child prints the ready line via console.log.
 */
export function extractDashboardUrl(accumulated: string): string | undefined {
  const m = /Dashboard ready: (\S+)\r?\n/.exec(accumulated);
  return m ? m[1] : undefined;
}

/**
 * Crash-guard predicate: an exit counts as a crash only when it is not the
 * intentional `process.exit(0)` used by the restart endpoint, and it happened
 * within `stopLimitMs` of spawn. Long-lived exits (normal restarts) never
 * count and reset the fast-crash counter.
 */
export function shouldCountAsCrash(
  code: number | null,
  signal: NodeJS.Signals | null,
  elapsedMs: number,
  stopLimitMs = 3000,
): boolean {
  if (code === 0 && signal === null) return false;
  return elapsedMs < stopLimitMs;
}

export async function runWebSupervisor(opts: WebOptions): Promise<void> {
  const cliEntry = fileURLToPath(import.meta.url);
  // Everything the user passed after `web` — forwarded verbatim to the child.
  const userArgs = process.argv.slice(3);
  const shouldOpen = opts.open !== false;

  // Refuse early (same check as the child) so a bad bind doesn't crash-loop.
  const authToken = process.env.SHEPAW_HUB_TOKEN?.trim();
  if ((opts.host === '0.0.0.0' || opts.host === '::') && !authToken) {
    console.error(
      'Refusing to start: set SHEPAW_HUB_TOKEN before using --host 0.0.0.0',
    );
    process.exit(1);
  }

  let child: ChildProcess | null = null;
  let stopping = false;
  let fastCrashes = 0;
  let browserOpened = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[shepaw-hub] Stopping dashboard…');
    if (child && !child.killed) child.kill('SIGTERM');
    // Fallback if the child is stuck (e.g. mid npm install) — don't hang the
    // terminal. Unref'd so it can't keep the process alive on its own.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const spawnChild = () => {
    if (stopping) return;
    const installed = readInstalledVersion();
    console.log(`[shepaw-hub] Starting dashboard (installed ${installed})…`);
    child = spawn(process.execPath, [cliEntry, 'web', '--child', ...userArgs], {
      // stdin inherited so `npm install -g` prompts (if any) still work
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SHEPAW_HUB_SUPERVISED: '1',
        SHEPAW_HUB_INSTALLED_VERSION: installed,
      },
    });
    const born = Date.now();
    let lineBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      if (!browserOpened && shouldOpen) {
        lineBuf += chunk.toString();
        const url = extractDashboardUrl(lineBuf);
        if (url !== undefined) {
          browserOpened = true;
          void import('open').then(({ default: open }) => open(url)).catch(() => {});
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', (err) => {
      console.error(`[shepaw-hub] failed to spawn dashboard child: ${err.message}`);
      child = null;
      if (!stopping) setTimeout(spawnChild, 1000);
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) {
        process.exit(0);
        return;
      }
      const crashed = shouldCountAsCrash(code, signal, Date.now() - born);
      if (crashed) {
        fastCrashes += 1;
        if (fastCrashes >= 5) {
          console.error(
            '[shepaw-hub] dashboard exited 5 times within seconds of starting; ' +
              'giving up. Run `shepaw-hub doctor`.',
          );
          process.exit(1);
        }
      } else {
        fastCrashes = 0;
      }
      console.error(
        `[shepaw-hub] dashboard exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}); restarting…`,
      );
      // Backoff also gives the TCP port time to release before rebinding.
      setTimeout(spawnChild, 400);
    });
  };

  spawnChild();
}
