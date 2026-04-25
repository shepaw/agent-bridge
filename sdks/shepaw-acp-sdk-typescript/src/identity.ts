/**
 * Agent long-term identity (X25519 static keypair + derived agentId + fingerprint).
 *
 * Persisted to disk (default `~/.config/shepaw-cb-gateway/identity.json`) so the
 * agentId stays stable across restarts, and so the Noise IK handshake in v2 has a
 * stable responder static key to pin against.
 *
 * Hash-algorithm note: the *fingerprint* is SHA-256(pubkey)[0..8], which is
 * independent of the *Noise* internal hash (we use `Noise_IK_25519_ChaChaPoly_BLAKE2b`
 * for handshake + transport). Keeping the fingerprint on SHA-256 makes the
 * cross-language fixture trivial and avoids Dart having to pull BLAKE2 just for
 * the fingerprint path.
 *
 * v2 protocol note: although this file lands before the Noise wiring, the on-disk
 * format is the same one the handshake will consume, so no second migration is
 * needed when the rest of v2 ships.
 */

import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ── types ──────────────────────────────────────────────────────────

export interface AgentIdentity {
  /** Derived from publicKey — "acp_agent_" + first 4 bytes of sha256(pub) as hex. Stable across restarts. */
  readonly agentId: string;
  /** 32-byte raw X25519 public key. */
  readonly staticPublicKey: Uint8Array;
  /** 32-byte raw X25519 private key. */
  readonly staticPrivateKey: Uint8Array;
  /** 16-hex short fingerprint: first 8 bytes of sha256(pub). Matches what gets pasted into Shepaw URLs as `#fp=…`. */
  readonly fingerprint: string;
  readonly createdAt: string;
  /** Absolute path this identity was loaded from (or written to). Useful for logs. */
  readonly path: string;
}

export interface LoadOrCreateIdentityOptions {
  /** Explicit override. Falls through to env + XDG + home default. */
  path?: string;
}

// ── public API ─────────────────────────────────────────────────────

/** Derive agentId from raw 32-byte X25519 public key. Always 20 hex chars (`acp_agent_` + 8 hex). */
export function derivedAgentId(pub: Uint8Array): string {
  const digest = createHash('sha256').update(pub).digest();
  return `acp_agent_${digest.subarray(0, 4).toString('hex')}`;
}

/** Derive 16-hex fingerprint from raw 32-byte X25519 public key. */
export function derivedFingerprint(pub: Uint8Array): string {
  const digest = createHash('sha256').update(pub).digest();
  return digest.subarray(0, 8).toString('hex');
}

/**
 * Resolve the identity file path, in precedence order:
 *   1. explicit `override`
 *   2. `SHEPAW_IDENTITY_PATH` env var
 *   3. `$XDG_CONFIG_HOME/shepaw-cb-gateway/identity.json`
 *   4. `~/.config/shepaw-cb-gateway/identity.json`
 */
export function resolveIdentityPath(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const envPath = process.env.SHEPAW_IDENTITY_PATH;
  if (envPath !== undefined && envPath.length > 0) return envPath;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'shepaw-cb-gateway', 'identity.json');
}

/**
 * Load the identity from disk, or create and persist a fresh one if missing.
 *
 * Failure modes (all throw):
 *   - Unix permission broader than 0600 on an existing file (possible key exposure) — we refuse
 *     to load rather than silently "fix" it; the operator should rotate or chmod manually.
 *   - JSON malformed / wrong key length / derived agentId doesn't match stored agentId.
 *
 * Atomicity: new files are written via `.tmp` + `rename` so a crash mid-write can never
 * leave a half-written identity on disk.
 */
export function loadOrCreateIdentity(opts: LoadOrCreateIdentityOptions = {}): AgentIdentity {
  const path = resolveIdentityPath(opts.path);

  if (existsSync(path)) {
    return loadExisting(path);
  }
  return createAndPersist(path);
}

// ── internals ──────────────────────────────────────────────────────

interface OnDiskSchema {
  version: 1;
  agentId: string;
  staticPublicKey: string;  // base64
  staticPrivateKey: string; // base64
  createdAt: string;
}

