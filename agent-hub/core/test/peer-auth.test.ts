import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addInstance, loadOrCreateHubConfig, saveHubConfig } from '../src/config.js';
import { loadOrCreatePeerIdentity } from '../src/peer/peer-identity.js';
import { authorizePeerServiceOnAllInstances } from '../src/peer/peer-auth.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-peer-auth-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('authorizePeerServiceOnAllInstances', () => {
  it('writes the peer-service pubkey into every instance peers file', () => {
    let cfg = loadOrCreateHubConfig();
    cfg = addInstance(cfg, {
      id: 'alpha',
      engine: 'claude-code',
      cwd: home,
      host: '127.0.0.1',
      port: 18801,
      baseUrl: '',
      extraArgs: [],
    });
    cfg = addInstance(cfg, {
      id: 'beta',
      engine: 'claude-code',
      cwd: home,
      host: '127.0.0.1',
      port: 18802,
      baseUrl: '',
      extraArgs: [],
    });
    saveHubConfig(cfg.path, cfg);

    const peerIdentity = loadOrCreatePeerIdentity();
    const pubB64 = Buffer.from(peerIdentity.staticPublicKey).toString('base64');
    const result = authorizePeerServiceOnAllInstances();

    expect(result.fingerprint).toBe(peerIdentity.fingerprint);
    expect(result.instanceIds).toEqual(['alpha', 'beta']);

    for (const id of ['alpha', 'beta']) {
      const peersPath = join(home, 'instances', id, 'authorized_peers.json');
      const peers = JSON.parse(readFileSync(peersPath, 'utf-8')) as { peers: Array<{ publicKey: string }> };
      expect(peers.peers.some((p) => p.publicKey === pubB64)).toBe(true);
    }
  });
});
