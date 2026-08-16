import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browseDirectory, handleFsBrowseReq, resolveBrowsePath } from '../src/fs-browse.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-fs-browse-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('resolveBrowsePath', () => {
  it('defaults empty path to home', () => {
    expect(resolveBrowsePath(undefined)).toBe(homedir());
    expect(resolveBrowsePath('')).toBe(homedir());
    expect(resolveBrowsePath('  ')).toBe(homedir());
  });

  it('expands ~', () => {
    expect(resolveBrowsePath('~')).toBe(homedir());
    expect(resolveBrowsePath('~/proj')).toBe(join(homedir(), 'proj'));
  });
});

describe('browseDirectory', () => {
  it('lists only child directories', async () => {
    mkdirSync(join(home, 'alpha'));
    mkdirSync(join(home, 'beta'));
    writeFileSync(join(home, 'file.txt'), 'x');

    const result = await browseDirectory(home);
    expect(result.path).toBe(home);
    expect(result.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(result.entries.every((e) => e.type === 'dir')).toBe(true);
  });
});

describe('handleFsBrowseReq', () => {
  it('returns home when path omitted', async () => {
    mkdirSync(join(home, 'docs'));
    const resp = await handleFsBrowseReq({ request_id: 'r1' });
    expect(resp.ok).toBe(true);
    expect(resp.path).toBe(home);
    expect(resp.entries).toEqual([
      { name: 'docs', path: join(home, 'docs'), type: 'dir' },
    ]);
  });

  it('returns error for missing path', async () => {
    const resp = await handleFsBrowseReq({
      request_id: 'r2',
      path: join(home, 'missing'),
    });
    expect(resp.ok).toBe(false);
    expect(String(resp.error)).toMatch(/does not exist/i);
  });
});
