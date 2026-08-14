/**
 * Coverage for per-engine overrides: disabled-engine rejection at add/start,
 * engine-default env merge precedence (instance overrides engine), and
 * persistence round-trip.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addInstance,
  deleteEngineEnvVar,
  engineEnvVarKeys,
  isEngineDisabled,
  loadOrCreateHubConfig,
  resolveEngineEnvVars,
  setEngineEnvVar,
  setEngineOverride,
  updateCustomEngineInHub,
  updateInstance,
} from '../src/config.js';
import { addCustomEngineToHub } from '../src/config.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-hub-test-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

let nextPort = 19000;

function addTestInstance(id: string, engine = 'claude-code'): void {
  let cfg = loadOrCreateHubConfig();
  cfg = addInstance(cfg, {
    id,
    label: id,
    engine,
    cwd: home,
    host: '127.0.0.1',
    port: nextPort++,
    baseUrl: '',
    extraArgs: [],
    createdAt: new Date().toISOString(),
  });
  loadOrCreateHubConfig(); // no-op; addInstance persists
}

describe('instance sessionMode', () => {
  it('fills the engine default when omitted', () => {
    addTestInstance('p1', 'cursor');
    expect(loadOrCreateHubConfig().instances.find((p) => p.id === 'p1')?.sessionMode).toBe('auto-review');
  });

  it('persists an explicit mode and rejects unknown catalog ids', () => {
    addTestInstance('p1', 'claude-code');
    let cfg = loadOrCreateHubConfig();
    cfg = updateInstance(cfg, 'p1', { sessionMode: 'bypassPermissions' });
    expect(loadOrCreateHubConfig().instances.find((p) => p.id === 'p1')?.sessionMode).toBe('bypassPermissions');
    expect(() => updateInstance(cfg, 'p1', { sessionMode: 'yolo' })).toThrow(/Unknown session mode/);
  });

  it('allowUnknownSessionMode persists a live-advertised id', () => {
    addTestInstance('p1', 'cursor');
    const cfg = loadOrCreateHubConfig();
    updateInstance(cfg, 'p1', { sessionMode: 'yolo', allowUnknownSessionMode: true });
    expect(loadOrCreateHubConfig().instances.find((p) => p.id === 'p1')?.sessionMode).toBe('yolo');
  });
});

describe('engine override persistence', () => {
  it('round-trips disabled / displayName / envVars through hub.json', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', {
      disabled: true,
      displayName: 'My Claude',
      mergeEnvVars: { ANTHROPIC_API_KEY: 'sk-test-123' },
    });

    const reloaded = loadOrCreateHubConfig();
    const ov = reloaded.engineOverrides?.['claude-code'];
    expect(ov?.disabled).toBe(true);
    expect(ov?.displayName).toBe('My Claude');
    expect(engineEnvVarKeys(reloaded, 'claude-code')).toEqual(['ANTHROPIC_API_KEY']);
    // env value is encrypted at rest (not plaintext)
    expect(JSON.stringify(ov?.envVars)).not.toContain('sk-test-123');
  });

  it('clearing all fields of an override drops the entry', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: true });
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: null });

    expect(loadOrCreateHubConfig().engineOverrides?.['claude-code']).toBeUndefined();
  });
});

describe('engine default env vars — merge precedence', () => {
  it('resolveEngineEnvVars decrypts engine-default env', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { mergeEnvVars: { ANTHROPIC_API_KEY: 'sk-engine', ANTHROPIC_BASE_URL: 'http://engine' } });
    expect(resolveEngineEnvVars(cfg, 'claude-code')).toEqual({
      ANTHROPIC_API_KEY: 'sk-engine',
      ANTHROPIC_BASE_URL: 'http://engine',
    });
  });

  it('deleteEngineEnvVar removes a single key', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { mergeEnvVars: { A: '1', B: '2' } });
    cfg = deleteEngineEnvVar(cfg, 'claude-code', 'A');
    expect(engineEnvVarKeys(cfg, 'claude-code')).toEqual(['B']);
  });

  it('returns empty record for an engine with no env override', () => {
    const cfg = loadOrCreateHubConfig();
    expect(resolveEngineEnvVars(cfg, 'claude-code')).toEqual({});
  });
});

describe('disabled engines', () => {
  it('isEngineDisabled reflects override state', () => {
    let cfg = loadOrCreateHubConfig();
    expect(isEngineDisabled(cfg, 'claude-code')).toBe(false);
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: true });
    expect(isEngineDisabled(cfg, 'claude-code')).toBe(true);
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: null });
    expect(isEngineDisabled(cfg, 'claude-code')).toBe(false);
  });

  it('addInstance rejects a disabled engine', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: true });
    expect(() =>
      addInstance(cfg, {
        id: 'p1',
        label: 'p1',
        engine: 'claude-code',
        cwd: home,
        host: '127.0.0.1',
        port: nextPort++,
        baseUrl: '',
        extraArgs: [],
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/disabled/i);
  });

  it('updateInstance rejects switching to a disabled engine', () => {
    addTestInstance('p1', 'codebuddy');
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: true });
    expect(() => updateInstance(cfg, 'p1', { engine: 'claude-code' })).toThrow(/disabled/i);
  });
});

describe('custom engine editing', () => {
  it('updateCustomEngineInHub edits displayName and acpCommand', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = addCustomEngineToHub(cfg, { id: 'mycli', displayName: 'Old', acpCommand: 'old-bin --acp' });
    cfg = updateCustomEngineInHub(cfg, 'mycli', { displayName: 'New', acpCommand: 'new-bin --acp --foo bar' });

    const reloaded = loadOrCreateHubConfig();
    const eng = reloaded.customEngines.find((e) => e.id === 'mycli')!;
    expect(eng.displayName).toBe('New');
    expect(eng.command).toBe('new-bin');
    expect(eng.args).toEqual(['--acp', '--foo', 'bar']);
  });

  it('updateCustomEngineInHub rejects unknown engine id', () => {
    const cfg = loadOrCreateHubConfig();
    expect(() => updateCustomEngineInHub(cfg, 'nope', { displayName: 'X' })).toThrow();
  });

  it('rejects editing a built-in engine (custom-only)', () => {
    const cfg = loadOrCreateHubConfig();
    expect(() => updateCustomEngineInHub(cfg, 'claude-code', { acpCommand: 'whatever' })).toThrow();
  });
});

describe('setEngineOverride validation', () => {
  it('rejects an unknown engine id', () => {
    const cfg = loadOrCreateHubConfig();
    expect(() => setEngineOverride(cfg, 'no-such-engine', { disabled: true })).toThrow();
  });

  it('accepts override for a registered custom engine', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = addCustomEngineToHub(cfg, { id: 'mycli', displayName: 'My', acpCommand: 'my-bin' });
    cfg = setEngineOverride(cfg, 'mycli', { disabled: true });
    expect(cfg.engineOverrides?.['mycli']?.disabled).toBe(true);
  });
});
