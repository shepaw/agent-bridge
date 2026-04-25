import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAlive, readState, writeState, type ProjectState } from '../src/spawn.js';

describe('spawn helpers (unit)', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-hub-spawn-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  describe('isAlive', () => {
    it('returns true for the current process', () => {
      expect(isAlive(process.pid)).toBe(true);
    });

    it('returns false for pid=0 / negative / non-integer', () => {
      expect(isAlive(0)).toBe(false);
      expect(isAlive(-1)).toBe(false);
      expect(isAlive(1.5)).toBe(false);
      expect(isAlive(Number.NaN)).toBe(false);
    });

    it('returns false for a clearly-dead pid', () => {
      // PID 99999999 is extremely unlikely to be assigned on any OS.
      expect(isAlive(99_999_999)).toBe(false);
    });
  });

  describe('readState / writeState', () => {
    it('round-trips a state object through disk', () => {
      const path = join(workdir, 'state.json');
      const state: ProjectState = {
        pid: 1234,
        port: 8090,
        startedAt: '2026-04-25T00:00:00.000Z',
      };
      writeState(path, state);
      expect(existsSync(path)).toBe(true);
      const loaded = readState(path);
      expect(loaded).toBeDefined();
      expect(loaded?.pid).toBe(1234);
      expect(loaded?.port).toBe(8090);
      expect(loaded?.startedAt).toBe('2026-04-25T00:00:00.000Z');
    });

    it('readState returns undefined for a missing file', () => {
      expect(readState(join(workdir, 'missing.json'))).toBeUndefined();
    });

    it('readState throws on corrupted file', () => {
      const path = join(workdir, 'state.json');
      require('node:fs').writeFileSync(path, 'not json');
      expect(() => readState(path)).toThrow(/valid JSON/);
    });

    it('writeState uses atomic rename (no .tmp left behind)', () => {
      const path = join(workdir, 'state.json');
      writeState(path, { pid: 1, port: 2, startedAt: 't' });
      expect(existsSync(path + '.tmp')).toBe(false);
      // Sanity check contents are exact JSON (not truncated).
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.pid).toBe(1);
    });

    it('readState preserves lastResult + stoppedAt when present', () => {
      const path = join(workdir, 'state.json');
      writeState(path, {
        pid: 0,
        port: 8090,
        startedAt: 't0',
        stoppedAt: 't1',
        lastResult: 'graceful',
      });
      const loaded = readState(path);
      expect(loaded?.lastResult).toBe('graceful');
      expect(loaded?.stoppedAt).toBe('t1');
    });
  });
});
