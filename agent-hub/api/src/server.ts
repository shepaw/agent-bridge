/**
 * Express server for the Shepaw Agent Hub dashboard.
 *
 * - REST API at /api/*
 * - WebSocket log streaming at /ws/logs/<projectId>
 * - Static SPA served from ui/dist at everything else
 *
 * The server is intentionally simple: no auth by default (it's meant to run
 * on loopback). Operators who need auth can add middleware before calling
 * startServer().
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { projectsRouter } from './routes/projects.js';
import { attachLogsWss } from './ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export interface ServerOptions {
  port?: number;
  host?: string;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const port = opts.port ?? 4000;
  const host = opts.host ?? '127.0.0.1';

  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── API routes ───────────────────────────────────────────────────
  app.use('/api/projects', projectsRouter);

  // ── Health check ─────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, time: new Date().toISOString() });
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
