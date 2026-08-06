/**
 * PATH shim so external (ACP) agents can run `shepaw store …` from their
 * shell tool, making the app's `[implicit]` store:// hint work verbatim.
 *
 * acp-subprocess.augmentAgentEnv prepends ensureShepawShim()'s directory to
 * the upstream agent's PATH when a store backend is configured. The directory
 * holds a tiny `shepaw` executable that execs dist/shepaw-cli.js with this
 * process's node — no npm-global install required.
 *
 * Enabled when any store backend env is present (NEXUSPOUCH_URL /
 * NEXUSPOUCH_ROOT / SHEPAW_HUB_STORE_URL / SHEPAW_PEER_STORE=1).
 * Disable with SHEPAW_STORE_CLI=0|false|off.
 * Override the shim directory with SHEPAW_STORE_CLI_SHIM_DIR (tests / ops).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { log } from './debug.js';

/** dist layout: dist/shepaw-cli.js sits next to this module when bundled. */
export function defaultCliScriptPath(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'shepaw-cli.js');
  } catch {
    return join(process.cwd(), 'dist', 'shepaw-cli.js');
  }
}

function defaultShimDir(): string {
  const uid =
    typeof process.getuid === 'function' ? String(process.getuid()) : 'shared';
  return join(tmpdir(), `shepaw-acp-proxy-${uid}`, 'bin');
}

/** True when any store backend is configured (same signals as the CLI). */
export function storeBackendConfigured(env: NodeJS.ProcessEnv): boolean {
  if ((env.NEXUSPOUCH_URL ?? '').trim()) return true;
  if ((env.NEXUSPOUCH_ROOT ?? env.NEXUSPOUCH_MCP_ROOT ?? '').trim()) return true;
  if ((env.SHEPAW_HUB_STORE_URL ?? '').trim()) return true;
  const flag = (env.SHEPAW_PEER_STORE ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on';
}

function shimScript(nodePath: string, scriptPath: string): string {
  return [
    '#!/bin/sh',
    `exec "${nodePath}" "${scriptPath}" "$@"`,
    '',
  ].join('\n');
}

function shimCmd(nodePath: string, scriptPath: string): string {
  return `@echo off\r\n"${nodePath}" "${scriptPath}" %*\r\n`;
}

function writeIfChanged(path: string, content: string, mode?: number): void {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === content) return;
    } catch {
      /* rewrite below */
    }
  }
  writeFileSync(path, content, { mode });
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * Ensure the `shepaw` shim exists and return the directory to prepend to
 * PATH, or undefined when disabled / no backend / no built CLI.
 */
export function ensureShepawShim(
  env: NodeJS.ProcessEnv = process.env,
  opts: { scriptPath?: string; shimDir?: string } = {},
): string | undefined {
  const flag = (env.SHEPAW_STORE_CLI ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return undefined;
  if (!storeBackendConfigured(env)) return undefined;

  const scriptPath = (
    env.SHEPAW_STORE_CLI_SCRIPT ??
    opts.scriptPath ??
    defaultCliScriptPath()
  ).trim();
  if (!existsSync(scriptPath)) return undefined;

  const dir = (env.SHEPAW_STORE_CLI_SHIM_DIR ?? opts.shimDir ?? defaultShimDir()).trim();
  try {
    mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      writeIfChanged(join(dir, 'shepaw.cmd'), shimCmd(process.execPath, scriptPath));
    } else {
      writeIfChanged(
        join(dir, 'shepaw'),
        shimScript(process.execPath, scriptPath),
        0o755,
      );
    }
  } catch (err) {
    log(
      'shepaw store CLI shim unavailable: %s',
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
  return dir;
}
