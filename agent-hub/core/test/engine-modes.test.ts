import { describe, expect, it } from 'vitest';

import {
  defaultSessionModeId,
  getEngineSessionCatalog,
  isKnownSessionMode,
  parseSessionMode,
} from '../src/engine-modes.js';

describe('engine session mode catalogs', () => {
  it('exposes Cursor / Claude / Codex / OpenCode native modes', () => {
    expect(getEngineSessionCatalog('cursor').defaultModeId).toBe('agent');
    expect(getEngineSessionCatalog('cursor').modes.map((m) => m.id)).toEqual([
      'agent', 'plan', 'ask',
    ]);
    expect(getEngineSessionCatalog('claude-code').defaultModeId).toBe('acceptEdits');
    expect(getEngineSessionCatalog('codex').modes.map((m) => m.id)).toEqual([
      'untrusted', 'on-request', 'on-failure', 'never',
    ]);
    expect(getEngineSessionCatalog('codex').defaultModeId).toBe('on-request');
    expect(getEngineSessionCatalog('opencode').modes.map((m) => m.id)).toEqual([
      'build', 'plan',
    ]);
  });

  it('leaves CodeBuddy / Hermes / Kimi / OpenClaw without a native catalog', () => {
    for (const id of ['codebuddy', 'hermes', 'kimi', 'openclaw']) {
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
    expect(parseSessionMode('cursor', 'agent')).toBe('agent');
    expect(parseSessionMode('claude-code', 'bypassPermissions')).toBe('bypassPermissions');
    expect(parseSessionMode('codex', 'on-failure')).toBe('on-failure');
    expect(parseSessionMode('opencode', 'build')).toBe('build');
    expect(() => parseSessionMode('cursor', 'bypassPermissions')).toThrow(/Unknown session mode/);
  });

  it('treats empty as omitted', () => {
    expect(parseSessionMode('cursor', '')).toBeUndefined();
    expect(parseSessionMode('cursor', undefined)).toBeUndefined();
  });

  it('forwards arbitrary ids for engines without a catalog', () => {
    expect(parseSessionMode('codebuddy', 'whatever')).toBe('whatever');
    expect(parseSessionMode('my-cli', 'custom-mode')).toBe('custom-mode');
  });

  it('allowUnknown forwards live-advertised ids for catalogued engines', () => {
    expect(parseSessionMode('cursor', 'yolo', { allowUnknown: true })).toBe('yolo');
    expect(() => parseSessionMode('cursor', 'yolo')).toThrow(/Unknown session mode/);
  });

  it('isKnownSessionMode matches the catalog', () => {
    expect(isKnownSessionMode('cursor', 'plan')).toBe(true);
    expect(isKnownSessionMode('cursor', 'auto')).toBe(false);
    expect(isKnownSessionMode('codebuddy', 'agent')).toBe(false);
  });
});
