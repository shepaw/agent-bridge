import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import noiseLib from 'noise-protocol';

import {
  loadOrCreateIdentity,
  type AgentIdentity,
} from '../src/identity.js';
import {
  NoiseHandshakeError,
  NoiseSession,
  NoiseTransportError,
  NOISE_PROLOGUE,
} from '../src/noise.js';

// ── Test helpers ───────────────────────────────────────────────────

let workdir: string;
let responderIdentity: AgentIdentity;
/** A fresh X25519 keypair representing "the app" — not persisted anywhere. */
let initiatorKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'shepaw-noise-test-'));
  responderIdentity = loadOrCreateIdentity({ path: join(workdir, 'identity.json') });
  initiatorKeyPair = noiseLib.keygen();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Drive a full handshake + return both sides ready for transport. */
function driveHandshake(
  msg1Payload: Uint8Array = new Uint8Array(0),
  msg2Payload: Uint8Array = new Uint8Array(0),
): { initiator: NoiseSession; responder: NoiseSession } {
  const initiator = NoiseSession.initiator({
    staticPublicKey: initiatorKeyPair.publicKey,
    staticPrivateKey: initiatorKeyPair.secretKey,
    remoteStaticPublicKey: responderIdentity.staticPublicKey,
  });
  const responder = NoiseSession.responder(responderIdentity);

  const msg1 = initiator.writeHandshake1(msg1Payload);
  responder.readHandshake1(msg1);

  const msg2 = responder.writeHandshake2(msg2Payload);
  initiator.readHandshake2(msg2);

  return { initiator, responder };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('NoiseSession handshake', () => {
  it('completes a zero-payload IK handshake end-to-end', () => {
    const { initiator, responder } = driveHandshake();
    expect(initiator.ready).toBe(true);
    expect(responder.ready).toBe(true);
  });

  it('carries msg 1 payload through to the responder', () => {
    const payload = new TextEncoder().encode('{"agentId":"test","v":"1.0"}');
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      remoteStaticPublicKey: responderIdentity.staticPublicKey,
    });
    const responder = NoiseSession.responder(responderIdentity);

    const msg1 = initiator.writeHandshake1(payload);
    const hs1 = responder.readHandshake1(msg1);

    expect(new TextDecoder().decode(hs1.msg1Payload)).toBe('{"agentId":"test","v":"1.0"}');
  });

  it('exposes the initiator static pubkey to the responder after msg 1', () => {
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      remoteStaticPublicKey: responderIdentity.staticPublicKey,
    });
    const responder = NoiseSession.responder(responderIdentity);

    const msg1 = initiator.writeHandshake1(new Uint8Array(0));
    const hs1 = responder.readHandshake1(msg1);

    expect(hs1.peerStaticPublicKey.length).toBe(32);
    expect(Array.from(hs1.peerStaticPublicKey)).toEqual(Array.from(initiatorKeyPair.publicKey));
    expect(Array.from(responder.peerStaticPublicKey)).toEqual(Array.from(initiatorKeyPair.publicKey));
  });

  it('carries msg 2 payload through to the initiator', () => {
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      remoteStaticPublicKey: responderIdentity.staticPublicKey,
    });
    const responder = NoiseSession.responder(responderIdentity);

    const msg1 = initiator.writeHandshake1(new Uint8Array(0));
    responder.readHandshake1(msg1);

    const msg2Payload = new TextEncoder().encode('{"agentId":"xxx"}');
    const msg2 = responder.writeHandshake2(msg2Payload);

    const seen = initiator.readHandshake2(msg2);
    expect(new TextDecoder().decode(seen)).toBe('{"agentId":"xxx"}');
  });
});

