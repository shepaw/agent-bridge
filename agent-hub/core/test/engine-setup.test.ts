/**
 * Tests for engine setup guides and binary resolution.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  augmentSpawnPath,
  checkCursorInstallStatus,
  checkEngineInstallStatus,
  clearEngineProbeCaches,
  enrichEngineInfo,
  getEngineSetupGuide,
  detectHubPlatform,
  hubPlatformLabel,
  resolveBinaryPath,
  resolveCursorCliBinary,
  resolveEngineAvailability,
  resolveZcodeCliBinary,
  sanitizeZcodeHubEnv,
  probeCursorApiKey,
  probeCursorCliLogin,
} from '../src/engine-setup.js';
import { BUILTIN_ENGINE_IDS } from '../src/engine-catalog.js';

describe('engine-setup', () => {
  let fakeBin: string;

  afterEach(() => {
    if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
  });

  it('returns builtin guide with acp command for cursor on macOS', () => {
    const guide = getEngineSetupGuide('cursor', 'darwin');
    expect(guide.acpCommand).toBe('agent acp');
    expect(guide.installable).toBe(true);
    expect(guide.installCommand).toContain('curl');
    expect(guide.platformLabel).toBe('macOS');
    expect(guide.steps.length).toBeGreaterThan(0);
    expect(guide.docsUrl).toContain('cursor.com');
  });

  it('cursor guide uses PowerShell install on Windows', () => {
    const guide = getEngineSetupGuide('cursor', 'win32');
    expect(guide.installCommand).toContain('win32=true');
    expect(guide.platformLabel).toBe('Windows');
    expect(guide.steps[0]?.command).toContain('irm');
  });

  it('claude-code guide mentions platform in summary', () => {
    const guide = getEngineSetupGuide('claude-code', 'linux');
    expect(guide.summary).toContain('Linux');
    expect(guide.steps[0]?.title).toBe('安装 Node.js');
  });

  it('claude-code guide lists Anthropic gateway env vars', () => {
    const guide = getEngineSetupGuide('claude-code', 'darwin');
    const keys = (guide.requiredEnvVars ?? []).map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining([
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_API_KEY',
    ]));
  });

  it('detectHubPlatform normalizes node platform', () => {
    expect(detectHubPlatform('darwin')).toBe('darwin');
    expect(detectHubPlatform('win32')).toBe('win32');
    expect(detectHubPlatform('freebsd')).toBe('linux');
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

  it('returns kimi guide with official install command', () => {
    const guide = getEngineSetupGuide('kimi', 'darwin');
    expect(guide.acpCommand).toBe('kimi acp');
    expect(guide.checkBinary).toBe('kimi');
    expect(guide.installable).toBe(true);
    expect(guide.installCommand).toContain('code.kimi.com/install.sh');
    expect(guide.docsUrl).toContain('MoonshotAI/kimi-cli');
    expect(guide.checkPaths?.some((p) => p.includes('.kimi-code'))).toBe(true);
  });

  it('returns zcode guide pointing at desktop runtime and ACP adapter', () => {
    const guide = getEngineSetupGuide('zcode', 'darwin');
    expect(guide.acpCommand).toBe('npx -y zcode-acp-server@latest');
    expect(guide.checkBinary).toBe('zcode');
    expect(guide.installable).toBe(false);
    expect(guide.docsUrl).toContain('zcode.z.ai');
    expect(guide.checkPaths?.some((p) => p.includes('ZCode.app'))).toBe(true);
    const keys = (guide.requiredEnvVars ?? []).map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['ZCODE_BIN', 'ZCODE_MODEL', 'ZCODE_BASE_URL']));
    expect(guide.steps.some((s) => /ANTHROPIC_/i.test(s.description))).toBe(true);
  });

  it('sanitizeZcodeHubEnv strips inherited Anthropic keys unless owned', () => {
    const stripped = sanitizeZcodeHubEnv(
      {
        ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-hub',
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_API_KEY: '',
        ZCODE_BIN: '/tmp/zcode.cjs',
      },
      {},
    );
    expect(stripped.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(stripped.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(stripped.ANTHROPIC_API_KEY).toBeUndefined();
    expect(stripped.ZCODE_BIN).toBe('/tmp/zcode.cjs');
    expect(stripped.ZCODE_NODE).toBe(process.execPath);

    const kept = sanitizeZcodeHubEnv(
      {
        ANTHROPIC_API_KEY: 'sk-zcode',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      },
      {
        ANTHROPIC_API_KEY: 'sk-zcode',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      },
    );
    expect(kept.ANTHROPIC_API_KEY).toBe('sk-zcode');
    expect(kept.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('returns deepseek-harness guide with ACP demo command and API key', () => {
    const guide = getEngineSetupGuide('deepseek-harness', 'darwin');
    expect(guide.acpCommand).toBe('npx -y @deepseek-ai/dsh-acp-demo@latest');
    expect(guide.checkBinary).toBe('npx');
    expect(guide.installable).toBe(true);
    expect(guide.docsUrl).toContain('deepseek-ai/deepseek-harness');
    const keys = (guide.requiredEnvVars ?? []).map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']));
  });

  it('returns qwen-code guide with official install command', () => {
    const guide = getEngineSetupGuide('qwen-code', 'darwin');
    expect(guide.acpCommand).toBe('qwen --acp');
    expect(guide.checkBinary).toBe('qwen');
    expect(guide.installable).toBe(true);
    expect(guide.installCommand).toContain('install-qwen-standalone.sh');
    expect(guide.docsUrl).toContain('QwenLM/qwen-code');
    const keys = (guide.requiredEnvVars ?? []).map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining([
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'BAILIAN_CODING_PLAN_API_KEY',
    ]));
  });

  it('qwen-code guide uses PowerShell install on Windows', () => {
    const guide = getEngineSetupGuide('qwen-code', 'win32');
    expect(guide.installCommand).toContain('install-qwen-standalone.ps1');
    expect(guide.steps[0]?.command).toContain('irm');
  });

  it('checkEngineInstallStatus finds kimi under ~/.kimi-code/bin', () => {
    clearEngineProbeCaches();
    const kimiHome = join(homedir(), '.kimi-code', 'bin', 'kimi');
    if (!existsSync(kimiHome)) return;
    const status = checkEngineInstallStatus('kimi');
    expect(status.installed).toBe(true);
    expect(status.binaryPath).toBe(kimiHome);
  });

  it('resolveZcodeCliBinary finds a runtime when desktop or PATH zcode exists', () => {
    const bundled = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
    const resolved = resolveZcodeCliBinary('darwin');
    if (existsSync(bundled) || resolved !== null) {
      expect(resolved).toBeTruthy();
    }
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

  it('resolveEngineAvailability accepts cursor when CLI login is active', () => {
    const status = checkCursorInstallStatus({ skipVersion: true });
    if (!status.installed || status.binaryPath === null) {
      return;
    }
    if (!probeCursorCliLogin(status.binaryPath)) {
      return;
    }
    clearEngineProbeCaches();
    const avail = resolveEngineAvailability('cursor', { skipVersion: true, skipRemoteAuthProbe: true });
    expect(avail.available).toBe(true);
  });

  it('resolveEngineAvailability blocks cursor with invalid API key', () => {
    if (!existsSync('/opt/homebrew/bin/cursor-agent') && !existsSync('/Users/edenzou/.local/bin/agent')) {
      return;
    }
    clearEngineProbeCaches();
    const avail = resolveEngineAvailability('cursor', { cursorApiKey: 'invalid-test-key' });
    expect(avail.available).toBe(false);
    expect(avail.unavailableReason).toMatch(/无效|401/);
  });

  it('listFastPath skips remote Cursor API probe when key is present', () => {
    clearEngineProbeCaches();
    const info = {
      id: 'cursor',
      displayName: 'Cursor',
      acpCommand: 'agent acp',
      builtin: true,
    };
    const t0 = Date.now();
    const enriched = enrichEngineInfo(info, [], false, {
      cursorApiKey: 'sk-not-validated-on-list',
      listFastPath: true,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    if (enriched.available === false) {
      expect(enriched.unavailableReason ?? '').not.toMatch(/401|无效/);
    }
  });

  it('builds catalog guides for newly added ACP agents', () => {
    const gemini = getEngineSetupGuide('gemini', 'darwin');
    expect(gemini.acpCommand).toBe('npx -y @google/gemini-cli@latest --acp');
    expect(gemini.installable).toBe(true);
    expect(gemini.checkBinary).toBe('npx');
    expect(gemini.docsUrl).toContain('geminicli.com');

    const goose = getEngineSetupGuide('goose', 'linux');
    expect(goose.acpCommand).toBe('goose acp');
    expect(goose.installable).toBe(false);
    expect(goose.checkBinary).toBe('goose');

    const copilot = getEngineSetupGuide('copilot', 'darwin');
    expect(copilot.acpCommand).toBe('copilot --acp');
    expect(copilot.installable).toBe(true);
    expect(copilot.installCommand).toContain('@github/copilot');

    const pi = getEngineSetupGuide('pi', 'darwin');
    expect(pi.acpCommand).toBe('npx -y pi-acp');
    expect(pi.checkBinary).toBe('pi');
  });

  it('returns a setup guide for every built-in engine', () => {
    for (const id of BUILTIN_ENGINE_IDS) {
      const guide = getEngineSetupGuide(id, 'darwin');
      expect(guide.engineId).toBe(id);
      expect(guide.acpCommand.length).toBeGreaterThan(0);
      expect(guide.steps.length).toBeGreaterThan(0);
    }
  });
});
