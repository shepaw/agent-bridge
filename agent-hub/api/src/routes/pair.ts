/**
 * Hub-level device pairing routes.
 *
 * POST   /api/pair/enroll          — mint QR for all agents on this host
 * GET    /api/pair/enroll          — list outstanding hub tokens
 * DELETE /api/pair/enroll/:code    — revoke a hub token
 * GET    /api/pair/agents          — catalog of managed agents
 * GET    /api/pair/devices         — paired devices (aggregated)
 * DELETE /api/pair/devices/:fp     — revoke device from all agents
 */

import { Router, type Request, type Response } from 'express';
import {
  createHubPairing,
  ensureHubPairingDir,
  listHubAgentCatalog,
  listHubEnrollments,
  listHubPairedDevices,
  loadOrCreateHubConfig,
  removeHubPairedDevice,
  revokeHubEnrollment,
} from '@shepaw/agent-hub-core';

export const pairRouter = Router();

pairRouter.get('/agents', (_req: Request, res: Response) => {
  const cfg = loadOrCreateHubConfig();
  res.json({ agents: listHubAgentCatalog(cfg) });
});

pairRouter.get('/devices', (_req: Request, res: Response) => {
  const cfg = loadOrCreateHubConfig();
  res.json({ devices: listHubPairedDevices(cfg) });
});

pairRouter.delete('/devices/:fp', (req: Request, res: Response) => {
  try {
    const removed = removeHubPairedDevice(req.params.fp!);
    if (!removed) {
      res.status(404).json({ error: `No paired device with fingerprint ${req.params.fp}.` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

pairRouter.get('/enroll', (_req: Request, res: Response) => {
  ensureHubPairingDir();
  res.json({ tokens: listHubEnrollments() });
});

pairRouter.post('/enroll', (req: Request, res: Response) => {
  try {
    const { label, ttlMinutes, bootstrapInstanceId, baseUrl } = req.body as Record<string, unknown>;
    const ttlMs =
      typeof ttlMinutes === 'number' || typeof ttlMinutes === 'string'
        ? Math.max(1, Math.floor(Number(ttlMinutes))) * 60 * 1000
        : undefined;

    const result = createHubPairing({
      label: typeof label === 'string' ? label : undefined,
      ttlMs,
      bootstrapInstanceId: typeof bootstrapInstanceId === 'string' ? bootstrapInstanceId : undefined,
      baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

pairRouter.delete('/enroll/:code', (req: Request, res: Response) => {
  try {
    const ok = revokeHubEnrollment(req.params.code!);
    if (!ok) {
      res.status(404).json({ error: `No outstanding code matching "${req.params.code}".` });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
