import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addProject,
  findProject,
  getProject,
  loadOrCreateHubConfig,
  ProjectExistsError,
  ProjectNotFoundError,
  removeProject,
  updateProject,
  type ProjectConfig,
} from '../src/config.js';

function fixture(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-a',
    label: 'Project A',
    engine: 'codebuddy',
    cwd: '/tmp/proj-a',
    port: 8090,
    host: '127.0.0.1',
    baseUrl: '',
    extraArgs: [],
    createdAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('config (hub.json)', () => {
  let workdir: string;
  let path: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'shepaw-hub-config-'));
    path = join(workdir, 'hub.json');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  // ── load / create ─────────────────────────────────────────────

  it('creates an empty config on first load with 0600 mode', () => {
    expect(existsSync(path)).toBe(false);
    const cfg = loadOrCreateHubConfig({ path });
    expect(cfg.projects.length).toBe(0);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to load a file with loose permissions', () => {
    if (process.platform === 'win32') return;
    loadOrCreateHubConfig({ path });
    chmodSync(path, 0o644);
    expect(() => loadOrCreateHubConfig({ path })).toThrow(/mode 644/);
  });

  it('rejects wrong version / non-JSON / missing projects array', () => {
    writeFileSync(path, 'not json', { mode: 0o600 });
    expect(() => loadOrCreateHubConfig({ path })).toThrow(/valid JSON/);

    writeFileSync(path, JSON.stringify({ version: 2, projects: [] }), { mode: 0o600 });
    expect(() => loadOrCreateHubConfig({ path })).toThrow(/version/);

    writeFileSync(path, JSON.stringify({ version: 1 }), { mode: 0o600 });
    expect(() => loadOrCreateHubConfig({ path })).toThrow(/projects/);
  });

  // ── add ───────────────────────────────────────────────────────

  it('addProject persists a new entry', () => {
    const cfg0 = loadOrCreateHubConfig({ path });
    const cfg1 = addProject(cfg0, fixture());
    expect(cfg1.projects.length).toBe(1);
    expect(cfg1.projects[0]?.id).toBe('proj-a');

    const reload = loadOrCreateHubConfig({ path });
    expect(reload.projects.length).toBe(1);
    expect(reload.projects[0]?.label).toBe('Project A');
  });

  it('addProject validates ids', () => {
    const cfg = loadOrCreateHubConfig({ path });
    expect(() => addProject(cfg, fixture({ id: 'has space' }))).toThrow();
  });

  it('addProject refuses duplicate id', () => {
    const cfg0 = loadOrCreateHubConfig({ path });
    const cfg1 = addProject(cfg0, fixture());
    expect(() => addProject(cfg1, fixture({ cwd: '/tmp/other' }))).toThrow(ProjectExistsError);
  });

  it('addProject refuses duplicate cwd (different id)', () => {
    const cfg0 = loadOrCreateHubConfig({ path });
    const cfg1 = addProject(cfg0, fixture());
    expect(() => addProject(cfg1, fixture({ id: 'proj-b' }))).toThrow(ProjectExistsError);
  });

  it('addProject refuses duplicate port', () => {
    const cfg0 = loadOrCreateHubConfig({ path });
    const cfg1 = addProject(cfg0, fixture());
    expect(() =>
      addProject(cfg1, fixture({ id: 'proj-b', cwd: '/tmp/other' })),
    ).toThrow(ProjectExistsError);
  });

  it('addProject validates port range', () => {
    const cfg = loadOrCreateHubConfig({ path });
    expect(() => addProject(cfg, fixture({ port: 0 }))).toThrow();
    expect(() => addProject(cfg, fixture({ port: 99_999 }))).toThrow();
    expect(() => addProject(cfg, fixture({ port: 1.5 }))).toThrow();
  });

  // ── find / get ────────────────────────────────────────────────

  it('findProject returns undefined for missing; getProject throws', () => {
    const cfg = loadOrCreateHubConfig({ path });
    expect(findProject(cfg, 'nope')).toBeUndefined();
    expect(() => getProject(cfg, 'nope')).toThrow(ProjectNotFoundError);
  });

  it('findProject/getProject find existing', () => {
    const cfg = addProject(loadOrCreateHubConfig({ path }), fixture());
    expect(findProject(cfg, 'proj-a')?.label).toBe('Project A');
    expect(getProject(cfg, 'proj-a').label).toBe('Project A');
  });

  // ── remove ────────────────────────────────────────────────────

  it('removeProject drops an entry', () => {
    const cfg0 = addProject(loadOrCreateHubConfig({ path }), fixture());
    const cfg1 = removeProject(cfg0, 'proj-a');
    expect(cfg1.projects.length).toBe(0);
    const reload = loadOrCreateHubConfig({ path });
    expect(reload.projects.length).toBe(0);
  });

  it('removeProject throws on missing', () => {
    const cfg = loadOrCreateHubConfig({ path });
    expect(() => removeProject(cfg, 'nope')).toThrow(ProjectNotFoundError);
  });

  // ── update ────────────────────────────────────────────────────

  it('updateProject patches non-identity fields', () => {
    const cfg0 = addProject(loadOrCreateHubConfig({ path }), fixture());
    const cfg1 = updateProject(cfg0, 'proj-a', {
      label: 'renamed',
      baseUrl: 'wss://example.com/c/x',
      extraArgs: ['--mock'],
    });
    expect(cfg1.projects[0]?.label).toBe('renamed');
    expect(cfg1.projects[0]?.baseUrl).toBe('wss://example.com/c/x');
    expect(cfg1.projects[0]?.extraArgs).toEqual(['--mock']);
    // id / port / createdAt should be untouched
    expect(cfg1.projects[0]?.id).toBe('proj-a');
    expect(cfg1.projects[0]?.port).toBe(8090);
  });

  it('updateProject normalizes relative cwd', () => {
    const cfg0 = addProject(loadOrCreateHubConfig({ path }), fixture());
    const cfg1 = updateProject(cfg0, 'proj-a', { cwd: 'relative/x' });
    expect(cfg1.projects[0]?.cwd.startsWith('/')).toBe(true);
  });

  it('updateProject throws on missing', () => {
    const cfg = loadOrCreateHubConfig({ path });
    expect(() => updateProject(cfg, 'nope', { label: 'x' })).toThrow(ProjectNotFoundError);
  });

  // ── schema tolerance ──────────────────────────────────────────

  it('loads old configs that are missing optional fields', () => {
    // Simulate a future field added: write a config without the new field
    // and confirm loader fills in the default.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'legacy',
            engine: 'codebuddy',
            cwd: '/tmp/legacy',
            port: 9000,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const cfg = loadOrCreateHubConfig({ path });
    expect(cfg.projects.length).toBe(1);
    expect(cfg.projects[0]?.host).toBe('127.0.0.1'); // default
    expect(cfg.projects[0]?.baseUrl).toBe('');
    expect(cfg.projects[0]?.extraArgs).toEqual([]);
  });

  // Silence unused-var lint from `void` patterns.
  void readFileSync;
});
