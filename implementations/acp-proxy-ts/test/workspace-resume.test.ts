import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  agentResumeDir,
  buildFallbackResume,
  composeAgentResume,
  isResumeRebuildForced,
  loadAgentResume,
  persistAgentResume,
  renderResumeMarkdown,
  resolveProxyVersion,
  resolveResumePersistenceDir,
  scanWorkspaceProfile,
  type AgentResumeInput,
  type WorkspaceProfile,
} from '../src/workspace-resume.js';

const INPUT: AgentResumeInput = {
  agentId: 'acp_agent_deadbeef',
  fingerprint: 'cafe000000000000',
  engineId: 'claude-code',
  engineDisplayName: 'Claude Code',
  agentName: 'Resume Demo',
  cwd: '/tmp/resume-demo',
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'shepaw-resume-'));
}

async function write(dir: string, relPath: string, content: string): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

describe('scanWorkspaceProfile', () => {
  it('detects project, language, frameworks, scripts and tests from a typical workspace', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'package.json',
      JSON.stringify({
        name: 'resume-demo',
        description: 'Demo workspace description',
        scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', dev: 'vite' },
        dependencies: { react: '^18', next: '^14' },
        devDependencies: { typescript: '^5' },
      }),
    );
    await write(dir, 'README.md', '# Resume Demo\n\nA sample TypeScript workspace with Next.js.\n');
    await write(dir, 'Makefile', 'build: tsc\ntest: vitest run\nformat: prettier --write .\n');
    await write(dir, 'tsconfig.json', '{}');
    await write(dir, 'package-lock.json', '{}');
    await write(dir, 'test/foo.test.ts', 'it("x", () => 1);\n');

    const profile = await scanWorkspaceProfile(dir);
    expect(profile.projectName).toBe('resume-demo');
    expect(profile.projectDescription).toBe('A sample TypeScript workspace with Next.js.');
    expect(profile.language).toBe('TypeScript');
    expect(profile.packageManager).toBe('npm');
    expect(profile.frameworks).toContain('React');
    expect(profile.frameworks).toContain('Next.js');
    expect(profile.scripts.build).toBe(true);
    expect(profile.scripts.test).toBe(true);
    expect(profile.scripts.lint).toBe(true);
    expect(profile.scripts.dev).toBe(true);
    expect(profile.scripts.format).toBe(true);
    expect(profile.scripts.deploy).toBe(false);
    expect(profile.makefileTargets).toContain('build');
    expect(profile.makefileTargets).toContain('test');
    expect(profile.makefileTargets).toContain('format');
    expect(profile.hasTests).toBe(true);
    expect(profile.sources).toContain('package.json');
    expect(profile.sources).toContain('Makefile');
    expect(profile.sources).toContain('tsconfig.json');
  });

  it('returns a safe empty profile for a nonexistent directory (never throws)', async () => {
    const profile = await scanWorkspaceProfile(join(tmpdir(), 'definitely-missing-shepaw-resume-dir'));
    expect(profile.language).toBeUndefined();
    expect(profile.languages).toEqual([]);
    expect(profile.frameworks).toEqual([]);
    expect(profile.scripts).toEqual({
      build: false,
      test: false,
      lint: false,
      dev: false,
      format: false,
      deploy: false,
    });
    expect(profile.hasTests).toBe(false);
  });

  it('skips node_modules/.git and bounds the extension census', async () => {
    const dir = await tempDir();
    await write(dir, 'a1.py', 'print(1)\n');
    await write(dir, 'a2.py', 'print(2)\n');
    // Deep junk trees that must never be traversed.
    await write(dir, 'node_modules/pkg/deep/leaf.js', 'x;\n');
    await write(dir, '.git/objects/ab/abcdef', 'junk');
    // A non-skipped dir with more entries than the census cap, holding only
    // non-language files — the scan must complete fast and leak nothing.
    const big = join(dir, 'big');
    await mkdir(join(big, 'nested'), { recursive: true });
    await Promise.all(
      Array.from({ length: 220 }, (_, i) =>
        writeFile(join(big, 'nested', `f${String(i).padStart(3, '0')}.log`), 'line\n', 'utf-8'),
      ),
    );

    const profile = await scanWorkspaceProfile(dir);
    expect(profile.language).toBe('Python');
    expect(profile.languages).toEqual(['Python']); // no JavaScript leaked from node_modules, no junk from big/
    expect(profile.hasTests).toBe(false);
  });

  it('extracts the first README paragraph and falls back to package.json description', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'README.md',
      '# Resume Demo\n\n![logo](img.png)\n\nFirst paragraph here.\n\nSecond paragraph ignored.\n',
    );
    await write(dir, 'package.json', JSON.stringify({ name: 'p', description: 'fallback description' }));

    let profile = await scanWorkspaceProfile(dir);
    expect(profile.projectDescription).toBe('First paragraph here.');

    // No README → manifest description wins.
    const dir2 = await tempDir();
    await write(dir2, 'package.json', JSON.stringify({ name: 'p', description: 'fallback description' }));
    profile = await scanWorkspaceProfile(dir2);
    expect(profile.projectDescription).toBe('fallback description');
  });

  it('detects a language from the extension census without a manifest', async () => {
    const dir = await tempDir();
    await write(dir, 'a.py', 'print(1)\n');
    await write(dir, 'b.md', '# docs\n');

    const profile = await scanWorkspaceProfile(dir);
    expect(profile.language).toBe('Python');
    expect(profile.languages).toEqual(['Python']);
  });

  it('reports a non-git directory as not a repo without throwing', async () => {
    const dir = await tempDir();
    await write(dir, 'file.txt', 'hello\n');

    const profile = await scanWorkspaceProfile(dir);
    if (profile.git !== undefined) {
      expect(profile.git.isRepo).toBe(false);
    }
  });

  it('is deterministic across two scans of the same directory', async () => {
    const dir = await tempDir();
    await write(
      dir,
      'package.json',
      JSON.stringify({ name: 'det', scripts: { build: 'tsc' }, dependencies: { express: '^4' } }),
    );
    await write(dir, 'README.md', '# Det\n\nStable.\n');

    const a = await scanWorkspaceProfile(dir);
    const b = await scanWorkspaceProfile(dir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('composeAgentResume / buildFallbackResume', () => {
  const profile: WorkspaceProfile = {
    projectName: 'resume-demo',
    projectDescription: 'A demo project',
    language: 'TypeScript',
    languages: ['TypeScript'],
    frameworks: ['React'],
    packageManager: 'npm',
    scripts: { build: true, test: true, lint: false, dev: false, format: false, deploy: false },
    makefileTargets: ['build', 'test'],
    hasTests: true,
    git: { isRepo: true, branch: 'main' },
    sources: ['package.json'],
  };

  it('orders capabilities deterministically and includes derived ones', () => {
    const resume = composeAgentResume(INPUT, profile, '0.1.7');
    expect(resume.capabilities.slice(0, 2)).toEqual(['chat', 'streaming']);
    expect(resume.capabilities).toContain('lang:typescript');
    expect(resume.capabilities).toContain('framework:react');
    expect(resume.capabilities).toContain('pm:npm');
    expect(resume.capabilities).toContain('build');
    expect(resume.capabilities).toContain('test');
    expect(resume.capabilities).toContain('git');
  });

  it('is deterministic across two calls', () => {
    const a = composeAgentResume(INPUT, profile, '0.1.7');
    const b = composeAgentResume(INPUT, profile, '0.1.7');
    expect(a).toEqual(b);
  });

  it('fallback resume is pure with base capabilities only', () => {
    const fallback = buildFallbackResume(INPUT);
    expect(fallback.capabilities).toEqual(['chat', 'streaming']);
    expect(fallback.summary.length).toBeGreaterThan(0);
  });
});

describe('renderResumeMarkdown / resolveProxyVersion / persistence', () => {
  it('renders a full markdown resume', () => {
    const profile = buildTestProfile();
    const resume = composeAgentResume(INPUT, profile, '0.1.7');
    const md = renderResumeMarkdown(INPUT, profile, resume);

    expect(md).toContain('# Resume Demo — Agent Resume');
    expect(md).toContain('acp_agent_deadbeef');
    expect(md).toContain('/tmp/resume-demo');
    expect(md).toContain('## Capabilities');
    expect(md).toContain('## Summary');
    expect(md).toContain('- lang:typescript');
  });

  it('resolves the proxy package version', async () => {
    const version = await resolveProxyVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves the persistence directory from env', () => {
    expect(resolveResumePersistenceDir({})).toMatch(/shepaw-acp-proxy-gateway$/);
    expect(resolveResumePersistenceDir({ SHEPAW_RESUME_PATH: '/tmp/my-resumes' })).toBe('/tmp/my-resumes');
    expect(resolveResumePersistenceDir({ SHEPAW_RESUME: '0' })).toBeNull();
    expect(resolveResumePersistenceDir({ SHEPAW_RESUME: 'off' })).toBeNull();
    expect(resolveResumePersistenceDir({ XDG_CONFIG_HOME: '/tmp/xdg', SHEPAW_RESUME_PATH: '' })).toBe(
      '/tmp/xdg/shepaw-acp-proxy-gateway',
    );
  });

  it('persists resume.md and resume.json into the per-agent directory', async () => {
    const dir = await tempDir();
    const resume = composeAgentResume(INPUT, buildTestProfile(), '0.1.7');
    await persistAgentResume(resume, { dir, input: INPUT, profile: buildTestProfile() });

    const outDir = agentResumeDir(dir, INPUT.agentId);
    expect(outDir.endsWith(join('agents', 'acp_agent_deadbeef'))).toBe(true);

    const md = await readFile(join(outDir, 'resume.md'), 'utf-8');
    expect(md).toContain('## Capabilities');

    const json = JSON.parse(await readFile(join(outDir, 'resume.json'), 'utf-8')) as {
      version: string;
      capabilities: string[];
      summary: string;
      agent_id: string;
    };
    expect(json.version).toBe('0.1.7');
    expect(json.capabilities).toContain('lang:typescript');
    expect(json.summary).toContain('resume-demo');
    expect(json.agent_id).toBe('acp_agent_deadbeef');
  });
});

describe('loadAgentResume', () => {
  it('round-trips a persisted resume back to an AgentResume', async () => {
    const dir = await tempDir();
    const resume = composeAgentResume(INPUT, buildTestProfile(), '0.1.7');
    await persistAgentResume(resume, { dir, input: INPUT, profile: buildTestProfile() });

    const loaded = await loadAgentResume(dir, INPUT.agentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe('0.1.7');
    expect(loaded!.summary).toBe(resume.summary);
    expect(loaded!.capabilities).toEqual(resume.capabilities);
  });

  it('returns null when no persisted resume exists', async () => {
    const dir = await tempDir();
    expect(await loadAgentResume(dir, INPUT.agentId)).toBeNull();
  });

  it('returns null for corrupt json', async () => {
    const dir = await tempDir();
    const outDir = agentResumeDir(dir, INPUT.agentId);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'resume.json'), '{ not json', 'utf-8');
    expect(await loadAgentResume(dir, INPUT.agentId)).toBeNull();
  });

  it('returns null when the file belongs to a different agent', async () => {
    const dir = await tempDir();
    const resume = composeAgentResume(INPUT, buildTestProfile(), '0.1.7');
    await persistAgentResume(resume, { dir, input: INPUT, profile: buildTestProfile() });
    expect(await loadAgentResume(dir, 'acp_agent_other')).toBeNull();
  });

  it('returns null when summary is missing or empty', async () => {
    const dir = await tempDir();
    const outDir = agentResumeDir(dir, INPUT.agentId);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, 'resume.json'),
      JSON.stringify({ agent_id: INPUT.agentId, version: '1.0.0', capabilities: [], summary: '' }),
      'utf-8',
    );
    expect(await loadAgentResume(dir, INPUT.agentId)).toBeNull();
  });
});

describe('isResumeRebuildForced', () => {
  it('accepts truthy markers', () => {
    expect(isResumeRebuildForced({ SHEPAW_RESUME_REBUILD: '1' })).toBe(true);
    expect(isResumeRebuildForced({ SHEPAW_RESUME_REBUILD: 'true' })).toBe(true);
    expect(isResumeRebuildForced({ SHEPAW_RESUME_REBUILD: 'YES' })).toBe(true);
  });

  it('rejects off / empty / missing', () => {
    expect(isResumeRebuildForced({ SHEPAW_RESUME_REBUILD: '0' })).toBe(false);
    expect(isResumeRebuildForced({ SHEPAW_RESUME_REBUILD: '' })).toBe(false);
    expect(isResumeRebuildForced({})).toBe(false);
  });
});

function buildTestProfile(): WorkspaceProfile {
  return {
    projectName: 'resume-demo',
    projectDescription: 'A demo project',
    language: 'TypeScript',
    languages: ['TypeScript'],
    frameworks: ['React'],
    scripts: { build: true, test: true, lint: false, dev: false, format: false, deploy: false },
    makefileTargets: ['build', 'test'],
    hasTests: true,
    git: { isRepo: false },
    sources: ['package.json'],
  };
}
