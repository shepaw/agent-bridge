/**
 * Dashboard system routes: version check, one-click upgrade, and server
 * restart. The upgrade/restart flow relies on `shepaw-hub web` running as a
 * supervisor: the restart endpoint exits this process and the supervisor
 * respawns it, loading whatever version of the package npm just installed.
 *
 * Guards (mirrored in the UI):
 *   - upgrade  → requires a global npm install (not a source checkout)
 *   - restart  → requires SHEPAW_HUB_SUPERVISED=1 (set by the supervisor)
 *   - both     → refuse while an upgrade is in flight
 */

import { Router, type Request, type Response } from 'express';

import {
  HUB_NPM_PACKAGE,
  checkHubUpdate,
  installLatestFromNpm,
  isNpmPackageInstall,
  readInstalledVersion,
} from '@shepaw/agent-hub-core';

export const systemRouter = Router();

/** True while `npm install -g` is running — upgrade and restart both refuse. */
let upgradeInFlight = false;

/**
 * Installed version of shepaw-agent-hub. The supervisor sets
 * SHEPAW_HUB_INSTALLED_VERSION from the CLI's own package.json (re-derived
 * per respawn), which is exact even when the lockstep core version differs.
 */
function installedVersion(): string {
  return process.env.SHEPAW_HUB_INSTALLED_VERSION?.trim() || readInstalledVersion();
}

// GET /api/system/version?refresh=1
systemRouter.get('/version', async (req: Request, res: Response) => {
  const installed = installedVersion();
  const base = {
    installed,
    npmInstall: isNpmPackageInstall(),
    supervised: process.env.SHEPAW_HUB_SUPERVISED === '1',
  };
  if (req.query.refresh !== '1' && req.query.refresh !== 'true') {
    res.json(base);
    return;
  }
  try {
    const info = await checkHubUpdate({ skipCache: true, installed });
    res.json({ ...base, latest: info.latest, outdated: info.outdated });
  } catch (err) {
    res.status(502).json({
      error: `Could not reach npm registry: ${err instanceof Error ? err.message : String(err)}`,
      code: 'registry-unreachable',
    });
  }
});

// POST /api/system/upgrade
systemRouter.post('/upgrade', async (req: Request, res: Response) => {
  if (!isNpmPackageInstall()) {
    res.status(409).json({
      error:
        'Upgrade is only available when shepaw-agent-hub is installed from npm (global ' +
        'install). From a source checkout: git pull, rebuild, then npm link.',
      code: 'not-npm-install',
    });
    return;
  }
  if (upgradeInFlight) {
    res.status(409).json({
      error: 'An upgrade is already running.',
      code: 'upgrade-in-flight',
    });
    return;
  }
  upgradeInFlight = true;
  try {
    // stdio inherit → npm output flows to the terminal (via the supervisor pipe)
    const code = await installLatestFromNpm();
    if (code !== 0) {
      res.status(500).json({
        error:
          `npm install failed (exit ${code}). If this needs root: ` +
          `sudo npm install -g ${HUB_NPM_PACKAGE}@latest`,
        code: 'npm-install-failed',
      });
      return;
    }
    // Read from disk — npm already replaced the package, so this is the
    // version that will run after the restart.
    res.json({ ok: true, installed: readInstalledVersion() });
  } catch (err) {
    res.status(500).json({
      error: `npm install failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'npm-install-failed',
    });
  } finally {
    upgradeInFlight = false;
  }
});

// POST /api/system/restart
systemRouter.post('/restart', (req: Request, res: Response) => {
  if (process.env.SHEPAW_HUB_SUPERVISED !== '1') {
    res.status(409).json({
      error: 'Dashboard restart is only available when launched via `shepaw-hub web`.',
      code: 'not-supervised',
    });
    return;
  }
  if (upgradeInFlight) {
    res.status(409).json({
      error: 'An upgrade is running; wait for it to finish before restarting.',
      code: 'upgrade-in-flight',
    });
    return;
  }
  res.json({ ok: true, restarting: true });
  // Let the response flush, then die — the supervisor respawns us with the
  // (possibly upgraded) code on disk.
  setTimeout(() => {
    console.log('[shepaw-hub] Restart requested via dashboard — exiting for supervisor respawn.');
    process.exit(0);
  }, 500);
});
