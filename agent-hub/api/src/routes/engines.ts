/**
 * Custom ACP engine REST routes.
 *
 * GET    /api/engines              — list built-in + custom engines
 * POST   /api/engines              — register a custom local CLI
 * DELETE /api/engines/:id          — remove a custom engine
 */

import { Router, type Request, type Response } from 'express';
import {
  addCustomEngineToHub,
  CustomEngineExistsError,
  CustomEngineInUseError,
  CustomEngineNotFoundError,
  listEngineInfos,
  loadOrCreateHubConfig,
  removeCustomEngineFromHub,
  validateCustomEngineId,
} from '@shepaw/agent-hub-core';

export const enginesRouter = Router();

enginesRouter.get('/', (_req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    res.json({ engines: listEngineInfos(cfg.customEngines) });
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