function loadExisting(path: string): AgentIdentity {
  // Unix permission guard — don't touch Windows where mode bits are meaningless.
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Agent identity at ${path} has mode ${mode.toString(8).padStart(3, '0')}; ` +
          `expected 0600. Refusing to load — 'chmod 600 ${path}' or rotate.`,
      );
    }
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Agent identity at ${path} is not valid JSON: ${formatErr(err)}`);
  }

  const schema = parseSchema(parsed, path);

  const pub = Buffer.from(schema.staticPublicKey, 'base64');
  const priv = Buffer.from(schema.staticPrivateKey, 'base64');
  if (pub.length !== 32) {
    throw new Error(`Agent identity at ${path}: staticPublicKey must be 32 bytes (got ${pub.length}).`);
  }
  if (priv.length !== 32) {
    throw new Error(`Agent identity at ${path}: staticPrivateKey must be 32 bytes (got ${priv.length}).`);
  }

  const derived = derivedAgentId(pub);
  if (derived !== schema.agentId) {
    throw new Error(
      `Agent identity at ${path}: stored agentId '${schema.agentId}' does not match ` +
        `derivedAgentId(publicKey) = '${derived}'. File tampered or corrupted.`,
    );
  }

  return {
    agentId: schema.agentId,
    staticPublicKey: new Uint8Array(pub),
    staticPrivateKey: new Uint8Array(priv),
    fingerprint: derivedFingerprint(pub),
    createdAt: schema.createdAt,
    path,
  };
}

function createAndPersist(path: string): AgentIdentity {
  const { publicKey, privateKey } = generateX25519Keypair();
  const agentId = derivedAgentId(publicKey);
  const createdAt = new Date().toISOString();

  const schema: OnDiskSchema = {
    version: 1,
    agentId,
    staticPublicKey: Buffer.from(publicKey).toString('base64'),
    staticPrivateKey: Buffer.from(privateKey).toString('base64'),
    createdAt,
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // Atomic write: tmp file (mode 0600 upfront so the window of broader perms is zero) + rename.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(schema, null, 2), { mode: 0o600 });
  // writeFileSync honors `mode` only at create; chmod defensively in case the file pre-existed.
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);

  return {
    agentId,
    staticPublicKey: publicKey,
    staticPrivateKey: privateKey,
    fingerprint: derivedFingerprint(publicKey),
    createdAt,
    path,
  };
}

function parseSchema(parsed: unknown, path: string): OnDiskSchema {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Agent identity at ${path}: root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Agent identity at ${path}: unsupported 'version' ${String(obj.version)} (expected 1).`);
  }
  for (const key of ['agentId', 'staticPublicKey', 'staticPrivateKey', 'createdAt'] as const) {
    if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
      throw new Error(`Agent identity at ${path}: missing or invalid '${key}'.`);
    }
  }
  return {
    version: 1,
    agentId: obj.agentId as string,
    staticPublicKey: obj.staticPublicKey as string,
    staticPrivateKey: obj.staticPrivateKey as string,
    createdAt: obj.createdAt as string,
  };
}

/**
 * Generate a raw 32-byte X25519 keypair via Node's built-in crypto.
 *
 * Node returns the keypair as KeyObjects; we convert to raw 32-byte buffers in the
 * same format Noise (and every other curve25519 library) expects. Private keys come out
 * wrapped in DER (PKCS#8); the last 32 bytes are the raw scalar. Public keys come out
 * in DER SubjectPublicKeyInfo; the last 32 bytes are the raw Montgomery-u value.
 *
 * We use the 'jwk' export instead, which is explicit: `{ kty: 'OKP', crv: 'X25519', x, d }`
 * — base64url raw bytes, no DER parsing needed.
 */
function generateX25519Keypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');

  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (pubJwk.x === undefined || privJwk.d === undefined) {
    throw new Error('Node crypto returned an X25519 keypair without the expected JWK fields.');
  }

  const pub = Buffer.from(pubJwk.x, 'base64url');
  const priv = Buffer.from(privJwk.d, 'base64url');
  if (pub.length !== 32 || priv.length !== 32) {
    throw new Error(
      `Node crypto returned an X25519 keypair with unexpected lengths: pub=${pub.length}, priv=${priv.length}.`,
    );
  }

  return { publicKey: new Uint8Array(pub), privateKey: new Uint8Array(priv) };
}

/**
 * Sanity check that `priv` is the private counterpart to `pub`. Useful in tests and as
 * an assertion in the identity loader before returning to callers. Not called on the
 * happy path to avoid paying a scalarmult on every startup — the `derivedAgentId`
 * cross-check already catches disk corruption.
 */
export function verifyKeypair(pub: Uint8Array, priv: Uint8Array): boolean {
  try {
    const derivedPub = createPublicKey(
      createPrivateKey({
        key: {
          kty: 'OKP',
          crv: 'X25519',
          d: Buffer.from(priv).toString('base64url'),
          x: Buffer.from(pub).toString('base64url'),
        },
        format: 'jwk',
      }),
    );
    const jwk = derivedPub.export({ format: 'jwk' }) as { x?: string };
    if (jwk.x === undefined) return false;
    const derivedBytes = Buffer.from(jwk.x, 'base64url');
    return derivedBytes.length === 32 && timingSafeEqual(derivedBytes, Buffer.from(pub));
  } catch {
    return false;
  }
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
