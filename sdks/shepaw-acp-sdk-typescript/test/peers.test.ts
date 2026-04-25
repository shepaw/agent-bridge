import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addPeer,
  derivedPeerFingerprint,
  isPeerAuthorized,
  loadOrCreatePeers,
  removePeerByFingerprint,
  resolvePeersPath,
} from '../src/peers.js';

// 32-byte X25519 public keys for tests. These don't need to be real X25519
// points — the allowlist code treats them as opaque byte strings. The
// derived-fingerprint self-check uses SHA-256, which works on any 32 bytes.
function makePub(seed: number): Uint8Array {
  const pub = new Uint8Array(32);
  for (let i = 0; i < 32; i++) pub[i] = (seed + i) & 0xff;
  return pub;
}

function makePubB64(seed: number): string {
  return Buffer.from(makePub(seed)).toString('base64');
}

describe('peers', () => {
  let workdir: string;
  let peersPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-peers-'));
    peersPath = join(workdir, 'authorized_peers.json');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('derives a deterministic fingerprint from a public key', () => {
    const pub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pub[i] = i;
    const fp = derivedPeerFingerprint(pub);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Same bytes in → same fp out.
    expect(derivedPeerFingerprint(pub)).toBe(fp);
  });

  it('fingerprint algorithm matches derivedFingerprint from identity.ts', async () => {
    // Cross-check: the fingerprint on authorized_peers.json entries MUST match
    // exactly what the Flutter app computes on its own public key and what the
    // agent's Noise handshake code will derive from peerStaticPublicKey. Using
    // the all-zero key as the canonical fixture.
    const zeroPub = new Uint8Array(32);
    expect(derivedPeerFingerprint(zeroPub)).toBe('66687aadf862bd77');

    const identity = await import('../src/identity.js');
    expect(derivedPeerFingerprint(zeroPub)).toBe(identity.derivedFingerprint(zeroPub));
  });

  it('creates an empty allowlist on first load and persists it with 0600', () => {
    expect(existsSync(peersPath)).toBe(false);
    const peers = loadOrCreatePeers({ path: peersPath });
    expect(peers.peers.length).toBe(0);
    expect(peers.path).toBe(peersPath);
    expect(existsSync(peersPath)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(peersPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const parsed = JSON.parse(readFileSync(peersPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.peers)).toBe(true);
  });

  it('addPeer appends a new entry and rewrites the file', () => {
    const entry = addPeer(peersPath, makePubB64(1), 'iPhone');
    expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.label).toBe('iPhone');
    expect(entry.publicKey.length).toBe(32);

    const reloaded = loadOrCreatePeers({ path: peersPath });
    expect(reloaded.peers.length).toBe(1);
    expect(reloaded.peers[0]?.fingerprint).toBe(entry.fingerprint);
    expect(reloaded.peers[0]?.label).toBe('iPhone');
  });

  it('addPeer is idempotent on the same public key (returns existing entry)', () => {
    const first = addPeer(peersPath, makePubB64(1), 'iPhone');
    const second = addPeer(peersPath, makePubB64(1), 'DIFFERENT LABEL');
    expect(second.fingerprint).toBe(first.fingerprint);
    // Label stays as the first-write value — idempotent means "no change".
    expect(second.label).toBe('iPhone');

    const reloaded = loadOrCreatePeers({ path: peersPath });
    expect(reloaded.peers.length).toBe(1);
  });

  it('addPeer distinguishes different keys that share a label', () => {
    addPeer(peersPath, makePubB64(1), 'phone');
    addPeer(peersPath, makePubB64(2), 'phone');
    const reloaded = loadOrCreatePeers({ path: peersPath });
    expect(reloaded.peers.length).toBe(2);
    expect(new Set(reloaded.peers.map((p) => p.fingerprint)).size).toBe(2);
  });

  it('addPeer rejects invalid base64 / wrong-length keys', () => {
    expect(() => addPeer(peersPath, 'not-base64!!!not-32-bytes', 'bad')).toThrow();
    // 16-byte key (half-length) after base64 decode
    const half = Buffer.from(new Uint8Array(16)).toString('base64');
    expect(() => addPeer(peersPath, half, 'half')).toThrow(/32 bytes/);
  });

  it('removePeerByFingerprint returns true when removed, false when absent', () => {
    const entry = addPeer(peersPath, makePubB64(1));
    expect(removePeerByFingerprint(peersPath, entry.fingerprint)).toBe(true);
    expect(loadOrCreatePeers({ path: peersPath }).peers.length).toBe(0);

    expect(removePeerByFingerprint(peersPath, entry.fingerprint)).toBe(false);
    expect(removePeerByFingerprint(peersPath, 'ffffffffffffffff')).toBe(false);
  });

  it('removePeerByFingerprint is case-insensitive', () => {
    const entry = addPeer(peersPath, makePubB64(1));
    expect(removePeerByFingerprint(peersPath, entry.fingerprint.toUpperCase())).toBe(true);
  });

  it('isPeerAuthorized matches by raw public key bytes', () => {
    addPeer(peersPath, makePubB64(1), 'Alice');
    addPeer(peersPath, makePubB64(2), 'Bob');
    const peers = loadOrCreatePeers({ path: peersPath });

    const alice = isPeerAuthorized(peers, makePub(1));
    expect(alice).toBeDefined();
    expect(alice?.label).toBe('Alice');

    expect(isPeerAuthorized(peers, makePub(99))).toBeUndefined();
  });

  it('refuses to load a file with mode broader than 0600 (unix only)', () => {
    if (process.platform === 'win32') return;
    addPeer(peersPath, makePubB64(1));
    chmodSync(peersPath, 0o644);
    expect(() => loadOrCreatePeers({ path: peersPath })).toThrow(/mode 644.*0600/);
  });

  it('rejects a file with a mismatched fingerprint (tamper detection)', () => {
    addPeer(peersPath, makePubB64(1), 'Alice');
    const parsed = JSON.parse(readFileSync(peersPath, 'utf-8')) as { peers: { fingerprint: string }[] };
    if (parsed.peers[0] !== undefined) parsed.peers[0].fingerprint = 'ffffffffffffffff';
    writeFileSync(peersPath, JSON.stringify(parsed), { mode: 0o600 });
    expect(() => loadOrCreatePeers({ path: peersPath })).toThrow(/does not match/);
  });

  it('rejects a file with a wrong-length publicKey', () => {
    writeFileSync(
      peersPath,
      JSON.stringify({
        version: 1,
        peers: [
          {
            fingerprint: '0000000000000000',
            publicKey: Buffer.from(new Uint8Array(16)).toString('base64'),
            label: '',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreatePeers({ path: peersPath })).toThrow(/32 bytes/);
  });

  it('rejects a file with invalid JSON', () => {
    mkdirSync(workdir, { recursive: true });
    writeFileSync(peersPath, '{not-json', { mode: 0o600 });
    expect(() => loadOrCreatePeers({ path: peersPath })).toThrow(/not valid JSON/);
  });

  it('rejects a file with unsupported version', () => {
    writeFileSync(
      peersPath,
      JSON.stringify({ version: 2, peers: [] }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreatePeers({ path: peersPath })).toThrow(/unsupported 'version'/);
  });

  it('handles empty label (defaults to empty string)', () => {
    const entry = addPeer(peersPath, makePubB64(1));
    expect(entry.label).toBe('');
    const reloaded = loadOrCreatePeers({ path: peersPath });
    expect(reloaded.peers[0]?.label).toBe('');
  });

  describe('resolvePeersPath', () => {
    const savedEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('prefers explicit override', () => {
      process.env.SHEPAW_PEERS_PATH = '/should/not/win';
      process.env.XDG_CONFIG_HOME = '/also/not';
      expect(resolvePeersPath('/explicit/path.json')).toBe('/explicit/path.json');
    });

    it('falls through to SHEPAW_PEERS_PATH env', () => {
      process.env.SHEPAW_PEERS_PATH = '/from/env.json';
      delete process.env.XDG_CONFIG_HOME;
      expect(resolvePeersPath()).toBe('/from/env.json');
    });

    it('falls through to XDG_CONFIG_HOME', () => {
      delete process.env.SHEPAW_PEERS_PATH;
      process.env.XDG_CONFIG_HOME = '/xdg/config';
      expect(resolvePeersPath()).toBe('/xdg/config/shepaw-cb-gateway/authorized_peers.json');
    });

    it('falls through to ~/.config as last resort', () => {
      delete process.env.SHEPAW_PEERS_PATH;
      delete process.env.XDG_CONFIG_HOME;
      const result = resolvePeersPath();
      expect(result.endsWith('/.config/shepaw-cb-gateway/authorized_peers.json')).toBe(true);
    });
  });
});
