import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dashboardStatePath, hubConfigPath, restartStatePath } from '../src/paths.js';
import {
  acquireRestartLock,
  readDashboardState,
  readRestartState,
  releaseRestartLock,
  runRestartOrchestrator,
  writeDashboardState,
} from '../src/restart.js';

let home: string;
let prevHome: string | undefined;
const children: ReturnType<typeof spawn>[] = [];

function spawnIdleChild(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  children.push(child);
  return child;
}

function stopChild(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid);
    } catch {
      // already exited
    }
  }
}

/** Resolves once the child has actually exited (and been reaped by the parent). */
function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-restart-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  for (const child of children.splice(0)) {
    stopChild(child);
  }
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('dashboard state', () => {
  it('returns undefined when no state file exists', () => {
    expect(readDashboardState()).toBeUndefined();
  });

  it('round-trips a state write', () => {
    writeDashboardState({ pid: 4242, host: '127.0.0.1', port: 4000, scheme: 'http', supervised: true });
    expect(readDashboardState()).toEqual({
      pid: 4242,
      host: '127.0.0.1',
      port: 4000,
      scheme: 'http',
      supervised: true,
    });
  });

  it('treats a malformed file as absent', () => {
    writeFileSync(dashboardStatePath(), '{not json', { mode: 0o600 });
    expect(readDashboardState()).toBeUndefined();
  });

  it('normalizes missing/invalid fields', () => {
    writeFileSync(dashboardStatePath(), JSON.stringify({ pid: 'nope', scheme: 'https' }), { mode: 0o600 });
    const state = readDashboardState();
    expect(state?.pid).toBe(0);
    expect(state?.host).toBe('127.0.0.1');
    expect(state?.port).toBe(0);
    expect(state?.scheme).toBe('https');
    expect(state?.supervised).toBe(false);
  });
});

describe('restart lock', () => {
  it('acquires and releases', () => {
    acquireRestartLock({});
    expect(readRestartState()).toMatchObject({ pid: process.pid });
    releaseRestartLock();
    expect(readRestartState()).toBeUndefined();
  });

  it('rejects a second acquisition while a live daemon holds it', () => {
    const holder = spawnIdleChild();
    writeFileSync(
      restartStatePath(),
      JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), plan: {} }),
      { mode: 0o600 },
    );
    expect(() => acquireRestartLock({})).toThrow(/already in progress/);
  });

  it('reclaims a stale lock held by a dead pid', async () => {
    const child = spawnIdleChild();
    const pid = child.pid!;
    stopChild(child);
    await waitForExit(child);

    writeFileSync(
      restartStatePath(),
      JSON.stringify({ pid, startedAt: new Date().toISOString(), plan: {} }),
      { mode: 0o600 },
    );
    acquireRestartLock({});
    expect(readRestartState()).toMatchObject({ pid: process.pid });
  });

  it('reclaims a lock whose TTL expired even when the pid is still alive', () => {
    const holder = spawnIdleChild();
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    writeFileSync(
      restartStatePath(),
      JSON.stringify({ pid: holder.pid, startedAt: old, plan: {} }),
      { mode: 0o600 },
    );
    acquireRestartLock({});
    expect(readRestartState()).toMatchObject({ pid: process.pid });
  });
});

describe('runRestartOrchestrator', () => {
  it('skips every phase when all are disabled, without side effects', async () => {
    const report = await runRestartOrchestrator({
      dashboard: false,
      instances: false,
      peer: false,
      gateway: false,
    });
    expect(report.failed).toBe(false);
    expect(report.phases).toEqual([
      { phase: 'upgrade', status: 'skipped', detail: 'not requested' },
      { phase: 'dashboard', status: 'skipped', detail: 'not requested' },
      { phase: 'instances', status: 'skipped', detail: 'not requested' },
      { phase: 'peer', status: 'skipped', detail: 'not requested' },
      { phase: 'gateway', status: 'skipped', detail: 'not requested' },
    ]);
    // No config or state files should have been created.
    expect(existsSync(hubConfigPath())).toBe(false);
    expect(existsSync(dashboardStatePath())).toBe(false);
  });

  it('skips the dashboard phase when there is no dashboard state', async () => {
    const report = await runRestartOrchestrator({ instances: false, peer: false, gateway: false });
    expect(report.failed).toBe(false);
    const phase = report.phases.find((p) => p.phase === 'dashboard');
    expect(phase?.status).toBe('skipped');
    expect(phase?.detail).toMatch(/no dashboard-state/i);
  });

  it('skips the dashboard phase when the port is not reachable', async () => {
    // Port 1 is never listening; the TCP probe fails fast, so the restart is
    // skipped before any pid is signalled (pid 1 must never be touched).
    writeDashboardState({ pid: 1, host: '127.0.0.1', port: 1, scheme: 'http', supervised: true });
    const report = await runRestartOrchestrator({ instances: false, peer: false, gateway: false });
    expect(report.failed).toBe(false);
    const phase = report.phases.find((p) => p.phase === 'dashboard');
    expect(phase?.status).toBe('skipped');
    expect(phase?.detail).toMatch(/not reachable/i);
  });

  it('skips instances/peer/gateway when nothing is configured or running', async () => {
    const report = await runRestartOrchestrator({ dashboard: false });
    expect(report.failed).toBe(false);
    const byPhase = new Map(report.phases.map((p) => [p.phase, p.status]));
    expect(byPhase.get('instances')).toBe('skipped');
    expect(byPhase.get('peer')).toBe('skipped');
    expect(byPhase.get('gateway')).toBe('skipped');
  });
});
