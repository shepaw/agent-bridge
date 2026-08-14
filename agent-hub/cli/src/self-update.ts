/**
 * Check npm for a newer shepaw-agent-hub and optionally install it.
 *
 * Already-shipped CLIs cannot be mutated remotely — users on 0.1.3/0.1.4
 * still need one manual `npm install -g`. This module is the on-box path
 * after that: `shepaw-hub update`, doctor warnings, and a web-start hint.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hubRoot } from '@shepaw/agent-hub-core';

export const HUB_NPM_PACKAGE = 'shepaw-agent-hub';
const REGISTRY_LATEST = `https://registry.npmjs.org/${HUB_NPM_PACKAGE}/latest`;
const CHECK_TTL_MS = 12 * 60 * 60 * 1000;

export interface HubVersionInfo {
  installed: string;
  latest: string;
  outdated: boolean;
}

interface CachedCheck {
  checkedAt: number;
  latest: string;
}

export function readInstalledVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  try {
    const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.trim()) return raw.version.trim();
  } catch {
    // fall through
  }
  return '0.0.0';
}

/** Compare dotted numeric versions. Returns negative when `a < b`. */
export function compareSemver(a: string, b: string): number {
  const pa = parseNumericVersion(a);
  const pb = parseNumericVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function parseNumericVersion(raw: string): number[] {
  const core = raw.trim().replace(/^v/, '').split('-')[0] ?? '';
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

export function parseLatestVersion(json: unknown): string {
  if (json && typeof json === 'object' && 'version' in json) {
    const version = (json as { version: unknown }).version;
    if (typeof version === 'string' && version.trim()) return version.trim();
  }
  throw new Error('npm registry response missing version');
}

export async function fetchLatestVersion(timeoutMs = 5000): Promise<string> {
  const res = await fetch(REGISTRY_LATEST, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`npm registry HTTP ${res.status}`);
  }
  return parseLatestVersion(await res.json());
}

function cachePath(): string {
  return join(hubRoot(), 'update-check.json');
}

function readCache(now: number): CachedCheck | undefined {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8')) as CachedCheck;
    if (
      typeof raw.checkedAt !== 'number' ||
      typeof raw.latest !== 'string' ||
      now - raw.checkedAt > CHECK_TTL_MS
    ) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

function writeCache(latest: string, now: number): void {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(
      cachePath(),
      `${JSON.stringify({ checkedAt: now, latest } satisfies CachedCheck)}\n`,
    );
  } catch {
    // cache is best-effort
  }
}

export async function checkHubUpdate(opts: {
  timeoutMs?: number;
  now?: number;
  skipCache?: boolean;
} = {}): Promise<HubVersionInfo> {
  const installed = readInstalledVersion();
  const now = opts.now ?? Date.now();
  const cached = opts.skipCache === true ? undefined : readCache(now);
  const latest = cached?.latest ?? (await fetchLatestVersion(opts.timeoutMs));
  if (cached === undefined) writeCache(latest, now);
  return {
    installed,
    latest,
    outdated: compareSemver(installed, latest) < 0,
  };
}

/**
 * True when this process looks like an npm-installed package (global or
 * prefix), not a git checkout / `npm link` from this monorepo.
 */
export function isNpmPackageInstall(argv1: string = process.argv[1] ?? ''): boolean {
  const normalized = argv1.replaceAll('\\', '/');
  if (normalized.includes('/agent-hub/cli/')) return false;
  return normalized.includes(`/node_modules/${HUB_NPM_PACKAGE}/`)
    || normalized.endsWith(`${sep}${HUB_NPM_PACKAGE}${sep}dist${sep}cli.js`)
    || normalized.includes(`/${HUB_NPM_PACKAGE}/dist/cli.js`);
}

export function formatUpdateHint(info: HubVersionInfo): string {
  return (
    `shepaw-hub ${info.installed} is installed; ${info.latest} is available.\n` +
    `  Update with: shepaw-hub update\n` +
    `  Or:          npm install -g ${HUB_NPM_PACKAGE}@latest`
  );
}

export function installLatestFromNpm(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['install', '-g', `${HUB_NPM_PACKAGE}@latest`],
      {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: process.env,
      },
    );
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(message)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function runUpdateCommand(opts: {
  check?: boolean;
  yes?: boolean;
}): Promise<number> {
  let info: HubVersionInfo;
  try {
    info = await checkHubUpdate({ skipCache: true });
  } catch (err) {
    console.error(
      `Could not query npm for ${HUB_NPM_PACKAGE}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(`Installed: ${info.installed}`);
  console.log(`Latest:    ${info.latest}`);

  if (!info.outdated) {
    console.log('Already up to date.');
    return 0;
  }

  if (opts.check === true) {
    console.log(formatUpdateHint(info));
    return 0;
  }

  if (!isNpmPackageInstall()) {
    console.error(
      'This CLI does not look like a global npm install (source / npm link).\n' +
        `  From a checkout: pull, rebuild, then npm link.\n` +
        `  From npm:        npm install -g ${HUB_NPM_PACKAGE}@latest`,
    );
    return 1;
  }

  if (opts.yes !== true) {
    const ok = await confirm(`Install ${HUB_NPM_PACKAGE}@${info.latest} globally? [y/N] `);
    if (!ok) {
      console.log('Aborted. Re-run with --yes to skip the prompt.');
      return 1;
    }
  }

  console.log(`\nRunning: npm install -g ${HUB_NPM_PACKAGE}@latest\n`);
  const code = await installLatestFromNpm();
  if (code !== 0) {
    console.error(
      `npm install failed (exit ${code}). If this needs root: sudo npm install -g ${HUB_NPM_PACKAGE}@latest`,
    );
    return code;
  }
  console.log('\nUpdate installed. Restart `shepaw-hub web` / running instances to pick it up.');
  return 0;
}

/** Non-blocking hint (and optional auto-install) used by `shepaw-hub web`. */
export async function notifyIfUpdateAvailable(): Promise<void> {
  try {
    const info = await checkHubUpdate({ timeoutMs: 4000 });
    if (!info.outdated) return;

    const auto = process.env.SHEPAW_HUB_AUTO_UPDATE?.trim() === '1';
    console.log('');
    console.log(formatUpdateHint(info));
    if (!auto) {
      console.log('  Set SHEPAW_HUB_AUTO_UPDATE=1 to install on dashboard start.');
      console.log('');
      return;
    }
    if (!isNpmPackageInstall()) {
      console.log('  SHEPAW_HUB_AUTO_UPDATE is set but this is not a global npm install; skipped.');
      console.log('');
      return;
    }
    console.log('  SHEPAW_HUB_AUTO_UPDATE=1 — installing latest…');
    const code = await installLatestFromNpm();
    if (code === 0) {
      console.log('  Installed. Restart this dashboard process to run the new version.');
    } else {
      console.log(`  Auto-update failed (exit ${code}). Run: shepaw-hub update`);
    }
    console.log('');
  } catch {
    // Registry unreachable — dashboard should still start.
  }
}
