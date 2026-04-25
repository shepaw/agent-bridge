/**
 * Authorized peers allowlist — v2.1 per-device public-key authorization.
 *
 * Persisted to disk (default `~/.config/shepaw-cb-gateway/authorized_peers.json`)
 * next to `identity.json`. Each entry is an app's 32-byte X25519 static public key
 * plus a human-readable label, keyed by 16-hex fingerprint.
 *
 * Security model: this file replaces v2's `--token` flag as the ONLY mechanism
 * that decides whether a peer can talk to the agent. The agent SDK loads this
 * once at startup, watches it for changes (via `fs.watch`), and rejects any
 * Noise handshake whose `peerStaticPublicKey` is not listed.
 *
 * On-disk format is intentionally trivial so operators can `jq` / `vi` it if
 * they want — but all mutations from the SDK / CLI go through `addPeer` /
 * `removePeerByFingerprint` to keep the derived-fingerprint invariant.
 *
 * Contrast with identity.json: authorized_peers.json holds only PUBLIC keys.
 * Its loss is a privacy leak (you learn which devices are authorized) but not a
 * key compromise — no one can impersonate anyone from it.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ── types ──────────────────────────────────────────────────────────

export interface AuthorizedPeer {
  /** 16-hex short fingerprint: first 8 bytes of `sha256(publicKey)`. Matches the `#fp=` URL fragment. */
  readonly fingerprint: string;
  /** Raw 32-byte X25519 public key. */
  readonly publicKey: Uint8Array;
  /** Human-readable label (e.g. "iPhone 15"). Empty string if operator didn't set one. */
  readonly label: string;
  /** ISO 8601 UTC timestamp of when this peer was first added. */
  readonly addedAt: string;
}

export interface AuthorizedPeers {
  /** Absolute path this list was loaded from. */
  readonly path: string;
  readonly peers: ReadonlyArray<AuthorizedPeer>;
}

export interface LoadOrCreatePeersOptions {
  /** Explicit override. Falls through to env + XDG + home default. */
  path?: string;
}

// ── public API ─────────────────────────────────────────────────────

/** Derive 16-hex fingerprint from raw 32-byte X25519 public key. Same algorithm as `identity.derivedFingerprint`. */
export function derivedPeerFingerprint(pub: Uint8Array): string {
  const digest = createHash('sha256').update(pub).digest();
  return digest.subarray(0, 8).toString('hex');
}

/**
 * Resolve the authorized_peers.json path, in precedence order:
 *   1. explicit `override`
 *   2. `SHEPAW_PEERS_PATH` env var
 *   3. `$XDG_CONFIG_HOME/shepaw-cb-gateway/authorized_peers.json`
 *   4. `~/.config/shepaw-cb-gateway/authorized_peers.json`
 */
export function resolvePeersPath(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const envPath = process.env.SHEPAW_PEERS_PATH;
  if (envPath !== undefined && envPath.length > 0) return envPath;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'shepaw-cb-gateway', 'authorized_peers.json');
}

/**
 * Load the authorized peers list from disk, creating an empty one if missing.
 *
 * Failure modes (all throw):
 *   - Unix permission broader than 0600 on an existing file.
 *   - JSON malformed; individual entries with wrong key length / mismatched
 *     derived fingerprint; unsupported version.
 */
export function loadOrCreatePeers(opts: LoadOrCreatePeersOptions = {}): AuthorizedPeers {
  const path = resolvePeersPath(opts.path);

  if (existsSync(path)) {
    return loadExisting(path);
  }
  return createEmpty(path);
}

/**
 * Idempotently authorize a peer by its base64-encoded 32-byte X25519 public key.
 *
 * If the peer (matched by public key bytes, not label) is already present, returns
 * the existing entry unchanged. Otherwise appends a new entry and atomically
 * rewrites the file.
 *
 * The `label` defaults to an empty string; UIs should surface "unlabeled" for those.
 */
export function addPeer(
  path: string,
  publicKeyB64: string,
  label?: string,
): AuthorizedPeer {
  const pub = decodeAndValidatePubkey(publicKeyB64);
  const fp = derivedPeerFingerprint(pub);
  const existing = loadOrCreatePeers({ path });

  const alreadyHere = existing.peers.find((p) => bytesEqual(p.publicKey, pub));
  if (alreadyHere !== undefined) {
    return alreadyHere;
  }

  const entry: AuthorizedPeer = {
    fingerprint: fp,
    publicKey: pub,
    label: label ?? '',
    addedAt: new Date().toISOString(),
  };

  const next = [...existing.peers, entry];
  persist(path, next);
  return entry;
}

/**
 * Remove the peer with the given 16-hex fingerprint.
 *
 * Returns `true` if an entry was removed, `false` if no match was found.
 * Fingerprint comparison is case-insensitive.
 */
export function removePeerByFingerprint(path: string, fingerprint: string): boolean {
  const fp = fingerprint.toLowerCase();
  const existing = loadOrCreatePeers({ path });
  const filtered = existing.peers.filter((p) => p.fingerprint !== fp);
  if (filtered.length === existing.peers.length) {
    return false;
  }
  persist(path, filtered);
  return true;
}

