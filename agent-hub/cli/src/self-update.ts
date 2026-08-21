/**
 * CLI-facing update commands: `shepaw-hub version --check` / `shepaw-hub
 * update` and the web-start hint. The shared registry/install logic lives in
 * @shepaw/agent-hub-core (self-update) and is re-exported here so existing
 * importers keep working; `readInstalledVersion` stays local because it must
 * read the shepaw-agent-hub package.json, not the core package's.
 */

import { createInterface } from 'node:readline/promises';

import {
  checkHubUpdate,
  formatUpdateHint,
  HUB_NPM_PACKAGE,
  installLatestFromNpm,
  isNpmPackageInstall,
  type HubVersionInfo,
} from '@shepaw/agent-hub-core';
export {
  checkHubUpdate,
  compareSemver,
  fetchLatestVersion,
  formatUpdateHint,
  HUB_NPM_PACKAGE,
  installLatestFromNpm,
  isNpmPackageInstall,
  parseLatestVersion,
} from '@shepaw/agent-hub-core';
export type { HubVersionInfo } from '@shepaw/agent-hub-core';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    info = await checkHubUpdate({ skipCache: true, installed: readInstalledVersion() });
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
    const info = await checkHubUpdate({
      timeoutMs: 4000,
      installed: readInstalledVersion(),
    });
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
