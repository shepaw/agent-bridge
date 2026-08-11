/**
 * Express server for the Shepaw Agent Hub dashboard.
 *
 * - REST API at /api/*
 * - WebSocket log streaming at /ws/logs/<instanceId>
 * - Static SPA served from ui/dist at everything else
 *
 * Auth: set SHEPAW_HUB_TOKEN (or pass authToken). Loopback binds may omit a
 * token for local-dev convenience; non-loopback binds require a token.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { instancesRouter } from './routes/instances.js';
import { enginesRouter } from './routes/engines.js';
import { pairRouter } from './routes/pair.js';
import { gatewayRouter } from './routes/gateway.js';
import { peerRouter } from './routes/peer.js';
import { fsRouter } from './routes/fs.js';
import { storeRouter } from './routes/store.js';
import { attachLogsWss } from './ws.js';
import {
  authorizeWsUpgrade,
  createAuthMiddleware,
  isLoopbackHost,
  resolveHubAuthToken,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Dashboard API token. Defaults to SHEPAW_HUB_TOKEN env. */
  authToken?: string;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const port = opts.port ?? 4000;
  const host = opts.host ?? '127.0.0.1';
  const authToken = resolveHubAuthToken(opts.authToken);

  if (!isLoopbackHost(host) && !authToken) {
    throw new Error(
      `Refusing to bind Hub dashboard to ${host} without auth. ` +
        `Set SHEPAW_HUB_TOKEN or use --host 127.0.0.1.`,
    );
  }

  const app = express();

  // Only allow loopback browser origins. Bearer auth is still required when
  // SHEPAW_HUB_TOKEN is set — this mainly blocks drive-by cross-site calls.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
    }),
  );
  app.use(express.json());

  // Auth for all /api routes (health is exempt inside middleware).
  app.use('/api', createAuthMiddleware(authToken));

  // ── API routes ───────────────────────────────────────────────────
  app.use('/api/instances', instancesRouter);
  // Backward-compat alias: the router was renamed from "project" to "instance".
  // Old clients/scripts hitting /api/projects get the same handler.
  app.use('/api/projects', instancesRouter);
  app.use('/api/engines', enginesRouter);
  app.use('/api/pair', pairRouter);
  app.use('/api/gateway', gatewayRouter);
  app.use('/api/peer', peerRouter);
  app.use('/api/fs', fsRouter);
  app.use('/api/store', storeRouter);

  // ── Health check ─────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      authRequired: Boolean(authToken),
    });
  });

  // ── Static UI ────────────────────────────────────────────────────
  // Try to serve the compiled React app. In development the UI is served by
  // Vite's own dev server, so this is primarily for production installs.
  const uiDistPath = resolveUiDist();
  if (uiDistPath !== null) {
    app.use(express.static(uiDistPath));
    // SPA fallback: any non-API path returns index.html
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(join(uiDistPath, 'index.html'));
    });
  } else {
    app.get('/', (_req: Request, res: Response) => {
      res.send('<p>Shepaw Hub API is running. Build the UI package (<code>agent-hub/ui</code>) to serve the dashboard.</p>');
    });
  }

  // ── HTTP + WS server ─────────────────────────────────────────────
  const httpServer = createServer(app);

  // Attach WebSocket server. We use a path prefix so the same HTTP server
  // handles both REST and WS without a second port.
  const wss = new WebSocketServer({ noServer: true });
  attachLogsWss(wss);

  httpServer.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '';
    if (url.startsWith('/ws/logs/')) {
      if (!authorizeWsUpgrade(request, authToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.once('error', reject);
  });

  if (!isLoopbackHost(host)) {
    console.warn(
      `[shepaw-hub] WARNING: dashboard bound to ${host}. Auth token is required and enabled.`,
    );
  } else if (!authToken) {
    console.warn(
      '[shepaw-hub] Dashboard auth disabled (loopback only). Set SHEPAW_HUB_TOKEN to enable.',
    );
  }
}

/**
 * Locate the compiled UI dist folder. Checks multiple locations because the
 * package may be installed globally, in a workspace, or run from source.
 */
function resolveUiDist(): string | null {
  // 1. Adjacent package in monorepo workspace
  const workspaceDist = join(__dirname, '..', '..', 'ui', 'dist');
  if (existsSync(workspaceDist)) return workspaceDist;

  // 2. @shepaw/agent-hub-ui package resolved from node_modules
  try {
    const uiPkg = require.resolve('@shepaw/agent-hub-ui/dist/index.html');
    return dirname(uiPkg);
  } catch {
    // Not installed as a separate package
  }

  return null;
}
