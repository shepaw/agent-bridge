/**
 * One-shot restart of every hub service, in a fixed order:
 *
 *   1. (optional) `npm install -g` upgrade of the hub package itself
 *   2. dashboard — graceful HTTP restart (or SIGTERM) of the supervised child
 *   3. instances — restart every running instance gateway
 *   4. peer      — restart the device-level peer service (only if running)
 *   5. gateway   — restart the shared tunnel router (only if configured)
 *
 * The trigger can come from a process that is about to be killed — the agent
 * running inside an instance, or the dashboard itself — so the actual work runs
 * in a detached daemon (`restart-daemon.ts`) spawned by `spawnRestartOrchestrator`.
 * The same sequence also runs in-process via `runRestartOrchestrator` for the
 * foreground CLI path.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadOrCreateHubConfig } from './config.js';
import { startGatewayRouter, stopGatewayRouter } from './gateway-process.js';
import { closeInstanceAcpRpcClient } from './instance-acp-rpc.js';
import { dashboardStatePath, restartLogFile, restartLogsDir, restartStatePath } from './paths.js';
import { isPeerServiceRunning, startPeerService, stopPeerService } from './peer/peer-process.js';
import { installLatestFromNpm } from './self-update.js';
import { isAlive, restartAllInstances } from './spawn.js';

/** Process state of the supervised dashboard web child, written on each respawn. */
export interface DashboardState {
  readonly pid: number;
  readonly host: string;
  /** `0.0.0.0`/`::` are normalized to a connectable loopback address at write time. */
  readonly port: number;
  readonly scheme: 'http' | 'https';
  readonly supervised: boolean;
}

/** Which phases a restart run performs. All default on except `upgrade`. */
export type RestartPlan = {
  dashboard?: boolean;
  instances?: boolean;
  peer?: boolean;
  gateway?: boolean;
  upgrade?: boolean;
};

const RESTART_DEFAULTS: Required<RestartPlan> = {
  dashboard: true,
  instances: true,
  peer: true,
  gateway: true,
  upgrade: false,
};

export type RestartPhaseName = 'upgrade' | 'dashboard' | 'instances' | 'peer' | 'gateway';
export type RestartPhaseStatus = 'skipped' | 'ok' | 'failed';

export interface RestartPhaseReport {
  readonly phase: RestartPhaseName;
  readonly status: RestartPhaseStatus;
  readonly detail?: string;
}

export interface RestartReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly failed: boolean;
  readonly phases: RestartPhaseReport[];
}

/** Lock + plan written by the orchestrator daemon; `pid` is the daemon's own. */
export interface RestartState {
  readonly pid: number;
  readonly startedAt: string;
  readonly plan: RestartPlan;
}

/** Locks held by a dead daemon or older than this are considered stale. */
const RESTART_LOCK_STALE_MS = 15 * 60 * 1000;

export function readDashboardState(): DashboardState | undefined {
  const path = dashboardStatePath();
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Malformed (e.g. torn write) — treat as absent; the next web child respawn
    // rewrites it, and the port probe below decides whether a restart is needed.
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    pid: typeof obj.pid === 'number' ? obj.pid : 0,
    host: typeof obj.host === 'string' && obj.host.length > 0 ? obj.host : '127.0.0.1',
    port: typeof obj.port === 'number' ? obj.port : 0,
    scheme: obj.scheme === 'https' ? 'https' : 'http',
    supervised: obj.supervised === true,
  };
}

export function writeDashboardState(state: DashboardState): void {
  const path = dashboardStatePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function readRestartState(): RestartState | undefined {
  const path = restartStatePath();
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    pid: typeof obj.pid === 'number' ? obj.pid : 0,
    startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : '',
    plan: typeof obj.plan === 'object' && obj.plan !== null ? (obj.plan as RestartPlan) : {},
  };
}

