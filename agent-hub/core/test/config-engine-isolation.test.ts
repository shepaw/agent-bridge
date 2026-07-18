/**
 * Hub config load must isolate unknown engines: one stale/future engine id
 * must never prevent loading other instances (peer routing, catalog, etc.).
 */

import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOrCreateHubConfig } from '../src/config.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shepaw-hub-cfg-'));
  prevHome = process.env.SHEPAW_HUB_HOME;
  process.env.SHEPAW_HUB_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.SHEPAW_HUB_HOME;
  else process.env.SHEPAW_HUB_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeHubJson(body: unknown): void {
  const path = join(home, 'hub.json');
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe('hub config engine isolation', () => {
  it('loads other instances when one references an unknown engine', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeHubJson({
      version: 1,
      instances: [
        {
          id: 'claude-ok',
          label: 'Claude',
          engine: 'claude-code',
          cwd: home,
          port: 18001,
          host: '127.0.0.1',
          baseUrl: '',
          extraArgs: [],
          createdAt: new Date().toISOString(),
          envVars: {},
        },
        {
          id: 'future-engine',
          label: 'Future',
          engine: 'not-a-real-engine-yet',
          cwd: home,
          port: 18002,
          host: '127.0.0.1',
          baseUrl: '',
          extraArgs: [],
          createdAt: new Date().toISOString(),
          envVars: {},
        },
      ],
      customEngines: [],
    });

    const cfg = loadOrCreateHubConfig();
    expect(cfg.instances).toHaveLength(2);
    expect(cfg.instances.map((i) => i.id)).toEqual(['claude-ok', 'future-engine']);
    expect(cfg.instances[1]!.engine).toBe('not-a-real-engine-yet');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('unknown engine');
  });

  it('recognizes built-in kimi engine without customEngines entry', () => {
    writeHubJson({
      version: 1,
      instances: [
        {
          id: 'shepaw-kimi',
          label: 'Kimi',
          engine: 'kimi',
          cwd: home,
          port: 18003,
          host: '127.0.0.1',
          baseUrl: '',
          extraArgs: [],
          createdAt: new Date().toISOString(),
          envVars: {},
        },
        {
          id: 'agent-bridge-claude',
          label: 'Claude',
          engine: 'claude-code',
          cwd: home,
          port: 18004,
          host: '127.0.0.1',
          baseUrl: '',
          extraArgs: [],
          createdAt: new Date().toISOString(),
          envVars: {},
        },
      ],
      customEngines: [],
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadOrCreateHubConfig();
    expect(cfg.instances).toHaveLength(2);
    expect(cfg.instances.find((i) => i.id === 'shepaw-kimi')?.engine).toBe('kimi');
    expect(warn).not.toHaveBeenCalled();
  });
});
