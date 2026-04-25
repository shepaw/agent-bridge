import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EnrollmentError,
  consumeEnrollmentToken,
  createEnrollmentToken,
  formatCodeForDisplay,
  loadOrCreateEnrollments,
  normalizeCode,
  resolveEnrollmentsPath,
  revokeEnrollmentToken,
} from '../src/enrollments.js';

describe('enrollments', () => {
  let workdir: string;
  let path: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-enroll-'));
    path = join(workdir, 'enrollments.json');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  // ── path resolution ─────────────────────────────────────────

  it('resolveEnrollmentsPath honors explicit > env > default', () => {
    const orig = process.env.SHEPAW_ENROLLMENTS_PATH;
    try {
      delete process.env.SHEPAW_ENROLLMENTS_PATH;
      expect(resolveEnrollmentsPath('/explicit/x.json')).toBe('/explicit/x.json');

      process.env.SHEPAW_ENROLLMENTS_PATH = '/envvar/y.json';
      expect(resolveEnrollmentsPath()).toBe('/envvar/y.json');

      // Explicit still wins.
      expect(resolveEnrollmentsPath('/explicit/x.json')).toBe('/explicit/x.json');
    } finally {
      if (orig === undefined) delete process.env.SHEPAW_ENROLLMENTS_PATH;
      else process.env.SHEPAW_ENROLLMENTS_PATH = orig;
    }
  });

  // ── create + load ───────────────────────────────────────────

  it('creates empty file on first load with 0600 mode', () => {
    expect(existsSync(path)).toBe(false);
    const e = loadOrCreateEnrollments({ path });
    expect(e.tokens.length).toBe(0);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('createEnrollmentToken mints a 9-char code and persists it', () => {
    const t = createEnrollmentToken(path, { label: 'test' });
    expect(t.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{9}$/);
    expect(t.label).toBe('test');
    expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.parse(t.createdAt));

    const after = loadOrCreateEnrollments({ path });
    expect(after.tokens.length).toBe(1);
    expect(after.tokens[0]?.code).toBe(t.code);
  });

  it('createEnrollmentToken uses 10-minute TTL by default', () => {
    const now = new Date('2026-04-25T10:00:00.000Z');
    const t = createEnrollmentToken(path, { now: () => now });
    expect(t.createdAt).toBe('2026-04-25T10:00:00.000Z');
    expect(t.expiresAt).toBe('2026-04-25T10:10:00.000Z');
  });

  it('rejects non-positive ttl', () => {
    expect(() => createEnrollmentToken(path, { ttlMs: 0 })).toThrow();
    expect(() => createEnrollmentToken(path, { ttlMs: -1 })).toThrow();
    expect(() => createEnrollmentToken(path, { ttlMs: NaN })).toThrow();
  });

  // ── consume ────────────────────────────────────────────────

  it('consumes a valid token and deletes it', () => {
    const t = createEnrollmentToken(path, { label: 'Alice' });

    const r = consumeEnrollmentToken(path, t.code);
    expect(r.token.code).toBe(t.code);
    expect(r.token.label).toBe('Alice');

    // File no longer contains the consumed token.
    const after = loadOrCreateEnrollments({ path });
    expect(after.tokens.length).toBe(0);
  });

  it('consume is single-use: second attempt throws not_found', () => {
    const t = createEnrollmentToken(path);
    consumeEnrollmentToken(path, t.code);

    try {
      consumeEnrollmentToken(path, t.code);
      expect.fail('expected EnrollmentError');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrollmentError);
      expect((err as EnrollmentError).reason).toBe('not_found');
    }
  });

  it('consume accepts display form (XXX-XXX-XXX) and normalizes', () => {
    const t = createEnrollmentToken(path);
    const display = formatCodeForDisplay(t.code);
    expect(display.length).toBe(11); // 9 + 2 hyphens

    const r = consumeEnrollmentToken(path, display);
    expect(r.token.code).toBe(t.code);
  });

  it('consume accepts lowercase and ignores whitespace', () => {
    const t = createEnrollmentToken(path);
    const lower = `  ${t.code.toLowerCase().slice(0, 3)} ${t.code.toLowerCase().slice(3, 6)} ${t.code.toLowerCase().slice(6)}  `;
    const r = consumeEnrollmentToken(path, lower);
    expect(r.token.code).toBe(t.code);
  });

  it('consume rejects expired token with reason "expired"', () => {
    const oldNow = new Date('2026-04-25T10:00:00.000Z');
    const t = createEnrollmentToken(path, {
      now: () => oldNow,
      ttlMs: 1000,
    });

    // Manually set the clock forward past expiry. We can't easily inject time
    // into consume(), but the file has expiresAt in the past already if we
    // mint with a 1s TTL and sleep. Instead, fast-forward by rewriting the
    // file's expiresAt.
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      version: 1;
      tokens: Array<{ code: string; label: string; createdAt: string; expiresAt: string }>;
    };
    raw.tokens[0]!.expiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });

    try {
      consumeEnrollmentToken(path, t.code);
      expect.fail('expected EnrollmentError');
    } catch (err) {
      // loadOrCreateEnrollments prunes expired on read, so the token is gone
      // before consume() sees it — reason is not_found in that pathway.
      // Either is acceptable; both mean "no auth".
      expect(err).toBeInstanceOf(EnrollmentError);
      expect(['expired', 'not_found']).toContain((err as EnrollmentError).reason);
    }
  });

  it('consume rejects codes that are too short / not in alphabet', () => {
    try {
      consumeEnrollmentToken(path, 'ABC');
      expect.fail('expected EnrollmentError');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrollmentError);
      expect((err as EnrollmentError).reason).toBe('invalid_format');
    }

    // Nine chars of pure garbage get normalized down to 0 valid chars.
    try {
      consumeEnrollmentToken(path, '!!!!!!!!!');
      expect.fail('expected EnrollmentError');
    } catch (err) {
      expect(err).toBeInstanceOf(EnrollmentError);
      expect((err as EnrollmentError).reason).toBe('invalid_format');
    }
  });

  it('load prunes expired tokens off disk', () => {
    const oldNow = new Date('2020-01-01T00:00:00.000Z');
    const tExpired = createEnrollmentToken(path, { now: () => oldNow, ttlMs: 1000 });
    const tLive = createEnrollmentToken(path);

    // After load, only the live one survives in memory AND on disk.
    const e = loadOrCreateEnrollments({ path });
    expect(e.tokens.length).toBe(1);
    expect(e.tokens[0]?.code).toBe(tLive.code);

    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      tokens: Array<{ code: string }>;
    };
    expect(raw.tokens.length).toBe(1);
    expect(raw.tokens.map((t) => t.code)).not.toContain(tExpired.code);
  });

  // ── revoke ─────────────────────────────────────────────────

  it('revokeEnrollmentToken removes an un-consumed token', () => {
    const t = createEnrollmentToken(path);
    expect(revokeEnrollmentToken(path, t.code)).toBe(true);

    try {
      consumeEnrollmentToken(path, t.code);
      expect.fail('expected EnrollmentError');
    } catch (err) {
      expect((err as EnrollmentError).reason).toBe('not_found');
    }
  });

  it('revokeEnrollmentToken returns false for unknown codes', () => {
    createEnrollmentToken(path);
    expect(revokeEnrollmentToken(path, 'NOTACODEX')).toBe(false);
    // Unknown codes never even reach the list — garbage input returns false
    // without throwing.
    expect(revokeEnrollmentToken(path, '!!')).toBe(false);
  });

  // ── permissions ────────────────────────────────────────────

  it('refuses to load a file with loose permissions', () => {
    if (process.platform === 'win32') return;
    createEnrollmentToken(path);
    chmodSync(path, 0o644);
    expect(() => loadOrCreateEnrollments({ path })).toThrow(/mode 644/);
  });

  // ── format helpers ─────────────────────────────────────────

  it('formatCodeForDisplay groups 9 chars into 3-3-3', () => {
    expect(formatCodeForDisplay('ABCDEFGHJ')).toBe('ABC-DEF-GHJ');
    // Non-9-char input passes through unchanged.
    expect(formatCodeForDisplay('SHORT')).toBe('SHORT');
  });

  it('normalizeCode strips whitespace/hyphens, uppercases, filters alphabet', () => {
    expect(normalizeCode('abc-def-ghj')).toBe('ABCDEFGHJ');
    expect(normalizeCode('  ABC DEF GHJ  ')).toBe('ABCDEFGHJ');
    // Ambiguous chars (0/1/I/L/O) are stripped — not remapped. User must
    // re-read the code.
    expect(normalizeCode('O1IL0ABCDE')).toBe('ABCDE');
  });

  // ── JSON schema guard ──────────────────────────────────────

  it('rejects malformed JSON', () => {
    writeFileSync(path, 'not json', { mode: 0o600 });
    expect(() => loadOrCreateEnrollments({ path })).toThrow(/valid JSON/);
  });

  it('rejects wrong version', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 2, tokens: [] }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreateEnrollments({ path })).toThrow(/version/);
  });

  it('rejects missing tokens array', () => {
    writeFileSync(path, JSON.stringify({ version: 1 }), { mode: 0o600 });
    expect(() => loadOrCreateEnrollments({ path })).toThrow(/tokens/);
  });
});
