/**
 * Tests for engine setup guides and binary resolution.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  augmentSpawnPath,
  checkCursorInstallStatus,
  checkEngineInstallStatus,
  getEngineSetupGuide,
  resolveBinaryPath,
  resolveCursorCliBinary,
  resolveEngineAvailability,
  probeCursorApiKey,
} from '../src/engine-setup.js';

describe('engine-setup', () => {
  let fakeBin: string;

  afterEach(() => {
    if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
  });

  it('returns builtin guide with acp command for cursor', () => {
    const guide = getEngineSetupGuide('cursor');
    expect(guide.acpCommand).toBe('agent acp');
    expect(guide.installable).toBe(true);
    expect(guide.steps.length).toBeGreaterThan(0);
    expect(guide.docsUrl).toContain('cursor.com');
  });

  it('resolveCursorCliBinary prefers healthy official agent over Homebrew', () => {
    const resolved = resolveCursorCliBinary();
    if (existsSync('/Users/edenzou/.local/bin/agent')) {
      expect(resolved).toBe('/Users/edenzou/.local/bin/agent');
    } else if (existsSync('/opt/homebrew/bin/cursor-agent')) {
      expect(resolved).toContain('cursor-agent');
    }
  });

  it('checkCursorInstallStatus detects healthy cursor CLI when present', () => {
    const status = checkCursorInstallStatus();
    if (existsSync('/Users/edenzou/.local/bin/agent')) {
      expect(status.installed).toBe(true);
      expect(status.binaryPath).toBe('/Users/edenzou/.local/bin/agent');
    }
  });

  it('returns custom guide for unknown engines', () => {
    const guide = getEngineSetupGuide('my-custom');
    expect(guide.engineId).toBe('my-custom');
    expect(guide.installable).toBe(false);
  });

  it('resolveBinaryPath finds executable in extra path', () => {
    fakeBin = mkdtempSync(join(tmpdir(), 'shepaw-bin-'));
    const script = join(fakeBin, 'fake-agent');
    writeFileSync(script, '#!/bin/sh\necho 1.0.0\n');
    chmodSync(script, 0o755);

    expect(resolveBinaryPath('fake-agent', [fakeBin])).toBe(script);
  });

  it('checkEngineInstallStatus reports missing binary', () => {
    const status = checkEngineInstallStatus('hermes');
    if (!resolveBinaryPath('hermes', [])) {
      expect(status.installed).toBe(false);
      expect(status.binaryPath).toBeNull();
    }
  });

  it('augmentSpawnPath prepends existing directories', () => {
    const next = augmentSpawnPath({ PATH: '/usr/bin' });
    expect(next.PATH).toBeTruthy();
  });

  it('resolveEngineAvailability marks missing CLI as unavailable', () => {
    const avail = resolveEngineAvailability('cursor');
    if (!avail.installed) {
      expect(avail.available).toBe(false);
      expect(avail.unavailableReason).toBeTruthy();
    }
  });

  it('resolveEngineAvailability respects disabled flag', () => {
    const avail = resolveEngineAvailability('codebuddy', { disabled: true });
    expect(avail.available).toBe(false);
    expect(avail.unavailableReason).toBe('引擎已禁用');
  });

  it('probeCursorApiKey rejects empty and bogus keys', () => {
    expect(probeCursorApiKey('')).toBe('invalid');
    expect(probeCursorApiKey('not-a-real-key')).toBe('invalid');
  });

  it('resolveEngineAvailability blocks cursor with invalid API key', () => {
    if (!existsSync('/opt/homebrew/bin/cursor-agent')) return;
    const avail = resolveEngineAvailability('cursor', { cursorApiKey: 'invalid-test-key' });
    expect(avail.available).toBe(false);
    expect(avail.unavailableReason).toMatch(/无效|401/);
  });
});
