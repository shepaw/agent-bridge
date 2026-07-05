import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateHubConfig, saveHubConfig, setHubGateway } from '../src/config.js';
import { buildPeerQrPayload, resolvePeerChannelEndpoint } from '../src/peer/peer-pairing.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-peer-pairing-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('peer pairing channel endpoint', () => {
  it('omits channel when no gateway tunnel is configured', () => {
    const cfg = loadOrCreateHubConfig();
    expect(resolvePeerChannelEndpoint(cfg)).toBeUndefined();
  });

  it('builds wss channel URL from gateway tunnel config', () => {
    const cfg = setHubGateway(loadOrCreateHubConfig(), {
      tunnel: {
        serverUrl: 'https://channel.example.com',
        channelId: 'ch_peer',
        secret: 'secret',
      },
    });
    saveHubConfig(cfg.path, cfg);
    expect(resolvePeerChannelEndpoint(loadOrCreateHubConfig())).toBe(
      'wss://channel.example.com/proxy/ch_peer/peer/ws',
    );
  });

  it('includes channel param in shepaw://peer QR when provided', () => {
    const qr = buildPeerQrPayload({
      localEndpoint: 'ws://192.168.1.5:18793/peer/ws',
      channelEndpoint: 'wss://channel.example.com/proxy/ch_peer/peer/ws',
      code: 'ABC234',
      fingerprint: 'aabbccddeeff0011',
      publicKey: new Uint8Array(32),
    });
    expect(qr).toContain('shepaw://peer?');
    expect(qr).toContain('channel=wss%3A%2F%2Fchannel.example.com%2Fproxy%2Fch_peer%2Fpeer%2Fws');
    expect(qr).toContain('local=ws%3A%2F%2F192.168.1.5%3A18793%2Fpeer%2Fws');
  });
});
