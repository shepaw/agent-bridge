/**
 * Peer service REST routes.
 *
 * GET    /api/peer                 — service status (running/pid/port) + paired devices
 * POST   /api/peer/start           — start the peer service daemon
 * POST   /api/peer/stop            — stop the peer service daemon
 * POST   /api/peer/pair            — mint a shepaw://peer pairing code + QR
 * GET    /api/peer/devices         — list paired devices
 * DELETE /api/peer/devices/:fp     — revoke a paired device
 * PUT    /api/peer/device-name     — set the advertised device name ('' clears → hostname)
 */

import { Router, type Request, type Response } from 'express';
import {
  isPeerServiceRunning,
  loadOrCreateHubConfig,
  loadPairedPeers,
  mintPairingQr,
  peerServiceStatus,
  removePairedPeer,
  resolvePeerDeviceName,
  setHubPeer,
  startPeerService,
  stopPeerService,
} from '@shepaw/agent-hub-core';

export const peerRouter = Router();

peerRouter.get('/', (_req: Request, res: Response) => {
  try {
    const status = peerServiceStatus();
    const devices = loadPairedPeers();
    res.json({ status, devices });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

peerRouter.post('/start', async (_req: Request, res: Response) => {
  try {
    const result = await startPeerService();
    res.json({ ok: true, ...result, status: peerServiceStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

peerRouter.post('/stop', async (_req: Request, res: Response) => {
  try {
    const result = await stopPeerService();
    res.json({ ok: true, result, status: peerServiceStatus() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/peer/pair — mint an 8-char code + build the shepaw://peer QR. */
peerRouter.post('/pair', async (_req: Request, res: Response) => {
  try {
    const result = await mintPairingQr();
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

peerRouter.get('/devices', (_req: Request, res: Response) => {
  try {
    res.json({ devices: loadPairedPeers() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

peerRouter.delete('/devices/:fp', (req: Request, res: Response) => {
  try {
    const remaining = removePairedPeer(req.params.fp!);
    res.json({ ok: true, devices: remaining });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** PUT /api/peer/device-name — set the name advertised when a phone pairs. */
peerRouter.put('/device-name', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body.deviceName;
    let name: string | null = null; // default: clear → hostname default
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string') {
        res.status(400).json({ error: 'deviceName must be a string' });
        return;
      }
      const trimmed = raw.trim();
      if (trimmed.length > 64) {
        res.status(400).json({ error: 'deviceName must be at most 64 characters' });
        return;
      }
      name = trimmed.length > 0 ? trimmed : null;
    }
    const cfg = loadOrCreateHubConfig();
    setHubPeer(cfg, { deviceName: name });
    res.json({ ok: true, deviceName: resolvePeerDeviceName(loadOrCreateHubConfig()) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Whether the peer service is currently running. */
export function peerRunning(): boolean {
  return isPeerServiceRunning();
}
