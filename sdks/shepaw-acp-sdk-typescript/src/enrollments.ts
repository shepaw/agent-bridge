/**
 * Enrollment tokens — v2.1 one-time pairing bootstrap.
 *
 * Problem: to pair a new Shepaw app with an agent, the app's X25519 static
 * public key has to end up in `authorized_peers.json`. Doing that manually
 * means copy-pasting the app's pubkey and typing `peers add <pubkey>` on the
 * agent host. Works, but tedious when pairing the first time or setting up a
 * new phone.
 *
 * Solution: the operator runs `<gateway> enroll`, which mints a short-lived,
 * single-use 9-character token (e.g. `4B7-9KX-M2P`) and prints it (plus a QR
 * with the URL + fingerprint + this code). The app scans the QR or types the
 * code into its pairing screen; the first byte of its Noise msg-1 payload
 * carries `{enroll: "..."}`. The server consumes the token on successful
 * handshake, automatically adds the app's pubkey to `authorized_peers.json`,
 * and the session proceeds as if the peer had been authorized out-of-band.
 *
 * Security properties:
 *   - Tokens are 9 chars from a 31-char Crockford-style alphabet
 *     (no 0/O/I/L/1 confusion) → ≈44 bits of entropy per token. Within the
 *     10-minute TTL, brute force requires 2^43 expected guesses; even at
 *     1000 tries/sec this is ~140 years. The agent rate-limits by refusing
 *     invalid tokens at the Noise-authenticated layer (post-handshake), so an
 *     attacker first has to complete a Noise handshake to even attempt guess.
 *   - Tokens travel INSIDE the Noise-encrypted handshake payload — Channel
 *     Service only sees AEAD ciphertext.
 *   - Single-use: consuming a token deletes it atomically before continuing
 *     the handshake, so a race between two peers on the same code resolves to
 *     one winner, one 4405.
 *   - TTL: default 10 minutes. Expired tokens are purged on every load and on
 *     every consume attempt, so the on-disk file self-maintains.
 *   - File is 0600 on Unix. Loss of this file leaks nothing but the ability
 *     to complete an in-flight enrollment during its TTL — NOT agent/peer
 *     private keys.
 *
 * On-disk format is a sibling to authorized_peers.json, intentionally separate
 * so `peers` and `enrollments` can evolve independently. Operators CAN `jq`
 * this file but should not — it self-cleans and the CLI is the supported
 * interface.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ── types ──────────────────────────────────────────────────────────

export interface EnrollmentToken {
  /** Normalized 9-char code, e.g. "4B79KXM2P" (display form: "4B7-9KX-M2P"). */
  readonly code: string;
  /** Optional label to attach to the peer that consumes this token. */
  readonly label: string;
  /** ISO 8601 UTC timestamp when this token was minted. */
  readonly createdAt: string;
  /** ISO 8601 UTC timestamp when this token stops being valid. */
  readonly expiresAt: string;
}

export interface Enrollments {
  readonly path: string;
  readonly tokens: ReadonlyArray<EnrollmentToken>;
}

export interface LoadOrCreateEnrollmentsOptions {
  /** Explicit override. Falls through to env + XDG + home default. */
  path?: string;
}

export interface CreateEnrollmentTokenOptions {
  /** Human-readable label for the peer this token will authorize. Defaults to empty. */
  label?: string;
  /** Override TTL in milliseconds. Default 10 minutes. */
  ttlMs?: number;
  /** Used only by tests to control Date.now(). */
  now?: () => Date;
}

export interface ConsumeResult {
  readonly token: EnrollmentToken;
}

export class EnrollmentError extends Error {
  override readonly name = 'EnrollmentError';
  constructor(
    message: string,
    readonly reason:
      | 'not_found'
      | 'expired'
      | 'invalid_format'
      | 'already_consumed',
  ) {
    super(message);
  }
}