/**
 * Look up an authorized peer by its raw 32-byte X25519 public key. Returns `undefined`
 * if the peer is not on the allowlist — this is the hot path called per WebSocket
 * connection right after the Noise handshake completes.
 */
export function isPeerAuthorized(
  peers: AuthorizedPeers,
  peerStaticPublicKey: Uint8Array,
): AuthorizedPeer | undefined {
  for (const p of peers.peers) {
    if (bytesEqual(p.publicKey, peerStaticPublicKey)) return p;
  }
  return undefined;
}

// ── internals ──────────────────────────────────────────────────────

interface OnDiskPeerSchema {
  fingerprint: string;
  publicKey: string;  // base64
  label: string;
  addedAt: string;
}

interface OnDiskSchema {
  version: 1;
  peers: OnDiskPeerSchema[];
}

function loadExisting(path: string): AuthorizedPeers {
  // Unix permission guard — don't touch Windows where mode bits are meaningless.
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Authorized peers at ${path} has mode ${mode.toString(8).padStart(3, '0')}; ` +
          `expected 0600. Refusing to load — 'chmod 600 ${path}'.`,
      );
    }
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Authorized peers at ${path} is not valid JSON: ${formatErr(err)}`);
  }

  const schema = parseSchema(parsed, path);

  const peers: AuthorizedPeer[] = [];
  for (let i = 0; i < schema.peers.length; i++) {
    const entry = schema.peers[i];
    if (entry === undefined) continue; // TS noUncheckedIndexedAccess

    const pub = Buffer.from(entry.publicKey, 'base64');
    if (pub.length !== 32) {
      throw new Error(
        `Authorized peers at ${path}: entry #${i} publicKey must be 32 bytes (got ${pub.length}).`,
      );
    }
    const derived = derivedPeerFingerprint(pub);
    if (derived !== entry.fingerprint.toLowerCase()) {
      throw new Error(
        `Authorized peers at ${path}: entry #${i} fingerprint '${entry.fingerprint}' does not match ` +
          `derivedPeerFingerprint(publicKey) = '${derived}'. File tampered or corrupted.`,
      );
    }

    peers.push({
      fingerprint: derived,
      publicKey: new Uint8Array(pub),
      label: entry.label,
      addedAt: entry.addedAt,
    });
  }

  return { path, peers };
}

function createEmpty(path: string): AuthorizedPeers {
  persist(path, []);
  return { path, peers: [] };
}

function parseSchema(parsed: unknown, path: string): OnDiskSchema {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Authorized peers at ${path}: root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `Authorized peers at ${path}: unsupported 'version' ${String(obj.version)} (expected 1).`,
    );
  }
  if (!Array.isArray(obj.peers)) {
    throw new Error(`Authorized peers at ${path}: 'peers' must be an array.`);
  }

  const peers: OnDiskPeerSchema[] = [];
  for (let i = 0; i < obj.peers.length; i++) {
    const raw = obj.peers[i];
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Authorized peers at ${path}: entry #${i} must be a JSON object.`);
    }
    const p = raw as Record<string, unknown>;
    for (const key of ['fingerprint', 'publicKey', 'addedAt'] as const) {
      if (typeof p[key] !== 'string' || (p[key] as string).length === 0) {
        throw new Error(
          `Authorized peers at ${path}: entry #${i} missing or invalid '${key}'.`,
        );
      }
    }
    peers.push({
      fingerprint: p.fingerprint as string,
      publicKey: p.publicKey as string,
      label: typeof p.label === 'string' ? p.label : '',
      addedAt: p.addedAt as string,
    });
  }

  return { version: 1, peers };
}

function persist(path: string, peers: ReadonlyArray<AuthorizedPeer>): void {
  const schema: OnDiskSchema = {
    version: 1,
    peers: peers.map((p) => ({
      fingerprint: p.fingerprint,
      publicKey: Buffer.from(p.publicKey).toString('base64'),
      label: p.label,
      addedAt: p.addedAt,
    })),
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(schema, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function decodeAndValidatePubkey(publicKeyB64: string): Uint8Array {
  let buf: Buffer;
  try {
    buf = Buffer.from(publicKeyB64, 'base64');
  } catch (err) {
    throw new Error(`Invalid base64 public key: ${formatErr(err)}`);
  }
  if (buf.length !== 32) {
    throw new Error(
      `Public key must decode to 32 bytes (got ${buf.length}). Input: ${publicKeyB64.slice(0, 24)}…`,
    );
  }
  // Re-encode and compare to catch base64 that contains trailing garbage that Node
  // silently ignores (e.g. "abcd====extra" decodes to 3 bytes but is clearly malformed).
  const canonical = buf.toString('base64');
  if (canonical !== publicKeyB64 && canonical.replace(/=+$/, '') !== publicKeyB64.replace(/=+$/, '')) {
    // Allow base64url variants (hyphen/underscore) by canonicalizing both sides.
    const b64urlNormalized = publicKeyB64.replace(/-/g, '+').replace(/_/g, '/');
    if (canonical !== b64urlNormalized && canonical.replace(/=+$/, '') !== b64urlNormalized.replace(/=+$/, '')) {
      throw new Error(`Public key base64 contains extra characters: ${publicKeyB64}`);
    }
  }
  return new Uint8Array(buf);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
