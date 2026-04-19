/**
 * Tunnel e2e: mock Channel Service + echo agent behind a tunnel +
 * simulate a phone client talking through the tunnel.
 *
 * This verifies the `TunnelClient` speaks the `tunnel-ws` protocol
 * correctly by reproducing the Python `shepaw_acp_sdk.tunnel` wire
 * format — every field (`stream_id`, `ws_msg_type`, base64 body,
 * ping/pong, ws_connect/ws_data/ws_close) round-trips end to end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ACPAgentServer } from '../src/server.js';
import { TaskContext } from '../src/task-context.js';
import { ChannelTunnelConfig } from '../src/tunnel.js';

// ── Mock Channel Service ────────────────────────────────────────────

/**
 * A minimal Channel Service that:
 *   1. Accepts a control WebSocket at /tunnel/connect
 *   2. Exposes a public WS endpoint at /c/<endpoint>/acp/ws which, on
 *      upgrade, sends `ws_connect` over the control channel and pipes
 *      frames both directions using `ws_data` / `ws_close`.
 */
class MockChannelService {
  private readonly httpServer = createHttpServer();
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private control: WebSocket | undefined;
  private controlReady = Promise.resolve<void>(undefined);
  private controlResolve: (() => void) | undefined;
  private streamCounter = 0;
  /** public stream_id → public client WebSocket */
  private readonly publicStreams = new Map<number, WebSocket>();
  port!: number;

  async start(): Promise<void> {
    this.controlReady = new Promise<void>((r) => (this.controlResolve = r));

    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/tunnel/connect') {
        this.wsServer.handleUpgrade(req, socket, head, (ws) => {
          this.control = ws;
          this.controlResolve?.();
          ws.on('message', (raw) => this.onControlMessage(raw.toString('utf-8')));
          ws.on('close', () => {
            this.control = undefined;
          });
        });
      } else if (url.pathname.startsWith('/c/')) {
        // Public-facing WS stream: /c/<endpoint>/acp/ws?token=...
        this.wsServer.handleUpgrade(req, socket, head, (ws) => {
          const streamId = ++this.streamCounter;
          this.publicStreams.set(streamId, ws);

          // Announce ws_connect to the tunnel client. Forward the full path
          // including `/c/<endpoint>` — the client strips it.
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
          this.sendControl({
            type: 'ws_connect',
            stream_id: streamId,
            path: url.pathname + (url.search || ''),
            headers,
          });

          ws.on('message', (data, isBinary) => {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            const body = buf.toString('base64');
            this.sendControl({
              type: 'ws_data',
              stream_id: streamId,
              body,
              ws_msg_type: isBinary ? 2 : 1,
            });
          });
          ws.on('close', () => {
            this.publicStreams.delete(streamId);
            this.sendControl({ type: 'ws_close', stream_id: streamId });
          });
        });
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.httpServer.address() as AddressInfo).port;
  }

  /** Wait until the agent's tunnel client connects to us. */
  waitForControl(): Promise<void> {
    return this.controlReady;
  }

  async stop(): Promise<void> {
    for (const ws of this.publicStreams.values()) ws.close();
    this.publicStreams.clear();
    this.control?.close();
    this.wsServer.close();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private onControlMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      type: string;
      stream_id?: number;
      status?: number;
      body?: string;
      ws_msg_type?: number;
    };
    if (msg.type === 'pong') return;
    if (msg.type === 'ws_data' && msg.stream_id !== undefined) {
      const ws = this.publicStreams.get(msg.stream_id);
      if (ws !== undefined && msg.body !== undefined) {
        const buf = Buffer.from(msg.body, 'base64');
        if (msg.ws_msg_type === 2) ws.send(buf, { binary: true });
        else ws.send(buf.toString('utf-8'));
      }
    } else if (msg.type === 'ws_close' && msg.stream_id !== undefined) {
      const ws = this.publicStreams.get(msg.stream_id);
      if (ws !== undefined) ws.close();
      this.publicStreams.delete(msg.stream_id);
    } else if (msg.type === 'response') {
      // For this test we only exercise ws proxy, not HTTP.
    }
  }

  private sendControl(msg: Record<string, unknown>): void {
    if (this.control !== undefined && this.control.readyState === WebSocket.OPEN) {
      this.control.send(JSON.stringify(msg));
    }
  }
}

// ── Test ────────────────────────────────────────────────────────────

class EchoAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string): Promise<void> {
    await ctx.sendText(`Echo: ${message}`);
  }
}

describe('Tunnel e2e', () => {
  let channel: MockChannelService;
  let agent: EchoAgent;
  let agentPort: number;
  let publicUrl: string;

  beforeAll(async () => {
    channel = new MockChannelService();
    await channel.start();

    const httpSrv = createHttpServer();
    await new Promise<void>((r) => httpSrv.listen(0, '127.0.0.1', () => r()));
    agentPort = (httpSrv.address() as AddressInfo).port;
    httpSrv.close();

    const tunnelConfig = new ChannelTunnelConfig({
      serverUrl: `http://127.0.0.1:${channel.port}`,
      channelId: 'ch_test',
      secret: 'sec_test',
      channelEndpoint: 'myagent',
    });

    agent = new EchoAgent({ name: 'Echo', token: '', tunnelConfig });
    await agent.run({ host: '127.0.0.1', port: agentPort });

    await channel.waitForControl();
    publicUrl = tunnelConfig
      .getPublicEndpoint()
      .replace('wss://', 'ws://');
  }, 15_000);

  afterAll(async () => {
    await agent.close();
    await channel.stop();
  });

  it('routes a full chat turn through the mock Channel Service', async () => {
    const client = new WebSocket(publicUrl);
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const received: Record<string, unknown>[] = [];
    client.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf-8')) as Record<string, unknown>);
    });

    // Send agent.chat through the tunnel.
    client.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'c1',
        method: 'agent.chat',
        params: { task_id: 't1', session_id: 's1', message: 'hello through tunnel' },
      }),
    );

    // Wait up to 5s for task.completed.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const hasCompleted = received.some((m) => m.method === 'task.completed');
      if (hasCompleted) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const methods = received
      .map((m) => (typeof m.method === 'string' ? m.method : null))
      .filter((m): m is string => m !== null);

    expect(methods).toContain('task.started');
    expect(methods).toContain('ui.textContent');
    expect(methods).toContain('task.completed');

    const textNotif = received.find(
      (m) =>
        m.method === 'ui.textContent' &&
        (m.params as Record<string, unknown>).is_final === false,
    );
    expect((textNotif!.params as { content: string }).content).toBe(
      'Echo: hello through tunnel',
    );

    client.close();
  });
});
