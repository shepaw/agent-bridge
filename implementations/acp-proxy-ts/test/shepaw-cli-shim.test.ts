import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureShepawShim,
  storeBackendConfigured,
} from '../src/shepaw-cli-shim.js';

const cleanup: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe('storeBackendConfigured', () => {
  it('recognizes each backend signal', () => {
    expect(storeBackendConfigured({})).toBe(false);
    expect(storeBackendConfigured({ NEXUSPOUCH_URL: 'http://x' })).toBe(true);
    expect(storeBackendConfigured({ NEXUSPOUCH_ROOT: '/data' })).toBe(true);
    expect(storeBackendConfigured({ SHEPAW_HUB_STORE_URL: 'http://x' })).toBe(true);
    expect(storeBackendConfigured({ SHEPAW_PEER_STORE: '1' })).toBe(true);
    expect(storeBackendConfigured({ SHEPAW_PEER_STORE: 'off' })).toBe(false);
  });
});

describe('ensureShepawShim', () => {
  it('undefined when disabled or no backend configured', () => {
    expect(
      ensureShepawShim({ SHEPAW_STORE_CLI: 'off', NEXUSPOUCH_URL: 'http://x' }),
    ).toBeUndefined();
    expect(ensureShepawShim({})).toBeUndefined();
  });

  it('undefined when the CLI script is missing', () => {
    expect(
      ensureShepawShim(
        { NEXUSPOUCH_URL: 'http://x' },
        { scriptPath: '/nonexistent/shepaw-cli.js', shimDir: tempDir('shepaw-shim-') },
      ),
    ).toBeUndefined();
  });

  it('writes an executable shim that execs the CLI with the current node', () => {
    const scriptDir = tempDir('shepaw-cli-');
    const scriptPath = join(scriptDir, 'shepaw-cli.js');
    writeFileSync(scriptPath, '// cli\n');
    const shimDir = join(tempDir('shepaw-shim-'), 'bin');

    const env = { NEXUSPOUCH_URL: 'http://x' };
    const dir = ensureShepawShim(env, { scriptPath, shimDir });
    expect(dir).toBe(shimDir);

    const shim = join(shimDir, process.platform === 'win32' ? 'shepaw.cmd' : 'shepaw');
    expect(existsSync(shim)).toBe(true);
    const content = readFileSync(shim, 'utf8');
    expect(content).toContain(process.execPath);
    expect(content).toContain(scriptPath);
    if (process.platform !== 'win32') {
      // executable by owner/group/other
      expect(statSync(shim).mode & 0o111).not.toBe(0);
    }

    // idempotent: second call returns the same dir without rewriting
    const before = statSync(shim).mtimeMs;
    expect(ensureShepawShim(env, { scriptPath, shimDir })).toBe(shimDir);
    expect(statSync(shim).mtimeMs).toBe(before);
  });

  it('honors SHEPAW_STORE_CLI_SHIM_DIR / SHEPAW_STORE_CLI_SCRIPT env overrides', () => {
    const scriptDir = tempDir('shepaw-cli-');
    const scriptPath = join(scriptDir, 'shepaw-cli.js');
    writeFileSync(scriptPath, '// cli\n');
    const shimDir = tempDir('shepaw-shim-');

    const dir = ensureShepawShim({
      NEXUSPOUCH_URL: 'http://x',
      SHEPAW_STORE_CLI_SCRIPT: scriptPath,
      SHEPAW_STORE_CLI_SHIM_DIR: shimDir,
    });
    expect(dir).toBe(shimDir);
    expect(
      existsSync(join(shimDir, process.platform === 'win32' ? 'shepaw.cmd' : 'shepaw')),
    ).toBe(true);
  });
});
