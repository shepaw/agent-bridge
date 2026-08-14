import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  formatUpdateHint,
  isNpmPackageInstall,
  parseLatestVersion,
} from '../src/self-update.js';

describe('compareSemver', () => {
  it('orders patch / minor / major', () => {
    expect(compareSemver('0.1.3', '0.1.4')).toBeLessThan(0);
    expect(compareSemver('0.1.4', '0.1.4')).toBe(0);
    expect(compareSemver('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('strips v prefix and prerelease suffix for numeric compare', () => {
    expect(compareSemver('v0.1.4', '0.1.4')).toBe(0);
    expect(compareSemver('0.1.4-beta.1', '0.1.4')).toBe(0);
  });
});

describe('parseLatestVersion', () => {
  it('reads registry latest payload', () => {
    expect(parseLatestVersion({ version: '0.1.4' })).toBe('0.1.4');
  });

  it('rejects missing version', () => {
    expect(() => parseLatestVersion({})).toThrow(/missing version/);
  });
});

describe('isNpmPackageInstall', () => {
  it('rejects a monorepo checkout path', () => {
    expect(
      isNpmPackageInstall('/Users/me/workspace/shepaw/agent-bridge/agent-hub/cli/dist/cli.js'),
    ).toBe(false);
  });

  it('accepts a global npm layout', () => {
    expect(
      isNpmPackageInstall(
        '/usr/local/lib/node_modules/shepaw-agent-hub/dist/cli.js',
      ),
    ).toBe(true);
    expect(
      isNpmPackageInstall(
        '/Users/me/.nvm/versions/node/v22.14.0/lib/node_modules/shepaw-agent-hub/dist/cli.js',
      ),
    ).toBe(true);
  });
});

describe('formatUpdateHint', () => {
  it('mentions shepaw-hub update', () => {
    const text = formatUpdateHint({
      installed: '0.1.3',
      latest: '0.1.4',
      outdated: true,
    });
    expect(text).toContain('0.1.3');
    expect(text).toContain('0.1.4');
    expect(text).toContain('shepaw-hub update');
  });
});