// ── public API ─────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_LENGTH = 9;
// Crockford-style alphabet: removed 0/O, I/1/L to avoid ambiguity on small
// fonts and shoulder-surfing through a printed QR. 31 chars → ~44 bits / 9.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Resolve the enrollments.json path, in precedence order:
 *   1. explicit `override`
 *   2. `SHEPAW_ENROLLMENTS_PATH` env var
 *   3. `$XDG_CONFIG_HOME/shepaw-cb-gateway/enrollments.json`
 *   4. `~/.config/shepaw-cb-gateway/enrollments.json`
 *
 * Deliberately the same parent dir as identity.json / authorized_peers.json so
 * all three live together — operators back them up (or don't) as a unit.
 */
export function resolveEnrollmentsPath(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const envPath = process.env.SHEPAW_ENROLLMENTS_PATH;
  if (envPath !== undefined && envPath.length > 0) return envPath;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'shepaw-cb-gateway', 'enrollments.json');
}

/**
 * Load enrollments from disk, creating an empty file if missing. Expired
 * tokens are pruned on every load, and the file is rewritten if any were
 * dropped — the caller sees only currently-valid tokens.
 */
export function loadOrCreateEnrollments(
  opts: LoadOrCreateEnrollmentsOptions = {},
): Enrollments {
  const path = resolveEnrollmentsPath(opts.path);

  if (!existsSync(path)) {
    persist(path, []);
    return { path, tokens: [] };
  }

  const raw = loadRaw(path);
  const now = Date.now();
  const live = raw.tokens.filter((t) => parseTs(t.expiresAt) > now);
  if (live.length !== raw.tokens.length) {
    // Garbage-collect expired tokens on every read. Cheap; bounded by TTL.
    persist(path, live);
  }
  return { path, tokens: live };
}

/**
 * Mint a new single-use enrollment token and persist it.
 *
 * Returns the new token with its normalized 9-char `code`. Display UIs should
 * format as `XXX-XXX-XXX` via `formatCodeForDisplay`.
 *
 * Collision probability: with 9 chars from 31 alphabet ≈ 2.6e13 possible
 * codes. Even with 100 concurrent tokens outstanding, collision is <1e-10.
 * We still verify uniqueness against the current list to be safe.
 */
export function createEnrollmentToken(
  path: string,
  opts: CreateEnrollmentTokenOptions = {},
): EnrollmentToken {
  const now = opts.now ? opts.now() : new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`ttlMs must be a positive finite number, got ${String(ttlMs)}`);
  }

  const current = loadOrCreateEnrollments({ path });
  const taken = new Set(current.tokens.map((t) => t.code));

  let code = '';
  for (let attempt = 0; attempt < 16; attempt++) {
    code = randomCode();
    if (!taken.has(code)) break;
  }
  if (taken.has(code)) {
    // Cosmically unlikely; tests force this by filling the alphabet.
    throw new Error('Failed to generate a unique enrollment code after 16 attempts.');
  }

  const token: EnrollmentToken = {
    code,
    label: opts.label ?? '',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  persist(path, [...current.tokens, token]);
  return token;
}

/**
 * Attempt to consume a token by its user-supplied code. Normalizes the input
 * (lowercase letters → upper, hyphens and spaces stripped, 0→O/1→I remapped
 * where unambiguous), rejects expired/missing tokens, and removes the token
 * on success BEFORE returning — a second consume of the same code always
 * fails.
 *
 * This is the security-critical path; callers must treat a thrown
 * EnrollmentError as a hard "no" and refuse to authorize the peer.
 */
export function consumeEnrollmentToken(path: string, rawCode: string): ConsumeResult {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) {
    throw new EnrollmentError(
      `Enrollment code must normalize to ${CODE_LENGTH} characters (got ${code.length}).`,
      'invalid_format',
    );
  }

  const current = loadOrCreateEnrollments({ path });
  const match = current.tokens.find((t) => t.code === code);
  if (match === undefined) {
    throw new EnrollmentError(
      'Enrollment code not recognized (expired, already used, or never issued).',
      'not_found',
    );
  }

  // loadOrCreateEnrollments already filtered expired, but re-check with a
  // fresh clock to close the race between load and consume.
  if (parseTs(match.expiresAt) <= Date.now()) {
    // Drop it as part of the same write that would've removed it anyway.
    persist(path, current.tokens.filter((t) => t.code !== code));
    throw new EnrollmentError(
      `Enrollment code expired at ${match.expiresAt}.`,
      'expired',
    );
  }

  // Remove BEFORE returning. If persist() throws (disk full, permission
  // change), we propagate — never hand a consumed-but-not-erased token back.
  const remaining = current.tokens.filter((t) => t.code !== code);
  persist(path, remaining);

  return { token: match };
}

