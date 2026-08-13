/**
 * Gateway (shared channel + tunnel router) routes.
 *
 * GET    /api/gateway            — channel config (secret masked) + router status
 * PUT    /api/gateway/channel    — set the shared Channel Service tunnel
 * DELETE /api/gateway/channel    — remove the shared channel (LAN-only)
 * POST   /api/gateway/start      — start the device tunnel router
 * POST   /api/gateway/stop       — stop the device tunnel router
 */

import { Router, type Request, type Response } from 'express';
import {
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  isAlive,
  loadOrCreateHubConfig,
  readGatewayState,
  setHubGateway,
  startGatewayRouter,
  stopGatewayRouter,
} from '@shepaw/agent-hub-core';

export const gatewayRouter = Router();

function gatewayStatePayload(): {
  running: boolean;
  pid: number | null;
  routerPort: number;
  startedAt: string | null;
  lastResult: string | null;
} {
  const state = readGatewayState();
  const running = state !== undefined && state.pid > 0 && isAlive(state.pid);
  return {
    running,
    pid: running ? state!.pid : null,
    routerPort: state?.routerPort ?? DEFAULT_ROUTER_PORT,
    startedAt: state?.startedAt ?? null,
    lastResult: state?.lastResult ?? null,
  };
}

gatewayRouter.get('/', (_req: Request, res: Response) => {
  const cfg = loadOrCreateHubConfig();
  const gw = cfg.gateway;
  res.json({
    routerHost: gw?.routerHost ?? DEFAULT_ROUTER_HOST,
    routerPort: gw?.routerPort ?? DEFAULT_ROUTER_PORT,
    channel: gw?.tunnel
      ? { serverUrl: gw.tunnel.serverUrl, channelId: gw.tunnel.channelId, secretSet: true }
      : null,
    status: gatewayStatePayload(),
  });
});

gatewayRouter.put('/channel', (req: Request, res: Response) => {
  try {
    const { serverUrl, channelId, secret, routerPort } = req.body as Record<string, unknown>;
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
      res.status(400).json({ error: 'serverUrl is required.' });
      return;
    }
    if (typeof channelId !== 'string' || channelId.length === 0) {
      res.status(400).json({ error: 'channelId is required.' });
      return;
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      res.status(400).json({ error: 'secret is required.' });
      return;
    }
    const cfg = loadOrCreateHubConfig();
    setHubGateway(cfg, {
      tunnel: { serverUrl, channelId, secret },
      routerPort:
        typeof routerPort === 'number' || typeof routerPort === 'string'
          ? Math.max(1, Math.floor(Number(routerPort)))
          : undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

gatewayRouter.delete('/channel', (_req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    setHubGateway(cfg, { tunnel: null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

gatewayRouter.post('/start', async (_req: Request, res: Response) => {
  try {
    const cfg = loadOrCreateHubConfig();
    const result = await startGatewayRouter(cfg);
    res.json({ ...result, status: gatewayStatePayload() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

gatewayRouter.post('/stop', async (_req: Request, res: Response) => {
  try {
    const result = await stopGatewayRouter();
    res.json({ result, status: gatewayStatePayload() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
