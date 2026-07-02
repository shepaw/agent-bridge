/**
 * Coverage for per-engine overrides and the three-tier approval resolution:
 *   instance.approval → engineOverrides[engine].approval → gateway.approval
 *
 * Also covers: disabled-engine rejection at add/start, engine-default env
 * merge precedence (instance overrides engine), and persistence round-trip.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addInstance,
  clearEngineApproval,
  deleteEngineEnvVar,
  engineEnvVarKeys,
  isEngineDisabled,
  loadOrCreateHubConfig,
  resolveApprovalPolicy,
  resolveEngineEnvVars,
  setEngineEnvVar,
  setEngineOverride,
  setHubGateway,
  updateCustomEngineInHub,
  updateInstance,
  type ApprovalPolicyConfig,
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

const ASK: ApprovalPolicyConfig = { mode: 'ask', allowKinds: [], askKinds: [], allowPatterns: [], denyPatterns: [] };
const AUTO: ApprovalPolicyConfig = { mode: 'auto', allowKinds: ['read'], askKinds: [], allowPatterns: [], denyPatterns: [] };
const CUSTOM: ApprovalPolicyConfig = { mode: 'custom', allowKinds: [], askKinds: ['execute'], allowPatterns: ['^ls'], denyPatterns: [] };

describe('engine override approval — three-tier resolution', () => {
  it('falls back to gateway default when neither instance nor engine set a policy', () => {
    addTestInstance('p1');
    const cfg = loadOrCreateHubConfig();
    const instance = cfg.instances.find((p) => p.id === 'p1')!;
    expect(resolveApprovalPolicy(cfg, instance)).toBeUndefined();

    const withGateway = setHubGateway(cfg, { approval: AUTO });
    expect(resolveApprovalPolicy(withGateway, instance)).toEqual(AUTO);
  });

  it('engine override beats gateway default', () => {
    addTestInstance('p1');
    let cfg = loadOrCreateHubConfig();
    cfg = setHubGateway(cfg, { approval: AUTO });
    cfg = setEngineOverride(cfg, 'claude-code', { approval: CUSTOM });

    const instance = cfg.instances.find((p) => p.id === 'p1')!;
    expect(resolveApprovalPolicy(cfg, instance)).toEqual(CUSTOM);
  });

  it('instance override beats engine override and gateway default', () => {
    addTestInstance('p1');
    let cfg = loadOrCreateHubConfig();
    cfg = setHubGateway(cfg, { approval: AUTO });
    cfg = setEngineOverride(cfg, 'claude-code', { approval: CUSTOM });
    cfg = updateInstance(cfg, 'p1', { approval: ASK });

    const instance = cfg.instances.find((p) => p.id === 'p1')!;
    expect(resolveApprovalPolicy(cfg, instance)).toEqual(ASK);
  });

  it('clearEngineApproval makes the engine fall back to gateway default', () => {
    addTestInstance('p1');
    let cfg = loadOrCreateHubConfig();
    cfg = setHubGateway(cfg, { approval: AUTO });
    cfg = setEngineOverride(cfg, 'claude-code', { approval: CUSTOM });
    cfg = clearEngineApproval(cfg, 'claude-code');

    const instance = cfg.instances.find((p) => p.id === 'p1')!;
    expect(resolveApprovalPolicy(cfg, instance)).toEqual(AUTO);
  });

  it('engine override only applies to the matching engine', () => {
    addTestInstance('p1', 'claude-code');
    addTestInstance('p2', 'codebuddy');
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { approval: CUSTOM });

    const p1 = cfg.instances.find((p) => p.id === 'p1')!;
    const p2 = cfg.instances.find((p) => p.id === 'p2')!;
    expect(resolveApprovalPolicy(cfg, p1)).toEqual(CUSTOM);
    expect(resolveApprovalPolicy(cfg, p2)).toBeUndefined();
  });
});

describe('engine override persistence', () => {
  it('round-trips disabled / displayName / approval / envVars through hub.json', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', {
      disabled: true,
      displayName: 'My Claude',
      approval: CUSTOM,
      mergeEnvVars: { ANTHROPIC_API_KEY: 'sk-test-123' },
    });

    const reloaded = loadOrCreateHubConfig();
    const ov = reloaded.engineOverrides?.['claude-code'];
    expect(ov?.disabled).toBe(true);
    expect(ov?.displayName).toBe('My Claude');
    expect(ov?.approval).toEqual(CUSTOM);
    expect(engineEnvVarKeys(reloaded, 'claude-code')).toEqual(['ANTHROPIC_API_KEY']);
    // env value is encrypted at rest (not plaintext)
    expect(JSON.stringify(ov?.envVars)).not.toContain('sk-test-123');
  });

  it('clearing all fields of an override drops the entry', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: true, approval: CUSTOM });
    cfg = setEngineOverride(cfg, 'claude-code', { disabled: null, approval: null });

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
    cfg = setEngineOverride(cfg, 'mycli', { approval: AUTO });
    expect(cfg.engineOverrides?.['mycli']?.approval).toEqual(AUTO);
  });
});