/**
 * Remove a token by code without consuming it — used by the CLI to revoke
 * a mistakenly-issued token before anyone has a chance to use it.
 */
export function revokeEnrollmentToken(path: string, rawCode: string): boolean {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return false;

  const current = loadOrCreateEnrollments({ path });
  const filtered = current.tokens.filter((t) => t.code !== code);
  if (filtered.length === current.tokens.length) return false;
  persist(path, filtered);
  return true;
}

/**
 * Format a 9-character code as `XXX-XXX-XXX` for display.
 * Inverse is `normalizeCode`, which strips the hyphens.
 */
export function formatCodeForDisplay(code: string): string {
  if (code.length !== CODE_LENGTH) return code;
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

/**
 * Normalize user input for comparison. Uppercases, strips whitespace,
 * hyphens, and any characters outside the code alphabet.
 *
 * The alphabet deliberately excludes 0/1/O/I/L to remove visual ambiguity.
 * If a user types one of those (reading "O" as "0" etc.), the character is
 * silently dropped here and the length check upstream catches the mismatch.
 * We don't try to guess — remapping is error-prone and can turn a typo into
 * a valid-but-wrong code.
 */
export function normalizeCode(input: string): string {
  const upper = input.replace(/[-\s]/g, '').toUpperCase();
  let out = '';
  for (const ch of upper) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

// ── internals ──────────────────────────────────────────────────────

interface OnDiskTokenSchema {
  code: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

interface OnDiskSchema {
  version: 1;
  tokens: OnDiskTokenSchema[];
}

function randomCode(): string {
  // Use rejection sampling on raw random bytes so every code is uniform over
  // the 31-char alphabet. 256 % 31 = 8, so reject bytes >= 248.
  const out: string[] = [];
  while (out.length < CODE_LENGTH) {
    const buf = randomBytes(CODE_LENGTH * 2); // over-draw
    for (let i = 0; i < buf.length && out.length < CODE_LENGTH; i++) {
      const b = buf[i] ?? 0;
      if (b >= 248) continue;
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
    }
  }
  return out.join('');
}

function loadRaw(path: string): Enrollments {
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Enrollments at ${path} has mode ${mode.toString(8).padStart(3, '0')}; ` +
          `expected 0600. Refusing to load — 'chmod 600 ${path}'.`,
      );
    }
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Enrollments at ${path} is not valid JSON: ${formatErr(err)}`);
  }

  const schema = parseSchema(parsed, path);
  return {
    path,
    tokens: schema.tokens.map((t) => ({
      code: t.code,
      label: t.label,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    })),
  };
}

function parseSchema(parsed: unknown, path: string): OnDiskSchema {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Enrollments at ${path}: root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `Enrollments at ${path}: unsupported 'version' ${String(obj.version)} (expected 1).`,
    );
  }
  if (!Array.isArray(obj.tokens)) {
    throw new Error(`Enrollments at ${path}: 'tokens' must be an array.`);
  }

  const out: OnDiskTokenSchema[] = [];
  for (let i = 0; i < obj.tokens.length; i++) {
    const raw = obj.tokens[i];
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`Enrollments at ${path}: entry #${i} must be a JSON object.`);
    }
    const t = raw as Record<string, unknown>;
    for (const key of ['code', 'createdAt', 'expiresAt'] as const) {
      if (typeof t[key] !== 'string' || (t[key] as string).length === 0) {
        throw new Error(
          `Enrollments at ${path}: entry #${i} missing or invalid '${key}'.`,
        );
      }
    }
    out.push({
      code: t.code as string,
      label: typeof t.label === 'string' ? t.label : '',
      createdAt: t.createdAt as string,
      expiresAt: t.expiresAt as string,
    });
  }
  return { version: 1, tokens: out };
}

function persist(path: string, tokens: ReadonlyArray<EnrollmentToken>): void {
  const schema: OnDiskSchema = {
    version: 1,
    tokens: tokens.map((t) => ({
      code: t.code,
      label: t.label,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    })),
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(schema, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function parseTs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return ms;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
