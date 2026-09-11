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

  it('builds the peer WS URL from a reverse-proxy exposure', () => {
    const cfg = setHubGateway(loadOrCreateHubConfig(), {
      reverseProxy: { publicBaseUrl: 'https://agents.example.com', pathPrefix: '/hub-a' },
    });
    saveHubConfig(cfg.path, cfg);
    expect(resolvePeerChannelEndpoint(loadOrCreateHubConfig())).toBe(
      'wss://agents.example.com/hub-a/peer/ws',
    );
  });

  it('prefers the shared tunnel over a reverse proxy for the peer WS URL', () => {
    const cfg = setHubGateway(loadOrCreateHubConfig(), {
      tunnel: {
        serverUrl: 'https://channel.example.com',
        channelId: 'ch_peer',
        secret: 'secret',
      },
      reverseProxy: { publicBaseUrl: 'https://agents.example.com', pathPrefix: '/hub-a' },
    });
    saveHubConfig(cfg.path, cfg);
    expect(resolvePeerChannelEndpoint(loadOrCreateHubConfig())).toBe(
      'wss://channel.example.com/proxy/ch_peer/peer/ws',
    );
  });
});

describe('peer QR device name', () => {
  const base = {
    localEndpoint: 'ws://192.168.1.5:18793/peer/ws',
    code: 'ABC23456',
    fingerprint: 'aabbccddeeff0011',
    publicKey: new Uint8Array(32),
  };

  /** Parse back through a strict RFC 3986 parser (Node) to prove round-trip. */
  const parseAsHttp = (qr: string): URL => new URL(qr.replace('shepaw://peer?', 'http://x/?'));

  it('appends name as the last query param, before the fragment', () => {
    const qr = buildPeerQrPayload({ ...base, name: 'Hub Alpha' });
    expect(qr).toContain('&name=Hub%20Alpha');
    // Last query param and strictly before the '#': both are wire contract.
    expect(qr.indexOf('&name=')).toBeGreaterThan(qr.indexOf('&code='));
    expect(qr.indexOf('&name=')).toBeLessThan(qr.indexOf('#'));
    expect(parseAsHttp(qr).searchParams.get('name')).toBe('Hub Alpha');
  });

  it('encodes spaces as %20, never +', () => {
    const qr = buildPeerQrPayload({ ...base, name: 'Hub Alpha' });
    expect(qr).toContain('name=Hub%20Alpha');
    expect(qr).not.toContain('name=Hub+Alpha');
  });

  it('round-trips a CJK name', () => {
    const qr = buildPeerQrPayload({ ...base, name: '客厅电视' });
    expect(parseAsHttp(qr).searchParams.get('name')).toBe('客厅电视');
  });

  it('escapes separator-hostile names without leaking into the fragment', () => {
    const qr = buildPeerQrPayload({ ...base, name: 'A&B=C#D' });
    expect(qr).toContain('name=A%26B%3DC%23D');
    const parsed = parseAsHttp(qr);
    expect(parsed.searchParams.get('name')).toBe('A&B=C#D');
    // The fragment must stay exactly fp/pk — it is the trust anchor.
    expect(parsed.hash).toBe('#fp=aabbccddeeff0011&pk=' + Buffer.from(new Uint8Array(32)).toString('base64url'));
  });

  it('omits the param entirely for undefined / empty / blank names', () => {
    for (const name of [undefined, '', '   ']) {
      const qr = buildPeerQrPayload({ ...base, name });
      expect(qr).not.toContain('name=');
      // Byte-identical to the pre-name format — old QRs stay valid.
      expect(qr).toBe(buildPeerQrPayload(base));
    }
  });

  it('truncates to 32 runes without splitting surrogate pairs', () => {
    const emoji = '😀'.repeat(40);
    let qr = '';
    expect(() => { qr = buildPeerQrPayload({ ...base, name: emoji }); }).not.toThrow();
    expect(parseAsHttp(qr).searchParams.get('name')).toBe('😀'.repeat(32));
  });

  // The app's `PeerPairingInfo.encode` must emit byte-identical output for the
  // same input — this literal is mirrored in
  // shepaw/test/peer/models/pairing_payload_test.dart. It is the only test that
  // catches producer param-order / escaping drift across the two repos.
  it('matches the cross-repo golden, including the no-name legacy form', () => {
    const pk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(buildPeerQrPayload({ ...base, name: '客厅 Hub (A)' })).toBe(
      `shepaw://peer?local=ws%3A%2F%2F192.168.1.5%3A18793%2Fpeer%2Fws&code=ABC23456&name=%E5%AE%A2%E5%8E%85%20Hub%20(A)#fp=aabbccddeeff0011&pk=${pk}`,
    );
    // `!~*'()` stay literal under encodeURIComponent; `&`, `=`, `#` are escaped.
    expect(buildPeerQrPayload({ ...base, name: "A&B=C#D!~*'()" })).toBe(
      `shepaw://peer?local=ws%3A%2F%2F192.168.1.5%3A18793%2Fpeer%2Fws&code=ABC23456&name=A%26B%3DC%23D!~*'()#fp=aabbccddeeff0011&pk=${pk}`,
    );
    expect(buildPeerQrPayload(base)).toBe(
      `shepaw://peer?local=ws%3A%2F%2F192.168.1.5%3A18793%2Fpeer%2Fws&code=ABC23456#fp=aabbccddeeff0011&pk=${pk}`,
    );
  });
});
