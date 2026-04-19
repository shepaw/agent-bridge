import { describe, expect, it } from 'vitest';

import { summarizeToolInput } from '../src/tool-summary.js';

describe('summarizeToolInput', () => {
  it('Read → file_path', () => {
    expect(summarizeToolInput('Read', { file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts');
  });

  it('Write → path + char count', () => {
    expect(summarizeToolInput('Write', { file_path: '/a.ts', content: 'hello' })).toBe(
      '/a.ts (5 chars)',
    );
  });

  it('Edit → path + old_string length', () => {
    expect(
      summarizeToolInput('Edit', {
        file_path: '/a.ts',
        old_string: 'abcd',
        new_string: 'wxyz',
      }),
    ).toBe('/a.ts (replacing 4 chars)');
  });

  it('Bash short command', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('Bash truncates long commands at 120 chars', () => {
    const cmd = 'x'.repeat(500);
    const out = summarizeToolInput('Bash', { command: cmd });
    expect(out.startsWith('x'.repeat(120))).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });

  it('Bash appends description when present', () => {
    expect(
      summarizeToolInput('Bash', { command: 'ls', description: 'list files' }),
    ).toBe('ls\n(list files)');
  });

  it('Glob / Grep / WebSearch / WebFetch / Task each use their signature field', () => {
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('/foo/ in src');
    expect(summarizeToolInput('Grep', { pattern: 'foo' })).toBe('/foo/');
    expect(summarizeToolInput('WebSearch', { query: 'codebuddy' })).toBe('codebuddy');
    expect(summarizeToolInput('WebFetch', { url: 'https://x' })).toBe('https://x');
    expect(summarizeToolInput('Task', { description: 'audit deps' })).toBe('audit deps');
  });

  it('unknown tool falls back to first field', () => {
    expect(summarizeToolInput('Custom', { foo: 'bar' })).toBe('foo=bar');
  });

  it('unknown tool truncates long values at 80 chars', () => {
    const out = summarizeToolInput('Custom', { foo: 'a'.repeat(500) });
    expect(out.startsWith('foo=' + 'a'.repeat(80))).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });

  it('empty input returns empty string', () => {
    expect(summarizeToolInput('Unknown', {})).toBe('');
  });
});
