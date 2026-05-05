/**
 * Lightweight credential encryption for hub.json envVars.
 *
 * Algorithm: AES-256-GCM (authenticated encryption — prevents both
 * confidentiality and integrity attacks).
 *
 * Key derivation: scrypt(MATERIAL + hubRoot, SALT, 32 bytes).
 *   - MATERIAL is a constant string tied to the hub's schema version so that
 *     credentials are implicitly invalidated if the schema changes.
 *   - hubRoot is mixed in so that credentials copied from one machine's
 *     hub.json to another cannot be silently decrypted without also having
 *     the matching hubRoot path.  This is NOT a strong security boundary —
 *     it's a simple friction layer that prevents accidental cross-machine
 *     reuse of credential blobs.
 *
 * Storage format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 *   All three components are hexadecimal. Stored as a plain string value
 *   inside hub.json alongside other project fields.
 *
 * Security posture: "better than plaintext, suitable for single-user
 * workstations". The hub.json file is already stored 0600, so the main
 * threat model is accidental exposure (e.g. committed to git, shared in a
 * bug report). This scheme defeats casual inspection of those blobs.
 * It does NOT protect against an attacker with read access to the filesystem
 * who also knows hubRoot (they can re-derive the key).
 *
 * The key is derived synchronously using scrypt with intentionally low
 * parameters (N=2^14, r=8, p=1) so that CLI startup latency stays
 * imperceptible even when many projects are loaded. The threat model does
 * not require brute-force resistance — the ciphertext is only as secret as
 * the hub.json file itself.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// ── constants ──────────────────────────────────────────────────────

/** Bump this string when the hub's encryption scheme changes, which will
 *  cause previously encrypted values to fail decryption (expected behaviour
 *  during schema migrations). */
const MATERIAL = 'shepaw-hub-v1-envvars';

/** Fixed salt — not secret; just prevents the same key from being used in
 *  unrelated applications that happen to pick the same MATERIAL. */
const SALT = Buffer.from('shepaw-hub-credential-salt-2025', 'utf8');

/** AES-GCM key length in bytes (256-bit). */
const KEY_LEN = 32;

/** GCM IV length in bytes (96-bit — NIST recommended). */
const IV_LEN = 12;

/** GCM auth tag length in bytes. */
const TAG_LEN = 16;

// ── key cache ──────────────────────────────────────────────────────

// One derived key per hubRoot, cached for the process lifetime.
const keyCache = new Map<string, Buffer>();

function deriveKey(hubRoot: string): Buffer {
  const cached = keyCache.get(hubRoot);
  if (cached !== undefined) return cached;
  const key = scryptSync(
    Buffer.from(MATERIAL + hubRoot, 'utf8'),
    SALT,
    KEY_LEN,
    { N: 16384, r: 8, p: 1 },
  ) as Buffer;
  keyCache.set(hubRoot, key);
  return key;
}

// ── public API ─────────────────────────────────────────────────────

/**
 * Encrypt a plaintext credential value.
 * Returns a "<iv_hex>:<authTag_hex>:<ciphertext_hex>" string.
 */
export function encryptValue(plaintext: string, hubRoot: string): string {
  const key = deriveKey(hubRoot);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a value previously produced by `encryptValue`.
 * Throws if the blob is malformed or the auth tag check fails.
 */
export function decryptValue(encrypted: string, hubRoot: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format (expected iv:authTag:ciphertext).');
  }
  const ivHex = parts[0]!;
  const authTagHex = parts[1]!;
  const ciphertextHex = parts[2]!;
  const key = deriveKey(hubRoot);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  if (iv.length !== IV_LEN || authTag.length !== TAG_LEN) {
    throw new Error('Invalid encrypted value format (bad iv or authTag length).');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Encrypt a whole env-vars map. Returns a new map with the same keys but
 * encrypted values. Pass the result to ProjectConfig.envVars for storage.
 */
export function encryptEnvVars(
  vars: Record<string, string>,
  hubRoot: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k] = encryptValue(v, hubRoot);
  }
  return out;
}

/**
 * Decrypt a whole env-vars map stored in ProjectConfig. Returns plain
 * key→value pairs ready for injection into a child process's env.
 * Values that cannot be decrypted are skipped with a console.error warning
 * so that a single corrupted credential does not block project start.
 */
export function decryptEnvVars(
  vars: Record<string, string>,
  hubRoot: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    try {
      out[k] = decryptValue(v, hubRoot);
    } catch {
      console.error(
        `[shepaw-hub] Warning: could not decrypt env var "${k}" — skipping. ` +
        `Re-save the credential via 'project update --env ${k}=<value>'.`,
      );
    }
  }
  return out;
}
