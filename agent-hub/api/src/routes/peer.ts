/**
 * Peer service REST routes.
 *
 * GET    /api/peer                 — service status (running/pid/port) + paired devices
 * POST   /api/peer/start           — start the peer service daemon
 * POST   /api/peer/stop            — stop the peer service daemon
 * POST   /api/peer/pair            — mint a shepaw://peer pairing code + QR
 * GET    /api/peer/devices         — list paired devices
 * DELETE /api/peer/devices/:fp     — revoke a paired device
 */

import { Router, type Request, type Response } from 'express';
import {
  isPeerServiceRunning,
  loadPairedPeers,
  mintPairingQr,
  peerServiceStatus,
  removePairedPeer,
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

/** POST /api/peer/pair — mint a 6-char code + build the shepaw://peer QR. */
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

/** Whether the peer service is currently running. */
export function peerRunning(): boolean {
  return isPeerServiceRunning();
}
