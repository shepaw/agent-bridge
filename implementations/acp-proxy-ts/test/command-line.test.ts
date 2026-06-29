import { describe, expect, it } from 'vitest';

import { formatShellCommand, parseShellCommand } from '../src/command-line.js';
import { resolveEngineSpec } from '../src/engines.js';

describe('parseShellCommand', () => {
  it('splits a simple command', () => {
    expect(parseShellCommand('codebuddy --acp')).toEqual({
      command: 'codebuddy',
      args: ['--acp'],
    });
  });

  it('respects double quotes', () => {
    expect(parseShellCommand('npx -y "@scope/pkg@latest" acp')).toEqual({
      command: 'npx',
      args: ['-y', '@scope/pkg@latest', 'acp'],
    });
  });
});

describe('resolveEngineSpec', () => {
  it('builds a custom spec from acpCommand', () => {
    const spec = resolveEngineSpec('my-agent', {
      displayName: 'My Agent',
      acpCommand: 'my-cli acp --verbose',
    });
    expect(spec.command).toBe('my-cli');
    expect(spec.args).toEqual(['acp', '--verbose']);
    expect(spec.displayName).toBe('My Agent');
  });

  it('formats commands for logging', () => {
    expect(formatShellCommand('npx', ['-y', 'pkg acp'])).toBe('npx -y "pkg acp"');
  });
});
