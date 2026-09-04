/**
 * Phase 1/2 coverage for the device-level tunnel router's dispatch logic:
 * frames arriving with a `/p/<instanceId>` prefix must reach the matching
 * agent's loopback port untouched (the router never terminates Noise), and
 * unknown routing keys must be rejected.
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HubConfig, InstanceConfig } from '../src/config.js';
import { GatewayTunnelRouter } from '../src/tunnel-router.js';

/** Minimal echo WS server standing in for a instance's ACPAgentServer. */
function mockAgent(reply: (path: string) => string): Promise<{ port: number; close: () => void }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    ws.on('message', () => ws.send(reply(req.url ?? '/')));
  });
  return once(wss, 'listening').then(() => ({
    port: (wss.address() as AddressInfo).port,
    close: () => wss.close(),
  }));
}

function instance(id: string, port: number): InstanceConfig {
  return {
    id,
    label: id,
    engine: 'claude-code',
    cwd: '/tmp',
    host: '127.0.0.1',
    port,
    baseUrl: '',
    extraArgs: [],
    createdAt: new Date().toISOString(),
    envVars: {},
  } as InstanceConfig;
}

async function freePort(): Promise<number> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  await new Promise<void>((r) => wss.close(() => r()));
  return port;
}

/** Connect, send one frame, resolve with the echoed reply (or reject on close). */
function roundtrip(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
    }, 3000);
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(data.toString());
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`closed ${code}`));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let router: GatewayTunnelRouter;
let agentA: { port: number; close: () => void };
let agentB: { port: number; close: () => void };
let routerPort: number;

beforeEach(async () => {
  agentA = await mockAgent(() => 'A');
  agentB = await mockAgent(() => 'B');
  routerPort = await freePort();

  const cfg: HubConfig = {
    path: '/tmp/hub.json',
    instances: [instance('alpha', agentA.port), instance('beta', agentB.port)],
    customEngines: [],
  };

  router = new GatewayTunnelRouter({
    routerPort,
    loadConfig: () => cfg,
    onLog: () => undefined,
  });
  await router.start();
});

afterEach(async () => {
  await router.stop();
  agentA.close();
  agentB.close();
});

describe('GatewayTunnelRouter dispatch', () => {
  it('routes /p/<instanceId>/acp/ws to the matching agent port', async () => {
    const base = `ws://127.0.0.1:${routerPort}`;
    expect(await roundtrip(`${base}/p/alpha/acp/ws?agentId=x`)).toBe('A');
    expect(await roundtrip(`${base}/p/beta/acp/ws`)).toBe('B');
  });

  it('rejects an unknown instance routing key', async () => {
    const base = `ws://127.0.0.1:${routerPort}`;
    await expect(roundtrip(`${base}/p/ghost/acp/ws`)).rejects.toThrow();
  });

  it('serves router-local /health over HTTP', async () => {
    const resp = await fetch(`http://127.0.0.1:${routerPort}/health`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { role: string };
    expect(body.role).toBe('gateway-router');
  });

  it('routes /peer/ws to the peer service port', async () => {
    const peer = await mockAgent(() => 'peer-ok');
    const cfg: HubConfig = {
      path: '/tmp/hub.json',
      instances: [instance('alpha', agentA.port)],
      customEngines: [],
      peer: { host: '127.0.0.1', port: peer.port },
    };
    await router.stop();
    router = new GatewayTunnelRouter({
      routerPort,
      loadConfig: () => cfg,
      onLog: () => undefined,
    });
    await router.start();
    const base = `ws://127.0.0.1:${routerPort}`;
    expect(await roundtrip(`${base}/peer/ws`)).toBe('peer-ok');
    peer.close();
  });

  it('strips a configured reverse-proxy path prefix from WS and HTTP paths', async () => {
    const peer = await mockAgent(() => 'peer-pfx');
    const cfg: HubConfig = {
      path: '/tmp/hub.json',
      instances: [instance('alpha', agentA.port)],
      customEngines: [],
      peer: { host: '127.0.0.1', port: peer.port },
      gateway: {
        reverseProxy: { publicBaseUrl: 'https://agents.example.com', pathPrefix: '/hub-a' },
        routerHost: '127.0.0.1',
        routerPort,
      },
    };
    await router.stop();
    router = new GatewayTunnelRouter({
      routerPort,
      loadConfig: () => cfg,
      onLog: () => undefined,
    });
    await router.start();
    const base = `ws://127.0.0.1:${routerPort}`;
    // A proxy that forwards the full public path (prefix kept) must still work.
    expect(await roundtrip(`${base}/hub-a/p/alpha/acp/ws?agentId=x`)).toBe('A');
    expect(await roundtrip(`${base}/hub-a/peer/ws`)).toBe('peer-pfx');
    // Router-local health is reachable behind the prefix too.
    const resp = await fetch(`http://127.0.0.1:${routerPort}/hub-a/health`);
    expect(resp.status).toBe(200);
    peer.close();
  });
});
