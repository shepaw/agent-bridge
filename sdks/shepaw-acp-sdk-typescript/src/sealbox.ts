/**
 * Sealed box for channel mailbox (E2E, unidirectional).
 *
 * Format (version 1):
 *   0x01 || ephemeral_pub(32) || nonce(12) || ciphertext||tag
 *
 * KEM: ephemeral X25519 × recipient static public key
 * KDF: HKDF-SHA256(shared, salt="shepaw-mailbox-v1", info="seal", len=32)
 * AEAD: ChaCha20-Poly1305
 *
 * Must stay bit-identical with Dart `MailboxSeal` in the Shepaw app.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const VERSION = 0x01;
const EPH_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + EPH_LEN + NONCE_LEN;
const SALT = Buffer.from('shepaw-mailbox-v1');
const INFO = Buffer.from('seal');

export class SealBoxError extends Error {
  override readonly name = 'SealBoxError';
}

/** Seal `plaintext` to `recipientPublicKey` (32-byte raw X25519). Returns raw bytes. */
export function seal(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== 32) {
    throw new SealBoxError(`recipient public key must be 32 bytes (got ${recipientPublicKey.length})`);
  }

  const { publicKey: ephPubKey, privateKey: ephPrivKey } = generateKeyPairSync('x25519');
  const ephPub = jwkCoord(ephPubKey, 'x');

  const peerPub = publicKeyFromRaw(recipientPublicKey);
  const shared = diffieHellman({ privateKey: ephPrivKey, publicKey: peerPub });
  const key = Buffer.from(hkdfSync('sha256', shared, SALT, INFO, 32));
  const nonce = randomBytes(NONCE_LEN);

  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.allocUnsafe(HEADER_LEN + ct.length + TAG_LEN);
  out[0] = VERSION;
  out.set(ephPub, 1);
  out.set(nonce, 1 + EPH_LEN);
  out.set(ct, HEADER_LEN);
  out.set(tag, HEADER_LEN + ct.length);
  return new Uint8Array(out);
}

/** Open a sealed box with the recipient's 32-byte raw X25519 private key. */
export function open(sealed: Uint8Array, recipientPrivateKey: Uint8Array): Uint8Array {
  if (recipientPrivateKey.length !== 32) {
    throw new SealBoxError(`recipient private key must be 32 bytes (got ${recipientPrivateKey.length})`);
  }
  if (sealed.length < HEADER_LEN + TAG_LEN) {
    throw new SealBoxError('sealed box too short');
  }
  if (sealed[0] !== VERSION) {
    throw new SealBoxError(`unsupported seal version ${sealed[0]}`);
  }

  const ephPub = sealed.subarray(1, 1 + EPH_LEN);
  const nonce = sealed.subarray(1 + EPH_LEN, HEADER_LEN);
  const ctAndTag = sealed.subarray(HEADER_LEN);
  const ct = ctAndTag.subarray(0, ctAndTag.length - TAG_LEN);
  const tag = ctAndTag.subarray(ctAndTag.length - TAG_LEN);

  const privKey = privateKeyFromRaw(recipientPrivateKey);
  const peerPub = publicKeyFromRaw(ephPub);
  const shared = diffieHellman({ privateKey: privKey, publicKey: peerPub });
  const key = Buffer.from(hkdfSync('sha256', shared, SALT, INFO, 32));

  try {
    const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(nonce), {
      authTagLength: TAG_LEN,
    });
    decipher.setAuthTag(Buffer.from(tag));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]));
  } catch (err) {
    throw new SealBoxError(`decryption failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function sealJson(obj: unknown, recipientPublicKey: Uint8Array): string {
  return Buffer.from(seal(Buffer.from(JSON.stringify(obj), 'utf-8'), recipientPublicKey)).toString('base64');
}

export function openJson<T = unknown>(ciphertextB64: string, recipientPrivateKey: Uint8Array): T {
  const plain = open(new Uint8Array(Buffer.from(ciphertextB64, 'base64')), recipientPrivateKey);
  return JSON.parse(Buffer.from(plain).toString('utf-8')) as T;
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Build a private KeyObject from raw 32-byte scalar.
 * Node's JWK import for X25519 requires `x`; we derive it via a throwaway
 * keypair export trick: createPrivateKey with d + dummy x, then re-export
 * to get the real public coord, then recreate.
 */
function privateKeyFromRaw(privRaw: Uint8Array): KeyObject {
  const d = Buffer.from(privRaw).toString('base64url');
  // First pass: Node accepts d with any 32-byte x for createPrivateKey, then
  // exporting as JWK yields the correct public `x`.
  const provisional = createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d, x: Buffer.alloc(32).toString('base64url') },
    format: 'jwk',
  });
  const jwk = provisional.export({ format: 'jwk' }) as { d?: string; x?: string };
  if (jwk.d === undefined || jwk.x === undefined) {
    throw new SealBoxError('failed to materialize X25519 private key');
  }
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: jwk.d, x: jwk.x },
    format: 'jwk',
  });
}

function jwkCoord(key: KeyObject, field: 'x' | 'd'): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string; d?: string };
  const v = jwk[field];
  if (v === undefined) throw new SealBoxError(`missing jwk.${field}`);
  return Buffer.from(v, 'base64url');
}
