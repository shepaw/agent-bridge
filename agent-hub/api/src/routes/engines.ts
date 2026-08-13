/**
 * Custom ACP engine REST routes.
 *
 * GET    /api/engines                       — list built-in + custom engines (with overrides)
 * POST   /api/engines                       — register a custom local CLI
 * PUT    /api/engines/:id                   — edit a custom engine (displayName / acpCommand)
 * DELETE /api/engines/:id                   — remove a custom engine
 * PUT    /api/engines/:id/override          — set per-engine override (disabled / displayName / env merge)
 * GET    /api/engines/:id/envvars           — list engine-default env var keys (masked)
 * PUT    /api/engines/:id/envvars/:key      — set one engine-default env var
 * GET    /api/engines/:id/icon              — engine logo (SVG/PNG)
 * GET    /api/engines/:id/setup             — setup guide + install status
 * POST   /api/engines/:id/install           — one-click install + enable
 */

import { Router, type Request, type Response } from 'express';
import {
  addCustomEngineToHub,
  clearEngineProbeCaches,
  CustomEngineExistsError,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
  checkCustomEngineInstallStatus,
  checkEngineInstallStatus,
  deleteEngineEnvVar,
  decryptValue,
  detectHubPlatform,
  engineEnvVarKeys,
  enrichEngineInfo,
  getEngineSetupGuide,
  hubPlatformLabel,
  isKnownEngineForOverrides,
  isSensitiveEnvVarKey,
  listEngineInfos,
  loadOrCreateHubConfig,
  removeCustomEngineFromHub,
  resolveEngineEnvVars,
  runEngineInstall,
  setEngineEnvVar,
  setEngineOverride,
  updateCustomEngineInHub,
  findCustomEngine,
  formatShellCommand,
  resolveEngineAvatarFile,
} from '@shepaw/agent-hub-core';
import { hubRoot } from '@shepaw/agent-hub-core';

export const enginesRouter = Router();

function maskSecretValue(plain: string): string {
  if (plain.length <= 4) return '••••';
  return `${plain.slice(0, 2)}***${plain.slice(-2)}`;
}

/** Require the engine id to be known (built-in or registered custom). */
function requireKnownEngine(id: string): void {
  const cfg = loadOrCreateHubConfig();
  if (!isKnownEngineForOverrides(cfg, id)) {
    throw new CustomEngineNotFoundError(id);
  }
}

