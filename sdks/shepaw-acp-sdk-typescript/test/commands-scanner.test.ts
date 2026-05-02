import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFrontmatter, scanCommandsDir } from '../src/commands-scanner.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shepaw-commands-scanner-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('returns null when the file has no leading fence', () => {
    expect(parseFrontmatter('# heading\n\nbody')).toBeNull();
  });

  it('parses description and argument-hint', () => {
    const fm = parseFrontmatter(
      '---\n' +
        'description: Run a plan\n' +
        'argument-hint: <ticket>\n' +
        '---\n' +
        '\n' +
        'body here\n',
    );
    expect(fm).toEqual({ description: 'Run a plan', argument_hint: '<ticket>' });
  });

  it('accepts argumentHint (camelCase) and argument_hint (snake_case) as aliases', () => {
    const a = parseFrontmatter('---\nargumentHint: <a>\n---\n');
    const b = parseFrontmatter('---\nargument_hint: <b>\n---\n');
    expect(a?.argument_hint).toBe('<a>');
    expect(b?.argument_hint).toBe('<b>');
  });

  it('strips surrounding quotes', () => {
    const fm = parseFrontmatter('---\ndescription: "Quoted desc"\n---\n');
    expect(fm?.description).toBe('Quoted desc');
  });

  it('ignores unknown keys (model, allowed-tools, etc.)', () => {
    const fm = parseFrontmatter(
      '---\n' +
        'description: d\n' +
        'model: claude-opus-4-7\n' +
        'allowed-tools: Bash, Read\n' +
        '---\n',
    );
    expect(fm).toEqual({ description: 'd' });
  });

  it('returns null on unterminated frontmatter', () => {
    expect(parseFrontmatter('---\ndescription: no-close\n')).toBeNull();
  });
});

describe('scanCommandsDir', () => {
  it('returns [] for a missing directory', async () => {
    const result = await scanCommandsDir(join(dir, 'does-not-exist'), 'project');
    expect(result).toEqual([]);
  });

  it('returns [] for an empty directory', async () => {
    const result = await scanCommandsDir(dir, 'project');
    expect(result).toEqual([]);
  });

  it('discovers top-level .md files with frontmatter', async () => {
    await writeFile(
      join(dir, 'plan.md'),
      '---\ndescription: Plan a feature\nargument-hint: <feature>\n---\n\nbody\n',
      'utf-8',
    );
    await writeFile(join(dir, 'raw.md'), '# no frontmatter\n', 'utf-8');

    const result = await scanCommandsDir(dir, 'project');
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          name: 'plan',
          description: 'Plan a feature',
          argument_hint: '<feature>',
          scope: 'project',
          source: 'filesystem',
        },
        {
          name: 'raw',
          description: undefined,
          argument_hint: undefined,
          scope: 'project',
          source: 'filesystem',
        },
      ]),
    );
  });

  it('namespaces subdirectories with ":" separators', async () => {
    await mkdir(join(dir, 'deploy'), { recursive: true });
    await writeFile(
      join(dir, 'deploy', 'staging.md'),
      '---\ndescription: Deploy to staging\n---\n',
      'utf-8',
    );

    const result = await scanCommandsDir(dir, 'user');
    expect(result).toEqual([
      {
        name: 'deploy:staging',
        description: 'Deploy to staging',
        argument_hint: undefined,
        scope: 'user',
        source: 'filesystem',
      },
    ]);
  });

  it('ignores non-markdown files', async () => {
    await writeFile(join(dir, 'note.txt'), 'ignored', 'utf-8');
    await writeFile(join(dir, 'real.md'), '---\ndescription: d\n---\n', 'utf-8');
    const result = await scanCommandsDir(dir, 'project');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('real');
  });
});
