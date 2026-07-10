import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addInstance, loadOrCreateHubConfig, saveHubConfig, type InstanceConfig } from '../src/config.js';
import { instancePaths } from '../src/paths.js';
import { restartAllInstances, restartInstance, ensureInstanceDir, writeState } from '../src/spawn.js';

let home: string;
let prevHome: string | undefined;
const children: ReturnType<typeof spawn>[] = [];

function baseInstance(id: string, port: number, cwd: string): InstanceConfig {
  return {
    id,
    engine: 'claude-code',
    cwd,
    host: '127.0.0.1',
    port,
    baseUrl: '',
    extraArgs: [],
  };
}

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-spawn-restart-'));
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

describe('restartInstance', () => {
  it('skips instances that are not running', async () => {
    const instance = baseInstance('idle', 18801, home);
    const result = await restartInstance(instance);
    expect(result).toEqual({ id: 'idle', wasRunning: false });
  });

  it('returns an error when state.json is corrupted instead of throwing', async () => {
    const instance = baseInstance('broken', 18802, home);
    ensureInstanceDir(instance.id);
    const paths = instancePaths(instance.id);
    writeFileSync(paths.statePath, '{not valid json', { mode: 0o600 });

    const result = await restartInstance(instance);
    expect(result.id).toBe('broken');
    expect(result.wasRunning).toBe(false);
    expect(result.error).toMatch(/not valid JSON/i);
  });

  it('leaves the instance stopped when start fails after a successful stop', async () => {
    const child = spawnIdleChild();
    const instance = baseInstance('runner', 18803, join(home, 'missing-cwd'));
    ensureInstanceDir(instance.id);
    const paths = instancePaths(instance.id);
    writeState(paths.statePath, {
      pid: child.pid!,
      port: instance.port,
      startedAt: new Date().toISOString(),
    });

    const result = await restartInstance(instance);

    expect(result.wasRunning).toBe(true);
    expect(result.error).toMatch(/cwd does not exist/i);
    expect(result.startResult).toBeUndefined();
  });
});

describe('restartAllInstances', () => {
  it('skips all stopped instances without errors', async () => {
    let cfg = loadOrCreateHubConfig();
    cfg = addInstance(cfg, baseInstance('alpha', 18811, home));
    cfg = addInstance(cfg, baseInstance('beta', 18812, home));
    saveHubConfig(cfg.path, cfg);

    const results = await restartAllInstances();
    expect(results).toEqual([
      { id: 'alpha', wasRunning: false },
      { id: 'beta', wasRunning: false },
    ]);
  });

  it('continues restarting other instances when one has corrupted state', async () => {
    let cfg = loadOrCreateHubConfig();
    cfg = addInstance(cfg, baseInstance('good', 18821, home));
    cfg = addInstance(cfg, baseInstance('bad', 18822, home));
    saveHubConfig(cfg.path, cfg);

    ensureInstanceDir('bad');
    writeFileSync(instancePaths('bad').statePath, '<<<', { mode: 0o600 });

    const results = await restartAllInstances();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: 'good', wasRunning: false });
    expect(results[1]?.id).toBe('bad');
    expect(results[1]?.error).toMatch(/not valid JSON/i);
  });
});
