/**
 * Phase 1/2 regression coverage for the gateway-level shared channel:
 *   - `setHubGateway` round-trips tunnel + router settings through hub.json.
 *   - Pairing / catalog WS URLs are minted against the shared channel base
 *     using the `/proxy/<channelId>/p/<instanceId>/acp/ws` routing form the
 *     tunnel router dispatches on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addInstance,
  loadOrCreateHubConfig,
  saveHubConfig,
  setHubGateway,
} from '../src/config.js';
import { createHubPairing, listHubAgentCatalog } from '../src/pairing.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-hub-test-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const TUNNEL = {
  serverUrl: 'https://channel.example.com',
  channelId: 'ch_abc123',
  secret: 'super-secret-hmac-key',
};

let nextPort = 18800;

function seedInstance(id: string): void {
  let cfg = loadOrCreateHubConfig();
  cfg = addInstance(cfg, {
    id,
    label: `Agent ${id}`,
    engine: 'claude-code',
    cwd: home,
    host: '127.0.0.1',
    port: nextPort++,
    baseUrl: '',
    extraArgs: [],
    createdAt: new Date().toISOString(),
    plainEnvVars: {},
  });
  saveHubConfig(cfg.path, cfg);
}

describe('setHubGateway', () => {
  it('round-trips the shared tunnel + router config through hub.json', () => {
    const cfg = loadOrCreateHubConfig();
    const updated = setHubGateway(cfg, { tunnel: TUNNEL });
    saveHubConfig(updated.path, updated);

    const reloaded = loadOrCreateHubConfig();
    expect(reloaded.gateway?.tunnel).toEqual(TUNNEL);
    expect(reloaded.gateway?.routerHost).toBe('127.0.0.1');
    expect(reloaded.gateway?.routerPort).toBeGreaterThan(0);
  });

  it('clears the tunnel when passed tunnel: null', () => {
    let cfg = setHubGateway(loadOrCreateHubConfig(), { tunnel: TUNNEL });
    saveHubConfig(cfg.path, cfg);

    cfg = setHubGateway(loadOrCreateHubConfig(), { tunnel: null });
    saveHubConfig(cfg.path, cfg);

    expect(loadOrCreateHubConfig().gateway?.tunnel).toBeUndefined();
  });
});

describe('pairing URLs with a shared gateway channel', () => {
  it('catalog WS URLs route through /proxy/<channelId>/p/<instanceId>/acp/ws', () => {
    seedInstance('alpha');
    seedInstance('beta');
    const cfg = setHubGateway(loadOrCreateHubConfig(), { tunnel: TUNNEL });
    saveHubConfig(cfg.path, cfg);

    const catalog = listHubAgentCatalog(loadOrCreateHubConfig());
    expect(catalog).toHaveLength(2);
    for (const entry of catalog) {
      expect(entry.wsUrl).toContain(
        `wss://channel.example.com/proxy/ch_abc123/p/${entry.instanceId}/acp/ws`,
      );
      expect(entry.wsUrl).toContain(`agentId=${entry.agentId}`);
      expect(entry.wsUrl).toContain(`#fp=${entry.fingerprint}`);
    }
  });

  it('bootstrap pair URL uses the shared channel and every agent is listed', () => {
    seedInstance('alpha');
    seedInstance('beta');
    const cfg = setHubGateway(loadOrCreateHubConfig(), { tunnel: TUNNEL });
    saveHubConfig(cfg.path, cfg);

    const result = createHubPairing({ label: 'test device' });
    expect(result.pairUrl).toContain('wss://channel.example.com/proxy/ch_abc123/p/');
    expect(result.pairUrl).toContain('/acp/ws');
    expect(result.agents.map((a) => a.instanceId).sort()).toEqual(['alpha', 'beta']);
    // shepaw://pair deeplink carries the WS url + one-time code.
    expect(result.qrPayload).toContain('shepaw://pair');
    expect(result.qrPayload).toContain(encodeURIComponent(result.pairUrl));
  });

  it('falls back to loopback when no shared channel is configured', () => {
    seedInstance('solo');
    const catalog = listHubAgentCatalog(loadOrCreateHubConfig());
    expect(catalog[0]!.wsUrl).toMatch(/^ws:\/\//);
    expect(catalog[0]!.wsUrl).not.toContain('/proxy/');
  });
});

describe('pairing URLs with a self-managed reverse-proxy exposure', () => {
  const RP = { publicBaseUrl: 'https://agents.example.com', pathPrefix: '/hub-a' };

  it('catalog WS URLs route through <publicBase><prefix>/p/<instanceId>/acp/ws', () => {
    seedInstance('alpha');
    seedInstance('beta');
    const cfg = setHubGateway(loadOrCreateHubConfig(), { reverseProxy: RP });
    saveHubConfig(cfg.path, cfg);

    const catalog = listHubAgentCatalog(loadOrCreateHubConfig());
    expect(catalog).toHaveLength(2);
    for (const entry of catalog) {
      expect(entry.wsUrl).toContain(
        `wss://agents.example.com/hub-a/p/${entry.instanceId}/acp/ws`,
      );
      expect(entry.wsUrl).toContain(`agentId=${entry.agentId}`);
      expect(entry.wsUrl).toContain(`#fp=${entry.fingerprint}`);
    }
  });

  it('bootstrap pair URL uses the reverse-proxy base', () => {
    seedInstance('solo');
    const cfg = setHubGateway(loadOrCreateHubConfig(), { reverseProxy: RP });
    saveHubConfig(cfg.path, cfg);

    const result = createHubPairing({ label: 'test device' });
    expect(result.pairUrl).toContain('wss://agents.example.com/hub-a/p/');
    expect(result.pairUrl).toContain('/acp/ws');
    expect(result.agents).toHaveLength(1);
  });

  it('shared Channel wins over reverse proxy when both are configured', () => {
    seedInstance('solo');
    const cfg = setHubGateway(loadOrCreateHubConfig(), { tunnel: TUNNEL, reverseProxy: RP });
    saveHubConfig(cfg.path, cfg);

    const catalog = listHubAgentCatalog(loadOrCreateHubConfig());
    expect(catalog[0]!.wsUrl).toContain('wss://channel.example.com/proxy/ch_abc123/p/');
    expect(catalog[0]!.wsUrl).not.toContain('agents.example.com');
  });

  it('round-trips a reverse-proxy entry independent of the shared tunnel', () => {
    let cfg = setHubGateway(loadOrCreateHubConfig(), { tunnel: TUNNEL, reverseProxy: RP });
    saveHubConfig(cfg.path, cfg);
    expect(loadOrCreateHubConfig().gateway?.reverseProxy).toEqual(RP);

    cfg = setHubGateway(loadOrCreateHubConfig(), { reverseProxy: null });
    saveHubConfig(cfg.path, cfg);
    const gateway = loadOrCreateHubConfig().gateway!;
    expect(gateway.reverseProxy).toBeUndefined();
    // Clearing the reverse proxy must not disturb the shared tunnel.
    expect(gateway.tunnel).toEqual(TUNNEL);
  });
});
