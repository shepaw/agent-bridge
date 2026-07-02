/**
 * Supervision for the device-level tunnel router process.
 *
 * Mirrors the instance spawn model in `spawn.ts`: the router runs detached,
 * survives the hub CLI exiting, and records its pid in `gateway-state.json`.
 * There is exactly one router per host — it owns the single shared channel
 * tunnel and dispatches to every agent's loopback port.
 *
 * The router entry point is the compiled `gateway-daemon.js` sitting next to
 * this module's bundle. It is spawned as `node <gateway-daemon.js>`; all
 * config (router port, tunnel credentials) is read from `hub.json` by the
 * daemon itself, so nothing sensitive ends up in argv.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { DEFAULT_ROUTER_PORT, loadOrCreateHubConfig, type HubConfig } from './config.js';
import { gatewayLogFile, gatewayLogsDir, gatewayStatePath } from './paths.js';
import { isAlive, type StopResult } from './spawn.js';

export interface GatewayState {
  readonly pid: number;
  readonly routerPort: number;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly lastResult?: 'graceful' | 'hard' | 'crashed';
}

export function readGatewayState(): GatewayState | undefined {
  const path = gatewayStatePath();
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Gateway state at ${path} is not valid JSON: ${formatErr(err)}. Delete it and restart.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    pid: typeof obj.pid === 'number' ? obj.pid : 0,
    routerPort: typeof obj.routerPort === 'number' ? obj.routerPort : DEFAULT_ROUTER_PORT,
    startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : '',
    stoppedAt: typeof obj.stoppedAt === 'string' ? obj.stoppedAt : undefined,
    lastResult:
      obj.lastResult === 'graceful' || obj.lastResult === 'hard' || obj.lastResult === 'crashed'
        ? obj.lastResult
        : undefined,
  };
}

function writeGatewayState(state: GatewayState): void {
  const path = gatewayStatePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function isGatewayRunning(): boolean {
  const state = readGatewayState();
  return state !== undefined && state.pid > 0 && isAlive(state.pid);
}

/**
 * Start the tunnel router (detached). Idempotent: returns the existing pid if
 * already running. The router reads its tunnel + port config from `hub.json`.
 */
export async function startGatewayRouter(
  cfg: HubConfig = loadOrCreateHubConfig(),
): Promise<{ pid: number; alreadyRunning: boolean; routerPort: number }> {
  const prior = readGatewayState();
  const routerPort = cfg.gateway?.routerPort ?? DEFAULT_ROUTER_PORT;
  if (prior !== undefined && prior.pid > 0 && isAlive(prior.pid)) {
    return { pid: prior.pid, alreadyRunning: true, routerPort: prior.routerPort };
  }

  const daemonPath = resolveDaemonPath();
  mkdirSync(gatewayLogsDir(), { recursive: true, mode: 0o700 });
  const logFd = openSync(gatewayLogFile(), 'a');

  try {
    const child = nodeSpawn(process.execPath, [daemonPath], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();

    await sleep(300);
    if (!isAlive(child.pid!)) {
      throw new Error(
        `Tunnel router exited immediately. Check logs:\n  ${gatewayLogFile()}\n` +
          `Common causes: router port ${routerPort} already in use, bad channel credentials.`,
      );
    }

    writeGatewayState({ pid: child.pid!, routerPort, startedAt: new Date().toISOString() });
    return { pid: child.pid!, alreadyRunning: false, routerPort };
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
  }
}

/** Stop the tunnel router. */
export async function stopGatewayRouter(): Promise<StopResult> {
  const prior = readGatewayState();
  if (prior === undefined || prior.pid === 0 || !isAlive(prior.pid)) {
    if (prior !== undefined) {
      writeGatewayState({ ...prior, pid: 0, stoppedAt: new Date().toISOString(), lastResult: 'crashed' });
    }
    return 'not-running';
  }

  const pid = prior.pid;
  if (process.platform === 'win32') {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    writeGatewayState({ ...prior, pid: 0, stoppedAt: new Date().toISOString(), lastResult: 'hard' });
    return 'hard';
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    writeGatewayState({ ...prior, pid: 0, stoppedAt: new Date().toISOString(), lastResult: 'crashed' });
    return 'not-running';
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      writeGatewayState({ ...prior, pid: 0, stoppedAt: new Date().toISOString(), lastResult: 'graceful' });
      return 'graceful';
    }
    await sleep(50);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  writeGatewayState({ ...prior, pid: 0, stoppedAt: new Date().toISOString(), lastResult: 'hard' });
  return 'hard';
}

// ── internals ──────────────────────────────────────────────────────

function resolveDaemonPath(): string {
  // In the compiled bundle, gateway-daemon.js sits next to this module's
  // bundle (dist/index.js). In dev/test (tsx) it resolves to the sibling .ts.
  const url = new URL('./gateway-daemon.js', import.meta.url);
  const jsPath = fileURLToPath(url);
  if (existsSync(jsPath)) return jsPath;
  // Fallback for running straight from TypeScript sources.
  const tsPath = fileURLToPath(new URL('./gateway-daemon.ts', import.meta.url));
  if (existsSync(tsPath)) return tsPath;
  throw new Error(`Cannot locate gateway-daemon entry (looked for ${jsPath}).`);
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
