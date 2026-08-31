import { describe, expect, it } from 'vitest';

import {
  catalogModesWire,
  defaultSessionModeId,
  getEngineSessionCatalog,
  isKnownSessionMode,
  parseSessionMode,
} from '../src/engine-modes.js';

describe('engine session mode catalogs', () => {
  it('exposes Cursor run modes and Claude / Codex / OpenCode native modes', () => {
    expect(getEngineSessionCatalog('cursor').defaultModeId).toBe('auto-review');
    expect(getEngineSessionCatalog('cursor').modes.map((m) => m.id)).toEqual([
      'auto-review', 'allowlist', 'unrestricted',
    ]);
    expect(getEngineSessionCatalog('claude-code').defaultModeId).toBe('acceptEdits');
    expect(getEngineSessionCatalog('codex').modes.map((m) => m.id)).toEqual([
      'untrusted', 'on-request', 'on-failure', 'never',
    ]);
    expect(getEngineSessionCatalog('codex').defaultModeId).toBe('on-request');
    expect(getEngineSessionCatalog('opencode').modes.map((m) => m.id)).toEqual([
      'build', 'plan',
    ]);
    expect(getEngineSessionCatalog('zcode').defaultModeId).toBe('build');
    expect(getEngineSessionCatalog('zcode').modes.map((m) => m.id)).toEqual([
      'plan', 'build', 'edit', 'yolo',
    ]);
    expect(getEngineSessionCatalog('deepseek-harness').defaultModeId).toBe('workspace-write');
    expect(getEngineSessionCatalog('deepseek-harness').modes.map((m) => m.id)).toEqual([
      'read-only', 'workspace-write', 'danger-full-access',
    ]);
    expect(getEngineSessionCatalog('qwen-code').defaultModeId).toBe('auto');
    expect(getEngineSessionCatalog('qwen-code').modes.map((m) => m.id)).toEqual([
      'plan', 'default', 'auto-edit', 'auto', 'yolo',
    ]);
    expect(getEngineSessionCatalog('codebuddy').defaultModeId).toBe('default');
    expect(getEngineSessionCatalog('codebuddy').modes.map((m) => m.id)).toEqual([
      'default', 'acceptEdits', 'plan', 'bypassPermissions',
    ]);
  });

  it('leaves Hermes / Kimi / OpenClaw without a native catalog', () => {
    for (const id of ['hermes', 'kimi', 'openclaw']) {
      expect(getEngineSessionCatalog(id).modes).toEqual([]);
      expect(defaultSessionModeId(id)).toBeUndefined();
    }
  });

  it('uses an empty catalog for unknown engines so Hub does not invent modes', () => {
    expect(defaultSessionModeId('my-cli')).toBeUndefined();
    expect(getEngineSessionCatalog('my-cli').modes).toEqual([]);
  });
});

describe('parseSessionMode', () => {
  it('accepts catalog ids and rejects unknowns for catalogued engines', () => {
    expect(parseSessionMode('cursor', 'auto-review')).toBe('auto-review');
    expect(parseSessionMode('cursor', 'unrestricted')).toBe('unrestricted');
    expect(parseSessionMode('claude-code', 'bypassPermissions')).toBe('bypassPermissions');
    expect(parseSessionMode('codex', 'on-failure')).toBe('on-failure');
    expect(parseSessionMode('opencode', 'build')).toBe('build');
    expect(parseSessionMode('zcode', 'yolo')).toBe('yolo');
    expect(parseSessionMode('deepseek-harness', 'workspace-write')).toBe('workspace-write');
    expect(parseSessionMode('qwen-code', 'auto-edit')).toBe('auto-edit');
    expect(parseSessionMode('qwen-code', 'yolo')).toBe('yolo');
    expect(() => parseSessionMode('qwen-code', 'bypassPermissions')).toThrow(/Unknown session mode/);
    expect(() => parseSessionMode('deepseek-harness', 'yolo')).toThrow(/Unknown session mode/);
    expect(() => parseSessionMode('zcode', 'bypassPermissions')).toThrow(/Unknown session mode/);
    expect(() => parseSessionMode('cursor', 'agent')).not.toThrow();
    expect(parseSessionMode('cursor', 'agent')).toBe('auto-review');
    expect(parseSessionMode('cursor', 'plan')).toBe('allowlist');
    expect(() => parseSessionMode('cursor', 'bypassPermissions')).toThrow(/Unknown session mode/);
  });

  it('treats empty as omitted', () => {
    expect(parseSessionMode('cursor', '')).toBeUndefined();
    expect(parseSessionMode('cursor', undefined)).toBeUndefined();
  });

  it('forwards arbitrary ids for engines without a catalog', () => {
    expect(parseSessionMode('my-cli', 'custom-mode')).toBe('custom-mode');
    expect(() => parseSessionMode('codebuddy', 'whatever')).toThrow(/Unknown session mode/);
    expect(parseSessionMode('codebuddy', 'acceptEdits')).toBe('acceptEdits');
  });

  it('allowUnknown forwards live-advertised ids for catalogued engines', () => {
    expect(parseSessionMode('cursor', 'yolo', { allowUnknown: true })).toBe('yolo');
    expect(() => parseSessionMode('cursor', 'yolo')).toThrow(/Unknown session mode/);
  });

  it('isKnownSessionMode matches the catalog', () => {
    expect(isKnownSessionMode('cursor', 'auto-review')).toBe(true);
    expect(isKnownSessionMode('cursor', 'agent')).toBe(false);
    expect(isKnownSessionMode('codebuddy', 'agent')).toBe(false);
    expect(isKnownSessionMode('codebuddy', 'bypassPermissions')).toBe(true);
  });
});

describe('catalogModesWire', () => {
  it('maps Cursor catalog to App picker wire format', () => {
    const wire = catalogModesWire('cursor', 'allowlist');
    expect(wire.current).toBe('allowlist');
    expect(wire.modes.map((m) => m.value)).toEqual(['auto-review', 'allowlist', 'unrestricted']);
    expect(wire.modes[0]).toMatchObject({
      value: 'auto-review',
      display_name: 'Auto-review',
    });
  });

  it('falls back to the engine default when current is missing', () => {
    expect(catalogModesWire('cursor').current).toBe('auto-review');
    expect(catalogModesWire('claude-code').current).toBe('acceptEdits');
    expect(catalogModesWire('codex').current).toBe('on-request');
    expect(catalogModesWire('deepseek-harness').current).toBe('workspace-write');
    expect(catalogModesWire('qwen-code').current).toBe('auto');
    expect(catalogModesWire('codebuddy').current).toBe('default');
  });

  it('leaves engines without a catalog empty', () => {
    expect(catalogModesWire('hermes').modes).toEqual([]);
    expect(catalogModesWire('hermes').current).toBeUndefined();
  });
});