/** Atomically acquire the restart lock. Throws when a live restart is running. */
export function acquireRestartLock(plan: RestartPlan): void {
  const lockPath = restartStatePath();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString(), plan },
    null,
    2,
  );

  const write = (): void => {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, payload, { mode: 0o600 });
    } finally {
      closeSync(fd);
    }
  };

  try {
    write();
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const existing = readRestartState();
  const stale =
    existing === undefined ||
    !isAlive(existing.pid) ||
    (existing.startedAt !== '' && Date.now() - Date.parse(existing.startedAt) > RESTART_LOCK_STALE_MS);
  if (!stale) {
    throw new Error(`A restart is already in progress (pid ${existing?.pid ?? 'unknown'}).`);
  }

  // Stale lock (dead daemon or TTL expired) — reclaim it once.
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
  try {
    write();
  } catch (err2) {
    if ((err2 as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A restart is already in progress (pid ${existing?.pid ?? 'unknown'}).`);
    }
    throw err2;
  }
}

export function releaseRestartLock(): void {
  try {
    unlinkSync(restartStatePath());
  } catch {
    /* ignore */
  }
}

/**
 * Run the full restart sequence in this process. Returns a per-phase report;
 * `failed` is true if any phase failed. When `plan.upgrade` fails, the
 * remaining phases are aborted (never restart services onto a broken upgrade).
 */
export async function runRestartOrchestrator(plan: RestartPlan = {}): Promise<RestartReport> {
  const p: Required<RestartPlan> = { ...RESTART_DEFAULTS, ...plan };
  const startedAt = new Date().toISOString();
  const phases: RestartPhaseReport[] = [];

  const push = (phase: RestartPhaseName, status: RestartPhaseStatus, detail?: string): void => {
    phases.push({ phase, status, detail });
    log(`[${phase}] ${status}${detail !== undefined ? ` — ${detail}` : ''}`);
  };
  const fail = (phase: RestartPhaseName, detail: string): void => {
    push(phase, 'failed', detail);
  };

  // ── 1. upgrade (aborts everything on failure) ─────────────────────
  if (p.upgrade) {
    log('Upgrading shepaw-agent-hub from npm…');
    try {
      const code = await installLatestFromNpm();
      if (code !== 0) {
        fail('upgrade', `npm install exited ${code} — aborting remaining phases`);
        return {
          startedAt,
          finishedAt: new Date().toISOString(),
          failed: true,
          phases,
        };
      }
      push('upgrade', 'ok', 'npm install succeeded');
    } catch (err) {
      fail('upgrade', `npm install failed: ${formatErr(err)} — aborting remaining phases`);
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        failed: true,
        phases,
      };
    }
  } else {
    push('upgrade', 'skipped', 'not requested');
  }

  // ── 2. dashboard ───────────────────────────────────────────────────
  if (p.dashboard) {
    const state = readDashboardState();
    if (state === undefined) {
      push('dashboard', 'skipped', 'no dashboard-state.json — dashboard not started via `shepaw-hub web`');
    } else if (state.port <= 0) {
      push('dashboard', 'skipped', 'dashboard-state.json has no port (--port 0 unsupported for restart)');
    } else {
      const up = await isPortOpen(state.host, state.port);
      if (!up) {
        push('dashboard', 'skipped', `dashboard not reachable on ${state.host}:${state.port} — nothing to restart`);
      } else if (!state.supervised) {
        push('dashboard', 'skipped', 'dashboard not supervised — refusing to kill it');
      } else {
        let triggered = false;
        const token = process.env.SHEPAW_HUB_TOKEN?.trim();
        if (state.scheme === 'http' && token !== undefined && token.length > 0) {
          triggered = await requestDashboardRestart(state);
        }
        if (!triggered && state.pid > 0 && isAlive(state.pid)) {
          try {
            process.kill(state.pid, 'SIGTERM');
            triggered = true;
          } catch {
            triggered = false;
          }
        }
        if (!triggered) {
          fail('dashboard', 'dashboard is up but cannot be restarted (no pid, no token, or https-only)');
        } else {
          const back = await waitForPort(state.host, state.port, 20_000);
          if (back) {
            push('dashboard', 'ok', `restarted on ${state.host}:${state.port}`);
          } else {
            fail('dashboard', `did not come back on ${state.host}:${state.port} within 20s`);
          }
        }
      }
    }
  } else {
    push('dashboard', 'skipped', 'not requested');
  }

  // ── 3. instances ──────────────────────────────────────────────────
  if (p.instances) {
    try {
      const results = await restartAllInstances({ onStopped: closeInstanceAcpRpcClient });
      // The onStopped hook is a no-op in the daemon process (the ACP client pool
      // lives in the web child); instance gateways self-heal via lazy reconnect.
      const running = results.filter((r) => r.wasRunning);
      if (running.length === 0) {
        push('instances', 'skipped', 'no running instances');
      } else {
        const failed = running.filter((r) => r.error !== undefined);
        push(
          'instances',
          failed.length > 0 ? 'failed' : 'ok',
          `${running.length} instance(s) restarted${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
        );
      }
    } catch (err) {
      fail('instances', formatErr(err));
    }
  } else {
    push('instances', 'skipped', 'not requested');
  }

  // ── 4. peer service (restart only if it is running) ────────────────
  if (p.peer) {
    try {
      if (!isPeerServiceRunning()) {
        push('peer', 'skipped', 'peer service not running — not starting it');
      } else {
        const stop = await stopPeerService();
        const started = await startPeerService();
        push(
          'peer',
          'ok',
          started.alreadyRunning
            ? `already running after stop (${stop}) — restarted by dashboard respawn?`
            : `stopped (${stop}), restarted (pid ${started.pid})`,
        );
      }
    } catch (err) {
      fail('peer', formatErr(err));
    }
  } else {
    push('peer', 'skipped', 'not requested');
  }

  // ── 5. gateway (shared tunnel router) ──────────────────────────────
  if (p.gateway) {
    const cfg = loadOrCreateHubConfig();
    if (cfg.gateway?.tunnel === undefined) {
      push('gateway', 'skipped', 'no shared tunnel configured');
    } else {
      try {
        const stop = await stopGatewayRouter(); // no-op when not running
        const started = await startGatewayRouter(cfg);
        push(
          'gateway',
          'ok',
          started.alreadyRunning
            ? `already running after stop (${stop})`
            : `stopped (${stop}), restarted (pid ${started.pid})`,
        );
      } catch (err) {
        fail('gateway', formatErr(err));
      }
    }
  } else {
    push('gateway', 'skipped', 'not requested');
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    failed: phases.some((ph) => ph.status === 'failed'),
    phases,
  };
}

