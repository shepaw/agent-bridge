/**
 * Shared update logic for shepaw-agent-hub: query the npm registry for the
 * latest release, compare with the installed version, and (optionally) install
 * it globally. Consumed by both the CLI (`shepaw-hub version --check` /
 * `shepaw-hub update`) and the dashboard (`/api/system/version|upgrade`).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hubRoot } from './paths.js';

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

/**
 * Installed version of the package this module ships in. Note this reads the
 * *core* package.json — under lockstep release the number equals the CLI's,
 * but callers that know their own package (the CLI) should pass `installed`
 * to `checkHubUpdate` explicitly.
 */
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
  /** Installed version to compare against; defaults to this package's own. */
  installed?: string;
} = {}): Promise<HubVersionInfo> {
  const installed = opts.installed ?? readInstalledVersion();
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
 * True when the calling process looks like an npm-installed package (global
 * or prefix), not a git checkout / `npm link` from this monorepo.
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