describe('NoiseSession transport', () => {
  it('encrypts and decrypts round-trip (initiator → responder)', () => {
    const { initiator, responder } = driveHandshake();
    const pt = new TextEncoder().encode('hello from app');
    const ct = initiator.encrypt(pt);
    const rx = responder.decrypt(ct);
    expect(new TextDecoder().decode(rx)).toBe('hello from app');
  });

  it('encrypts and decrypts round-trip (responder → initiator)', () => {
    const { initiator, responder } = driveHandshake();
    const pt = new TextEncoder().encode('hello from agent');
    const ct = responder.encrypt(pt);
    const rx = initiator.decrypt(ct);
    expect(new TextDecoder().decode(rx)).toBe('hello from agent');
  });

  it('auto-increments nonce across many messages', () => {
    const { initiator, responder } = driveHandshake();
    for (let i = 0; i < 50; i++) {
      const pt = new TextEncoder().encode(`msg ${i}`);
      const ct = initiator.encrypt(pt);
      const rx = responder.decrypt(ct);
      expect(new TextDecoder().decode(rx)).toBe(`msg ${i}`);
    }
  });

  it('produces distinct ciphertexts for the same plaintext (proves nonce advanced)', () => {
    const { initiator } = driveHandshake();
    const pt = new TextEncoder().encode('identical');
    const ct1 = initiator.encrypt(pt);
    const ct2 = initiator.encrypt(pt);
    expect(Buffer.from(ct1).toString('hex')).not.toBe(Buffer.from(ct2).toString('hex'));
  });

  it('throws NoiseTransportError on AEAD tag tampering', () => {
    const { initiator, responder } = driveHandshake();
    const ct = initiator.encrypt(new TextEncoder().encode('valid'));
    // Flip one byte in the ciphertext body.
    ct[5] = (ct[5] ?? 0) ^ 0xff;
    expect(() => responder.decrypt(ct)).toThrow(NoiseTransportError);
  });

  it('closes the session after a decrypt failure', () => {
    const { initiator, responder } = driveHandshake();
    const ct = initiator.encrypt(new TextEncoder().encode('valid'));
    ct[5] = (ct[5] ?? 0) ^ 0xff;
    try {
      responder.decrypt(ct);
    } catch {
      /* expected */
    }
    // Session is closed; subsequent encrypts also throw.
    expect(() => responder.encrypt(new TextEncoder().encode('still alive?'))).toThrow(
      NoiseTransportError,
    );
  });

  it('produces different traffic keys for different handshakes', () => {
    const { initiator: a } = driveHandshake();
    const { initiator: b } = driveHandshake();
    const ctA = a.encrypt(new TextEncoder().encode('hello'));
    const ctB = b.encrypt(new TextEncoder().encode('hello'));
    // Ephemeral keys differ per handshake; ciphertexts must differ.
    expect(Buffer.from(ctA).toString('hex')).not.toBe(Buffer.from(ctB).toString('hex'));
  });
});

describe('NoiseSession negative cases', () => {
  it('rejects out-of-order reads on the responder', () => {
    const responder = NoiseSession.responder(responderIdentity);
    expect(() => responder.writeHandshake2(new Uint8Array(0))).toThrow(NoiseHandshakeError);
  });

  it('rejects out-of-order reads on the initiator', () => {
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      remoteStaticPublicKey: responderIdentity.staticPublicKey,
    });
    expect(() => initiator.readHandshake2(new Uint8Array(32))).toThrow(NoiseHandshakeError);
  });

  it('rejects crossing roles: responder can\'t writeHandshake1', () => {
    const responder = NoiseSession.responder(responderIdentity);
    expect(() => responder.writeHandshake1(new Uint8Array(0))).toThrow(NoiseHandshakeError);
  });

  it('rejects crossing roles: initiator can\'t readHandshake1', () => {
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      remoteStaticPublicKey: responderIdentity.staticPublicKey,
    });
    // Initiator is in AWAIT_HS1_WRITE, not AWAIT_HS1.
    expect(() => initiator.readHandshake1(new Uint8Array(96))).toThrow(NoiseHandshakeError);
  });

  it('fails when the initiator pins the wrong responder pubkey (MITM detection)', () => {
    // Generate a completely different static key to pose as the real responder.
    const fake = noiseLib.keygen();
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      // Pin WRONG responder pubkey.
      remoteStaticPublicKey: fake.publicKey,
    });
    const realResponder = NoiseSession.responder(responderIdentity);

    const msg1 = initiator.writeHandshake1(new Uint8Array(0));
    // The real responder has the matching private key for the fingerprint the
    // legitimate URL publishes; the initiator encrypted to a different static.
    // readHandshake1 must fail (ss DH will not match).
    expect(() => realResponder.readHandshake1(msg1)).toThrow(NoiseHandshakeError);
  });

  it('binds the prologue: mismatched prologue fails the handshake', () => {
    const initiator = NoiseSession.initiator({
      staticPublicKey: initiatorKeyPair.publicKey,
      staticPrivateKey: initiatorKeyPair.secretKey,
      remoteStaticPublicKey: responderIdentity.staticPublicKey,
      prologue: Buffer.from('shepaw-acp/999'),
    });
    const responder = NoiseSession.responder(responderIdentity); // default prologue
    const msg1 = initiator.writeHandshake1(new Uint8Array(0));
    expect(() => responder.readHandshake1(msg1)).toThrow(NoiseHandshakeError);
  });

  it('close() is idempotent and disables further use', () => {
    const { initiator } = driveHandshake();
    initiator.close();
    initiator.close(); // no throw
    expect(() => initiator.encrypt(new TextEncoder().encode('after close'))).toThrow(
      NoiseTransportError,
    );
  });
});

describe('NOISE_PROLOGUE', () => {
  it('is the UTF-8 encoding of "shepaw-acp/2.1" (v2.1 protocol binding)', () => {
    expect(new TextDecoder().decode(NOISE_PROLOGUE)).toBe('shepaw-acp/2.1');
  });
});
