/**
 * Custom ACP engine REST routes.
 *
 * GET    /api/engines                       — list built-in + custom engines (with overrides)
 * POST   /api/engines                       — register a custom local CLI
 * PUT    /api/engines/:id                   — edit a custom engine (displayName / acpCommand)
 * DELETE /api/engines/:id                   — remove a custom engine
 * PUT    /api/engines/:id/override          — set per-engine override (disabled / displayName / approval / env merge)
 * DELETE /api/engines/:id/approval          — clear per-engine approval (inherit)
 * GET    /api/engines/:id/envvars           — list engine-default env var keys (masked)
 * PUT    /api/engines/:id/envvars/:key      — set one engine-default env var
 * DELETE /api/engines/:id/envvars/:key      — delete one engine-default env var
 */

import { Router, type Request, type Response } from 'express';
import {
  addCustomEngineToHub,
  clearEngineApproval,
  CustomEngineExistsError,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
  deleteEngineEnvVar,
  decryptValue,
  engineEnvVarKeys,
  isKnownEngineForOverrides,
  listEngineInfos,
  loadOrCreateHubConfig,
  removeCustomEngineFromHub,
  setEngineEnvVar,
  setEngineOverride,
  updateCustomEngineInHub,
  validateCustomEngineId,
} from '@shepaw/agent-hub-core';
import { hubRoot } from '@shepaw/agent-hub-core';
import { parseApprovalBody } from './approval.js';

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
      return {
        ...info,
        disabled: ov?.disabled === true,
        approval: ov?.approval ?? null,
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
 * Body (all optional): { disabled?, displayName?, approval?, clearApproval? }
 * `displayName: null` / `disabled: null` clear that field.
 * `approval` is an ApprovalPolicyConfig; `clearApproval: true` clears it.
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

    if (body.clearApproval === true) patch.approval = null;
    else if (body.approval !== undefined && body.approval !== null) {
      patch.approval = parseApprovalBody(body.approval as Record<string, unknown>);
    }

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

/** DELETE /api/engines/:id/approval — clear per-engine approval (inherit down). */
enginesRouter.delete('/:id/approval', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const cfg = loadOrCreateHubConfig();
    clearEngineApproval(cfg, req.params.id!);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});

// ── engine-default env vars ───────────────────────────────────────

/** GET /api/engines/:id/envvars — list engine-default env var keys with masked values. */
enginesRouter.get('/:id/envvars', (req: Request, res: Response) => {
  try {
    requireKnownEngine(req.params.id!);
    const cfg = loadOrCreateHubConfig();
    const root = hubRoot();
    const ov = cfg.engineOverrides?.[req.params.id!];
    const result = Object.entries(ov?.envVars ?? {}).map(([key, encrypted]) => {
      let masked = '••••••••';
      try {
        masked = maskSecretValue(decryptValue(encrypted, root));
      } catch {
        // fall back to generic mask
      }
      return { key, value: masked };
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
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CustomEngineNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: String(err) });
    }
  }
});
