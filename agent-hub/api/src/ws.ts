/**
 * WebSocket log streaming.
 *
 * Clients connect to: ws://<host>:<port>/ws/logs/<instanceId>[?tail=N]
 *
 * The server immediately streams the last N lines (default 50), then keeps
 * the connection alive and pushes new log bytes as they appear (follow mode).
 * When the client disconnects (or sends "close"), the tail watcher is aborted.
 *
 * Message protocol (server → client):
 *   { type: 'data',  text: string }  — log chunk
 *   { type: 'error', text: string }  — error message (instance not found, etc.)
 *   { type: 'end' }                  — server closed the stream
 *
 * Message protocol (client → server):
 *   "close"  — graceful disconnect request
 */

import { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadOrCreateHubConfig, getInstance, tailLog, InstanceNotFoundError } from '@shepaw/agent-hub-core';

export function attachLogsWss(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // URL format: /ws/logs/<instanceId>?tail=N
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    // segments: ['ws', 'logs', '<id>']
    const instanceId = segments[2];

    if (!instanceId) {
      sendMsg(ws, { type: 'error', text: 'Missing instance ID in URL path' });
      ws.close();
      return;
    }

    const tailN = Number(url.searchParams.get('tail') ?? '50');

    // Validate instance exists
    try {
      const cfg = loadOrCreateHubConfig();
      getInstance(cfg, instanceId);
    } catch (err) {
      const msg = err instanceof InstanceNotFoundError ? err.message : String(err);
      sendMsg(ws, { type: 'error', text: msg });
      ws.close();
      return;
    }

    const ac = new AbortController();

    // Client can request a graceful stop
    ws.on('message', (data) => {
      if (data.toString() === 'close') ac.abort();
    });

    ws.on('close', () => ac.abort());
    ws.on('error', () => ac.abort());

    // Start tailing in the background
    tailLog(instanceId, {
      tail: Number.isFinite(tailN) ? tailN : 50,
      follow: true,
      signal: ac.signal,
      write: (chunk) => {
        if (ws.readyState === ws.OPEN) {
          sendMsg(ws, { type: 'data', text: chunk });
        }
      },
    })
      .catch((err) => {
        if (ws.readyState === ws.OPEN) {
          sendMsg(ws, { type: 'error', text: err instanceof Error ? err.message : String(err) });
        }
      })
      .finally(() => {
        if (ws.readyState === ws.OPEN) {
          sendMsg(ws, { type: 'end' });
          ws.close();
        }
      });
  });
}

function sendMsg(ws: WebSocket, msg: object): void {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  } catch {
    // Ignore send errors on a closing socket
  }
}
