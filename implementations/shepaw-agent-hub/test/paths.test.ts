import { describe, expect, it } from 'vitest';

import { normalizeCwd, projectPaths, validateProjectId, hubRoot } from '../src/paths.js';

describe('paths', () => {
  describe('validateProjectId', () => {
    it('accepts well-formed ids', () => {
      for (const good of ['work-api', 'a', 'a1b2', 'my_project', 'Project123']) {
        expect(() => validateProjectId(good)).not.toThrow();
      }
    });

    it('rejects empty / too long / wrong charset', () => {
      expect(() => validateProjectId('')).toThrow();
      expect(() => validateProjectId('a'.repeat(65))).toThrow();
      expect(() => validateProjectId('has space')).toThrow();
      expect(() => validateProjectId('has/slash')).toThrow();
      expect(() => validateProjectId('-leading-hyphen')).toThrow();
      expect(() => validateProjectId('has.dot')).toThrow();
      expect(() => validateProjectId('has..parent')).toThrow();
    });

    it('rejects Windows device names only on Windows', () => {
      // We can't easily fake process.platform in a single run, so at least
      // assert the regex didn't block "CON" on non-Windows (it'd be a valid
      // id there).
      if (process.platform !== 'win32') {
        expect(() => validateProjectId('CON')).not.toThrow();
      } else {
        expect(() => validateProjectId('CON')).toThrow();
        expect(() => validateProjectId('nul')).toThrow();
      }
    });
  });

  describe('projectPaths', () => {
    it('composes all derived paths under the project root', () => {
      const p = projectPaths('my-proj', '/tmp/hub');
      expect(p.root).toBe('/tmp/hub/projects/my-proj');
      expect(p.identityPath).toBe('/tmp/hub/projects/my-proj/identity.json');
      expect(p.peersPath).toBe('/tmp/hub/projects/my-proj/authorized_peers.json');
      expect(p.enrollmentsPath).toBe('/tmp/hub/projects/my-proj/enrollments.json');
      expect(p.statePath).toBe('/tmp/hub/projects/my-proj/state.json');
      expect(p.logFile).toBe('/tmp/hub/projects/my-proj/logs/agent.log');
    });

    it('uses hubRoot() by default', () => {
      const p = projectPaths('x');
      expect(p.identityPath.endsWith('/projects/x/identity.json')).toBe(true);
      expect(p.identityPath.startsWith(hubRoot())).toBe(true);
    });
  });

  describe('normalizeCwd', () => {
    it('returns absolute paths unchanged', () => {
      expect(normalizeCwd('/tmp/x')).toBe('/tmp/x');
    });

    it('resolves relative paths against process.cwd()', () => {
      const got = normalizeCwd('relative/sub');
      expect(got.startsWith('/')).toBe(true);
      expect(got.endsWith('relative/sub')).toBe(true);
    });

    it('rejects empty / non-string', () => {
      expect(() => normalizeCwd('')).toThrow();
    });
  });

  describe('hubRoot', () => {
    it('honors SHEPAW_HUB_HOME', () => {
      const orig = process.env.SHEPAW_HUB_HOME;
      try {
        process.env.SHEPAW_HUB_HOME = '/custom/hub';
        expect(hubRoot()).toBe('/custom/hub');
      } finally {
        if (orig === undefined) delete process.env.SHEPAW_HUB_HOME;
        else process.env.SHEPAW_HUB_HOME = orig;
      }
    });

    it('falls back to XDG_CONFIG_HOME/shepaw-hub', () => {
      const origHub = process.env.SHEPAW_HUB_HOME;
      const origXdg = process.env.XDG_CONFIG_HOME;
      try {
        delete process.env.SHEPAW_HUB_HOME;
        process.env.XDG_CONFIG_HOME = '/xdg';
        expect(hubRoot()).toBe('/xdg/shepaw-hub');
      } finally {
        if (origHub === undefined) delete process.env.SHEPAW_HUB_HOME;
        else process.env.SHEPAW_HUB_HOME = origHub;
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = origXdg;
      }
    });
  });
});