export interface SpawnRestartResult {
  readonly pid: number;
  readonly logFile: string;
}

/**
 * Spawn the restart orchestrator as a detached daemon and return immediately.
 * The daemon is authoritative for the restart lock; this call only does an
 * advisory pre-check so the CLI/API can fail fast on the common double-invoke.
 */
export function spawnRestartOrchestrator(plan: RestartPlan = {}): SpawnRestartResult {
  const existing = readRestartState();
  if (existing !== undefined && existing.pid > 0 && isAlive(existing.pid)) {
    throw new Error(`A restart is already in progress (pid ${existing.pid}).`);
  }

  const daemonPath = resolveRestartDaemonPath();
  mkdirSync(restartLogsDir(), { recursive: true, mode: 0o700 });
  const logFd = openSync(restartLogFile(), 'a');

  const args: string[] = [];
  if (plan.dashboard === false) args.push('--skip-dashboard');
  if (plan.instances === false) args.push('--no-instances');
  if (plan.peer === false) args.push('--no-peer');
  if (plan.gateway === false) args.push('--no-gateway');
  if (plan.upgrade === true) args.push('--upgrade');

  // The daemon is its own process — drop the supervised marker so it doesn't
  // leak into the peer/gateway daemons it spawns downstream.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SHEPAW_HUB_SUPERVISED;

  try {
    const child = nodeSpawn(process.execPath, [daemonPath, ...args], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env,
    });
    child.unref();
    return { pid: child.pid!, logFile: restartLogFile() };
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
  }
}

// ── internals ──────────────────────────────────────────────────────

function resolveRestartDaemonPath(): string {
  // In the compiled bundle, restart-daemon.js sits next to this module's
  // bundle (dist/index.js). In dev/test (tsx) it resolves to the sibling .ts.
  const url = new URL('./restart-daemon.js', import.meta.url);
  const jsPath = fileURLToPath(url);
  if (existsSync(jsPath)) return jsPath;
  const tsPath = fileURLToPath(new URL('./restart-daemon.ts', import.meta.url));
  if (existsSync(tsPath)) return tsPath;
  throw new Error(`Cannot locate restart-daemon entry (looked for ${jsPath}).`);
}

/** Graceful HTTP restart — only works when the triggering env has the token. */
async function requestDashboardRestart(state: DashboardState): Promise<boolean> {
  const token = process.env.SHEPAW_HUB_TOKEN?.trim();
  if (state.scheme !== 'http' || !token) return false;
  try {
    const res = await fetch(`http://${state.host}:${state.port}/api/system/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Raw TCP probe — works for both http and https (avoids self-signed cert errors). */
function isPortOpen(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = netConnect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(host, port)) return true;
    await sleep(250);
  }
  return false;
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
