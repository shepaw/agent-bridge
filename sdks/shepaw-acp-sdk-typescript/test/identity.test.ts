import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  derivedAgentId,
  derivedFingerprint,
  loadOrCreateIdentity,
  resolveIdentityPath,
  verifyKeypair,
} from '../src/identity.js';

describe('identity', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-identity-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('derives agentId and fingerprint deterministically from public key bytes', () => {
    const pub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pub[i] = i;
    // SHA-256 of bytes 0..31 is well-defined; just assert shape and determinism.
    const aid = derivedAgentId(pub);
    const fp = derivedFingerprint(pub);
    expect(aid).toMatch(/^acp_agent_[0-9a-f]{8}$/);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Same pub → same outputs
    expect(derivedAgentId(pub)).toBe(aid);
    expect(derivedFingerprint(pub)).toBe(fp);
    // agentId's 8 hex are the first 4 bytes of the fingerprint's 8 bytes.
    expect(aid).toBe(`acp_agent_${fp.slice(0, 8)}`);
  });

  it('matches the Flutter SDK derivedFingerprint for the all-zero pub (cross-language fixture)', () => {
    // SHA-256 of 32 zero bytes = 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
    // First 8 bytes, lowercase hex = "66687aadf862bd77".
    // Flutter-side test/noise_identity_test.dart asserts the same value — if
    // this test and that test ever disagree, the handshake interop is broken.
    const zeroPub = new Uint8Array(32);
    expect(derivedFingerprint(zeroPub)).toBe('66687aadf862bd77');
    expect(derivedAgentId(zeroPub)).toBe('acp_agent_66687aad');
  });

  it('creates a fresh identity on first load and persists it with 0600', () => {
    const path = join(workdir, 'identity.json');
    expect(existsSync(path)).toBe(false);

    const id = loadOrCreateIdentity({ path });

    expect(id.staticPublicKey.length).toBe(32);
    expect(id.staticPrivateKey.length).toBe(32);
    expect(id.agentId).toBe(derivedAgentId(id.staticPublicKey));
    expect(id.fingerprint).toBe(derivedFingerprint(id.staticPublicKey));
    expect(id.path).toBe(path);

    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('reloads the same identity when called twice', () => {
    const path = join(workdir, 'identity.json');
    const first = loadOrCreateIdentity({ path });
    const second = loadOrCreateIdentity({ path });
    expect(second.agentId).toBe(first.agentId);
    expect(Buffer.from(second.staticPublicKey).equals(Buffer.from(first.staticPublicKey))).toBe(true);
    expect(Buffer.from(second.staticPrivateKey).equals(Buffer.from(first.staticPrivateKey))).toBe(true);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('produces a valid X25519 keypair (priv derives back to pub)', () => {
    const id = loadOrCreateIdentity({ path: join(workdir, 'identity.json') });
    expect(verifyKeypair(id.staticPublicKey, id.staticPrivateKey)).toBe(true);
  });

  it('refuses to load a file with mode broader than 0600 (unix only)', () => {
    if (process.platform === 'win32') return;
    const path = join(workdir, 'identity.json');
    const id = loadOrCreateIdentity({ path });
    expect(id.agentId).toBeDefined();
    // Loosen the permissions and re-load.
    chmodSync(path, 0o644);
    expect(() => loadOrCreateIdentity({ path })).toThrow(/mode 644.*0600/);
  });

  it('rejects a tampered file where agentId does not match the stored pubkey', () => {
    const path = join(workdir, 'identity.json');
    const id = loadOrCreateIdentity({ path });
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    raw.agentId = 'acp_agent_deadbeef';
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    expect(() => loadOrCreateIdentity({ path })).toThrow(/does not match/);
    void id; // silence unused
  });

  it('rejects a file with invalid JSON', () => {
    const path = join(workdir, 'identity.json');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(path, '{not-json', { mode: 0o600 });
    expect(() => loadOrCreateIdentity({ path })).toThrow(/not valid JSON/);
  });

  it('rejects a file with a wrong-length key', () => {
    const path = join(workdir, 'identity.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        agentId: 'acp_agent_00000000',
        staticPublicKey: Buffer.from(new Uint8Array(16)).toString('base64'),
        staticPrivateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreateIdentity({ path })).toThrow(/32 bytes/);
  });

  it('rejects a file with unsupported version', () => {
    const path = join(workdir, 'identity.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        agentId: 'acp_agent_00000000',
        staticPublicKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        staticPrivateKey: Buffer.from(new Uint8Array(32)).toString('base64'),
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreateIdentity({ path })).toThrow(/unsupported 'version'/);
  });

  describe('resolveIdentityPath', () => {
    const savedEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('prefers explicit override', () => {
      process.env.SHEPAW_IDENTITY_PATH = '/should/not/win';
      process.env.XDG_CONFIG_HOME = '/also/not';
      expect(resolveIdentityPath('/explicit/path.json')).toBe('/explicit/path.json');
    });

    it('falls through to SHEPAW_IDENTITY_PATH env', () => {
      process.env.SHEPAW_IDENTITY_PATH = '/from/env.json';
      delete process.env.XDG_CONFIG_HOME;
      expect(resolveIdentityPath()).toBe('/from/env.json');
    });

    it('falls through to XDG_CONFIG_HOME', () => {
      delete process.env.SHEPAW_IDENTITY_PATH;
      process.env.XDG_CONFIG_HOME = '/xdg/config';
      expect(resolveIdentityPath()).toBe('/xdg/config/shepaw-cb-gateway/identity.json');
    });

    it('falls through to ~/.config as last resort', () => {
      delete process.env.SHEPAW_IDENTITY_PATH;
      delete process.env.XDG_CONFIG_HOME;
      const result = resolveIdentityPath();
      expect(result.endsWith('/.config/shepaw-cb-gateway/identity.json')).toBe(true);
    });
  });
});