enginesRouter.get('/', (_req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const overrides = cfg.engineOverrides ?? {};
    const engines = listEngineInfos(cfg.customEngines, overrides).map((info) => {
      const ov = overrides[info.id];
      const disabled = ov?.disabled === true;
      const engineEnv = resolveEngineEnvVars(cfg, info.id);
      const enriched = enrichEngineInfo(info, cfg.customEngines, disabled, {
        cursorApiKey: info.id === 'cursor' ? engineEnv.CURSOR_API_KEY : undefined,
        listFastPath: true,
      });
      return {
        ...enriched,
        disabled,
        envVarKeys: engineEnvVarKeys(cfg, info.id),
      };
    });
    res.json({ engines });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

enginesRouter.post('/', (req: Request, res: Response) => {
  try {
    const { id, displayName, acpCommand } = req.body as Record<string, unknown>;
    if (typeof id !== 'string' || typeof displayName !== 'string' || typeof acpCommand !== 'string') {
      res.status(400).json({ error: 'Body must include id, displayName, and acpCommand strings.' });
      return;
    }
    validateCustomEngineId(id);
    const cfg = loadOrCreateHubConfig();
    const next = addCustomEngineToHub(cfg, { id, displayName, acpCommand });
    const created = next.customEngines.find((e) => e.id === id);
    res.status(201).json({ engine: created });
  } catch (err) {
    if (err instanceof CustomEngineExistsError) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

/** GET /api/engines/:id/icon — bundled engine logo for the dashboard. */
enginesRouter.get('/:id/icon', (req: Request, res: Response) => {
  const file = resolveEngineAvatarFile(req.params.id!);
  if (!file) {
    res.status(404).end();
    return;
  }
  const contentType = file.endsWith('.png') ? 'image/png' : 'image/svg+xml';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

enginesRouter.get('/:id/setup', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const cfg = loadOrCreateHubConfig();
    const engineId = req.params.id!;
    const platform = detectHubPlatform();
    let guide = getEngineSetupGuide(engineId, platform);
    const custom = findCustomEngine(cfg.customEngines, engineId);
    if (custom !== undefined) {
      const acpCommand = formatShellCommand(custom.command, custom.args);
      guide = {
        ...guide,
        engineId,
        acpCommand,
        summary: `自定义引擎「${custom.displayName}」，需确保 ${custom.command} 已安装并在 PATH 中。`,
        checkBinary: custom.command,
      };
    }
    const status = custom !== undefined
      ? checkCustomEngineInstallStatus(custom.command)
      : checkEngineInstallStatus(engineId);
    const disabled = cfg.engineOverrides?.[engineId]?.disabled === true;
    res.json({ guide, status, disabled, platform, platformLabel: hubPlatformLabel(platform) });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

/**
 * POST /api/engines/:id/install — run the engine's install script, then enable it.
 */
enginesRouter.post('/:id/install', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const result = runEngineInstall(req.params.id!);
    if (result.ok) {
      const cfg = loadOrCreateHubConfig();
      setEngineOverride(cfg, req.params.id!, { disabled: false });
    }
    res.json({
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      enabled: result.ok,
    });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

/** PUT /api/engines/:id — edit a custom engine's display name and/or ACP command (custom-only). */
enginesRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const { displayName, acpCommand } = req.body as Record<string, unknown>;
    const patch: { displayName?: string; acpCommand?: string } = {};
    if (typeof displayName === 'string') patch.displayName = displayName;
    if (typeof acpCommand === 'string') patch.acpCommand = acpCommand;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'Body must include displayName and/or acpCommand.' });
      return;
    }
    const cfg = loadOrCreateHubConfig();
    const next = updateCustomEngineInHub(cfg, req.params.id!, patch);
    const updated = next.customEngines.find((e) => e.id === req.params.id);
    res.json({ engine: updated });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

enginesRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    removeCustomEngineFromHub(cfg, req.params.id!);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof CustomEngineInUseError) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

/**
 * PUT /api/engines/:id/override — set per-engine override fields.
 * Body (all optional): { disabled?, displayName? }
 * `displayName: null` / `disabled: null` clear that field.
 */
enginesRouter.put('/:id/override', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof setEngineOverride>[2] = {};

    if (body.disabled === null) patch.disabled = null;
    else if (typeof body.disabled === 'boolean') patch.disabled = body.disabled;

    if (body.displayName === null) patch.displayName = null;
    else if (typeof body.displayName === 'string') patch.displayName = body.displayName;

    const cfg = loadOrCreateHubConfig();
    const next = setEngineOverride(cfg, req.params.id!, patch);
    res.json({ ok: true, override: next.engineOverrides?.[req.params.id!] ?? null });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// ── engine-default env vars ───────────────────────────────────────

/** GET /api/engines/:id/envvars — list engine-default env vars (secrets masked). */
enginesRouter.get('/:id/envvars', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const cfg = loadOrCreateHubConfig();
    const root = hubRoot();
    const ov = cfg.engineOverrides?.[req.params.id!];
    const result = Object.entries(ov?.envVars ?? {}).map(([key, encrypted]) => {
      const sensitive = isSensitiveEnvVarKey(key);
      let value = sensitive ? '••••••••' : '';
      try {
        const plain = decryptValue(encrypted, root);
        value = sensitive ? maskSecretValue(plain) : plain;
      } catch {
        // fall back to generic mask / empty
      }
      return { key, value, sensitive };
    });
    res.json(result);
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

/** PUT /api/engines/:id/envvars/:key — set one engine-default env var. */
enginesRouter.put('/:id/envvars/:key', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const { value } = req.body as Record<string, unknown>;
    if (typeof value !== 'string') {
      res.status(400).json({ error: '"value" must be a string' });
      return;
    }
    const cfg = loadOrCreateHubConfig();
    setEngineEnvVar(cfg, req.params.id!, req.params.key!, value);
    clearEngineProbeCaches();
    res.json({ ok: true, key: req.params.key });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

/** DELETE /api/engines/:id/envvars/:key — delete one engine-default env var. */
enginesRouter.delete('/:id/envvars/:key', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const cfg = loadOrCreateHubConfig();
    deleteEngineEnvVar(cfg, req.params.id!, req.params.key!);
    clearEngineProbeCaches();
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});
