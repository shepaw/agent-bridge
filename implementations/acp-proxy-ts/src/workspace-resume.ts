/**
 * Workspace-grounded agent resume (简历).
 *
 * At instantiation the gateway scans its own working directory and derives a
 * self-description that answers "what can I do" from the actual project —
 * language, frameworks, build/test tooling, git context. The result is
 * surfaced via `agent.getCard` (description + capabilities + version) and
 * persisted as resume.md / resume.json in the gateway config dir.
 *
 * Everything here is best-effort and bounded: scanning never throws and never
 * blocks startup. Determinism matters — capability ordering and scan results
 * must be stable across runs so the card does not jitter.
 *
 * This module must NOT import agent.ts (circular dependency); callers pass the
 * narrow `AgentResumeInput` struct instead.
 */

import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── types ──────────────────────────────────────────────────────────

export interface ScriptCapabilities {
  build: boolean;
  test: boolean;
  lint: boolean;
  dev: boolean;
  format: boolean;
  deploy: boolean;
}

export interface GitProfile {
  isRepo: boolean;
  originUrl?: string;
  branch?: string;
  lastCommitDate?: string; // ISO-8601
}

export interface WorkspaceProfile {
  projectName?: string;
  projectDescription?: string;
  /** Primary language slug, e.g. 'TypeScript'. */
  language?: string;
  /** Primary + secondary languages (display names). */
  languages: string[];
  /** e.g. 'React', 'Next.js', 'FastAPI'. */
  frameworks: string[];
  /** e.g. 'npm', 'pnpm', 'cargo', 'uv'. */
  packageManager?: string;
  scripts: ScriptCapabilities;
  makefileTargets: string[];
  hasTests: boolean;
  git?: GitProfile;
  /** Files that contributed signals, e.g. ['package.json', 'Makefile', 'tsconfig.json']. */
  sources: string[];
}

export interface AgentResume {
  readonly version: string;
  /** Base + derived, fixed order: chat/streaming → lang:* → framework:* → pm:* → tooling → git. */
  readonly capabilities: string[];
  /** Concise self-description (used as AgentCard.description). */
  readonly summary: string;
}

export interface AgentResumeInput {
  readonly agentId: string;
  readonly fingerprint: string;
  readonly engineId: string;
  readonly engineDisplayName: string;
  readonly agentName: string;
  readonly cwd: string;
}

export interface PersistAgentResumeMeta {
  readonly dir: string;
  readonly input: AgentResumeInput;
  readonly profile: WorkspaceProfile;
}

// ── constants ──────────────────────────────────────────────────────

/** Mirrors agent.ts `GATEWAY_DIR_NAME`; kept local to avoid a circular import. */
const RESUME_CONFIG_DIR_NAME = 'shepaw-acp-proxy-gateway';

const PKG_VERSION_FALLBACK = '0.0.0';

const MAX_FILE_BYTES = 256 * 1024; // single-file reads capped at 256 KB
const README_MAX_LENGTH = 300;

const CENSUS_MAX_ENTRIES = 200;
const CENSUS_MAX_DEPTH = 2; // files up to `cwd/<dir>/<dir>/file`
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'out',
]);

/** File extensions that never become a language capability (docs/config). */
const NON_LANGUAGE_EXTS = new Set([
  'md',
  'json',
  'yaml',
  'yml',
  'toml',
  'html',
  'css',
  'scss',
  'sass',
  'txt',
]);

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  rb: 'Ruby',
  swift: 'Swift',
  php: 'PHP',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  sh: 'Shell',
  bash: 'Shell',
};

/** Stable slug overrides for languages whose generic slugify is lossy. */
const LANGUAGE_SLUGS: Record<string, string> = {
  'C++': 'cpp',
  'C#': 'csharp',
};

const NPM_DEP_FRAMEWORKS: Record<string, string> = {
  react: 'React',
  'react-native': 'React Native',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  astro: 'Astro',
  express: 'Express',
  '@nestjs/core': 'NestJS',
  fastify: 'Fastify',
  '@angular/core': 'Angular',
  vite: 'Vite',
  tailwindcss: 'Tailwind',
  three: 'Three.js',
};

const PY_DEP_FRAMEWORKS: Record<string, string> = {
  django: 'Django',
  fastapi: 'FastAPI',
  flask: 'Flask',
  streamlit: 'Streamlit',
  torch: 'PyTorch',
  tensorflow: 'TensorFlow',
};

const RUST_DEP_FRAMEWORKS: Record<string, string> = {
  axum: 'Axum',
  'actix-web': 'Actix',
};

const CONFIG_FRAMEWORK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^vite\.config\./, 'Vite'],
  [/^next\.config\./, 'Next.js'],
  [/^nuxt\.config\./, 'Nuxt'],
  [/^svelte\.config\./, 'Svelte'],
  [/^astro\.config\./, 'Astro'],
  [/^tailwind\.config\./, 'Tailwind'],
];

const SCRIPT_CAP_RULES: ReadonlyArray<readonly [RegExp, keyof ScriptCapabilities]> = [
  [/^(build|compile|bundle|tsc)/i, 'build'],
  [/^(test|vitest|jest)/i, 'test'],
  [/^(lint|eslint)/i, 'lint'],
  [/^(dev|start|preview|serve)$/i, 'dev'],
  [/^(format|prettier|fmt)/i, 'format'],
  [/^(deploy|release|ship|publish)/i, 'deploy'],
];

const MAKEFILE_SKIP_TARGETS = new Set(['.PHONY', '.DEFAULT', '.SUFFIXES', 'all']);
const MAKEFILE_TARGET_CAPS: ReadonlyArray<readonly [string, keyof ScriptCapabilities]> = [
  ['build', 'build'],
  ['test', 'test'],
  ['check', 'test'],
  ['lint', 'lint'],
  ['format', 'format'],
  ['fmt', 'format'],
  ['deploy', 'deploy'],
  ['dev', 'dev'],
  ['run', 'dev'],
];

const LOCKFILE_PM: ReadonlyArray<readonly [string, string]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['Pipfile.lock', 'pipenv'],
  ['Gemfile.lock', 'bundler'],
];

const README_NAMES = ['README.md', 'README', 'readme.md', 'Readme.md'] as const;
const MAKEFILE_NAMES = ['Makefile', 'makefile', 'GNUmakefile'] as const;

// ── public API ─────────────────────────────────────────────────────

/** Scan a workspace directory. Best-effort — never throws. */
export async function scanWorkspaceProfile(cwd: string): Promise<WorkspaceProfile> {
  const profile: WorkspaceProfile = {
    languages: [],
    frameworks: [],
    scripts: emptyScripts(),
    makefileTargets: [],
    hasTests: false,
    sources: [],
  };

  const rootEntries = await listRootEntries(cwd);
  const rootNames = new Set(rootEntries.filter((e) => e.isFile()).map((e) => e.name));
  const rootDirs = new Set(rootEntries.filter((e) => e.isDirectory()).map((e) => e.name));

  // 1. Manifests (deterministic priority order).
  await scanManifests(cwd, profile, rootNames);

  // 2. README description wins over manifest description.
  const readme = await extractReadmeDescription(cwd, rootNames);
  if (readme !== undefined) profile.projectDescription = readme;

  // 3. Config-file framework markers (vite.config.*, next.config.*, …).
  applyConfigFrameworks(profile, rootNames);

  // 4. Makefile targets.
  await scanMakefile(cwd, profile, rootNames);

  // 5. Extension census + test files + secondary languages.
  const census = await runCensus(cwd, rootEntries);
  profile.hasTests = census.hasTestFiles || [...rootDirs].some((d) => d === 'test' || d === 'tests' || d === '__tests__');
  const langs = languageListFromCounts(census.counts);
  profile.language ??= langs[0];
  if (profile.language !== undefined) {
    profile.languages = [profile.language, ...langs.filter((l) => l !== profile.language).slice(0, 3)];
  } else {
    profile.languages = [];
  }

  // 6. Git context (best-effort).
  profile.git = scanGit(cwd);

  // Deterministic ordering for anything order-agnostic.
  profile.sources = [...new Set(profile.sources)].sort();
  profile.frameworks.sort();
  profile.makefileTargets.sort();

  return profile;
}

/** Compose the final resume from a workspace profile. Pure, synchronous. */
export function composeAgentResume(
  input: AgentResumeInput,
  profile: WorkspaceProfile,
  version: string,
): AgentResume {
  const capabilities = buildCapabilities(profile);
  return { version, capabilities, summary: buildSummary(input, profile, capabilities) };
}

/** Minimal resume for the constructor — no I/O, never depends on the scan. */
export function buildFallbackResume(input: AgentResumeInput): AgentResume {
  const capabilities = ['chat', 'streaming'];
  const summary = [
    `${input.agentName} — ACP agent gateway bridging Shepaw to the upstream ${input.engineDisplayName} agent.`,
    `Workspace: ${workspaceLabel(input.cwd)}`,
    `Capabilities: ${capabilities.join(', ')}`,
  ].join('\n');
  return { version: PKG_VERSION_FALLBACK, capabilities, summary };
}

/** Orchestrate: scan → version → compose. Returns the profile too for persistence. */
export async function buildResumeForAgent(
  input: AgentResumeInput,
): Promise<{ resume: AgentResume; profile: WorkspaceProfile }> {
  const profile = await scanWorkspaceProfile(input.cwd);
  const version = await resolveProxyVersion();
  const resume = composeAgentResume(input, profile, version);
  return { resume, profile };
}

/** Read this package's version from package.json at runtime. Never throws. */
export async function resolveProxyVersion(): Promise<string> {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(dir, '..', 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    return PKG_VERSION_FALLBACK;
  } catch {
    return PKG_VERSION_FALLBACK;
  }
}

/** Full human-readable markdown resume. */
export function renderResumeMarkdown(
  input: AgentResumeInput,
  profile: WorkspaceProfile,
  resume: AgentResume,
): string {
  const secondary = profile.languages.filter((l) => l !== profile.language).slice(0, 3);
  const gitLine =
    profile.git === undefined
      ? 'not detected'
      : profile.git.isRepo
        ? [
            'repo',
            profile.git.branch,
            profile.git.originUrl,
            profile.git.lastCommitDate ? `last ${profile.git.lastCommitDate}` : undefined,
          ]
            .filter((v): v is string => v !== undefined)
            .join(' · ')
        : 'not a git repo';

  return [
    `# ${input.agentName} — Agent Resume`,
    '',
    `> ${input.engineDisplayName} ACP gateway · version ${resume.version}`,
    '',
    '## Identity',
    `- agent_id: \`${input.agentId}\` · fingerprint: \`${input.fingerprint}\``,
    `- engine: ${input.engineDisplayName} (\`${input.engineId}\`) · gateway version: ${resume.version}`,
    '',
    '## Workspace',
    `- path: \`${input.cwd}\``,
    `- project: ${profile.projectName ?? '—'}`,
    `- description: ${profile.projectDescription ?? '—'}`,
    `- language: ${profile.language ?? '—'}${secondary.length > 0 ? ` (+ ${secondary.join(', ')})` : ''}`,
    `- frameworks: ${profile.frameworks.join(', ') || '—'}`,
    `- package manager: ${profile.packageManager ?? '—'}`,
    `- git: ${gitLine}`,
    '',
    '## Capabilities',
    ...resume.capabilities.map((c) => `- ${c}`),
    '',
    '## Summary',
    resume.summary,
  ].join('\n');
}

/**
 * Resolve where resume.md / resume.json are written.
 * - `SHEPAW_RESUME=0|false|off` → null (disabled)
 * - `SHEPAW_RESUME_PATH` → that directory
 * - else `$XDG_CONFIG_HOME|~/.config/shepaw-acp-proxy-gateway`
 */
export function resolveResumePersistenceDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = (env.SHEPAW_RESUME ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return null;
  const explicit = (env.SHEPAW_RESUME_PATH ?? '').trim();
  if (explicit.length > 0) return explicit;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg.trim() : join(homedir(), '.config');
  return join(base, RESUME_CONFIG_DIR_NAME);
}

/** Per-agent persistence dir under the base config dir — isolates agents so
 * multiple gateways on one host never clobber each other's landed resume. */
export function agentResumeDir(dir: string, agentId: string): string {
  return join(dir, 'agents', agentId);
}

/** Write resume.md + resume.json. Best-effort — never throws. */
export async function persistAgentResume(
  resume: AgentResume,
  meta: PersistAgentResumeMeta,
): Promise<void> {
  const outDir = agentResumeDir(meta.dir, meta.input.agentId);
  try {
    await mkdir(outDir, { recursive: true });
  } catch {
    return;
  }

  const md = renderResumeMarkdown(meta.input, meta.profile, resume);
  const json = {
    generated_at: new Date().toISOString(),
    agent_id: meta.input.agentId,
    name: meta.input.agentName,
    version: resume.version,
    capabilities: resume.capabilities,
    summary: resume.summary,
    workspace: {
      cwd: meta.input.cwd,
      project_name: meta.profile.projectName,
      project_description: meta.profile.projectDescription,
      language: meta.profile.language,
      languages: meta.profile.languages,
      frameworks: meta.profile.frameworks,
      package_manager: meta.profile.packageManager,
      scripts: meta.profile.scripts,
      makefile_targets: meta.profile.makefileTargets,
      has_tests: meta.profile.hasTests,
      git: meta.profile.git,
    },
  };

  await Promise.all([
    writeFile(join(outDir, 'resume.md'), md, 'utf-8').catch(() => undefined),
    writeFile(join(outDir, 'resume.json'), JSON.stringify(json, null, 2), 'utf-8').catch(() => undefined),
  ]);
}

/**
 * Load a previously-persisted resume for an agent. Returns `null` when the
 * file is missing, corrupt, or belongs to a different agent — callers then
 * fall back to a fresh scan.
 */
export async function loadAgentResume(dir: string, agentId: string): Promise<AgentResume | null> {
  let raw: string;
  try {
    raw = await readFile(join(agentResumeDir(dir, agentId), 'resume.json'), 'utf-8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object') return null;
    if (obj.agent_id !== agentId) return null;
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    if (summary.length === 0) return null;
    return {
      version: typeof obj.version === 'string' && obj.version.length > 0 ? obj.version : PKG_VERSION_FALLBACK,
      capabilities: Array.isArray(obj.capabilities)
        ? obj.capabilities.filter((c): c is string => typeof c === 'string')
        : [],
      summary,
    };
  } catch {
    return null;
  }
}

/** Whether the process should force a re-scan on this start (ignore persisted). */
export function isResumeRebuildForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.SHEPAW_RESUME_REBUILD ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ── workspace scanning internals ───────────────────────────────────

function emptyScripts(): ScriptCapabilities {
  return { build: false, test: false, lint: false, dev: false, format: false, deploy: false };
}

async function listRootEntries(cwd: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

async function tryReadBounded(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (st.size > MAX_FILE_BYTES) return null;
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface PackageJsonInfo {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

function parsePackageJson(source: string): PackageJsonInfo | null {
  try {
    const obj = JSON.parse(source) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object') return null;
    const asStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    const asRecord = (v: unknown): Record<string, string> | undefined => {
      if (v === null || typeof v !== 'object') return undefined;
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') out[k] = val;
      }
      return out;
    };
    return {
      name: asStr(obj.name),
      description: asStr(obj.description),
      scripts: asRecord(obj.scripts),
      dependencies: asRecord(obj.dependencies),
      devDependencies: asRecord(obj.devDependencies),
      packageManager: asStr(obj.packageManager),
    };
  } catch {
    return null;
  }
}

interface TomlLiteInfo {
  name?: string;
  description?: string;
  deps: string[];
}

/** Line-wise [section] parse for pyproject.toml / Cargo.toml. No TOML library. */
function parseTomlLite(
  source: string,
  nameSections: ReadonlySet<string>,
  depsSections: ReadonlySet<string>,
): TomlLiteInfo {
  const info: TomlLiteInfo = { deps: [] };
  let section = '';
  let inDeps = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? '';
      inDeps = depsSections.has(section);
      continue;
    }
    if (inDeps) {
      const cleaned = line.replace(/,$/, '').trim().replace(/^["']|["']$/g, '');
      if (cleaned.length === 0 || cleaned.startsWith('#')) continue;
      const bare = cleaned.split(/[<>=~![\]]/)[0]?.trim();
      if (bare !== undefined && bare.length > 0) info.deps.push(bare);
      continue;
    }
    if (nameSections.has(section)) {
      const m = line.match(/^(name|description)\s*=\s*["'](.+)["']$/);
      if (m) {
        if (m[1] === 'name') info.name ??= m[2];
        else info.description ??= m[2];
      }
    }
  }
  return info;
}

const PYPROJECT_NAME_SECTIONS = new Set(['project', 'tool.poetry']);
const PYPROJECT_DEPS_SECTIONS = new Set(['project.dependencies', 'tool.poetry.dependencies']);
const CARGO_NAME_SECTIONS = new Set(['package']);
const CARGO_DEPS_SECTIONS = new Set(['dependencies']);

async function scanManifests(
  cwd: string,
  profile: WorkspaceProfile,
  rootNames: Set<string>,
): Promise<void> {
  // package.json — highest priority.
  if (rootNames.has('package.json')) {
    profile.sources.push('package.json');
    const pkg = parsePackageJson((await tryReadBounded(join(cwd, 'package.json'))) ?? '');
    if (pkg !== null) {
      profile.projectName ??= pkg.name;
      profile.projectDescription ??= pkg.description;
      if (pkg.packageManager !== undefined) profile.packageManager = normalizePackageManager(pkg.packageManager);
      if (rootNames.has('tsconfig.json')) {
        profile.sources.push('tsconfig.json');
        profile.language = 'TypeScript';
      } else {
        profile.language = 'JavaScript';
      }
      for (const key of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const fw = NPM_DEP_FRAMEWORKS[key];
        if (fw !== undefined) addFramework(profile, fw);
      }
      applyScripts(profile.scripts, pkg.scripts);
    }
  }

  if (profile.packageManager === undefined) {
    const pm = detectPackageManagerFromLockfiles(rootNames, profile.sources);
    if (pm !== undefined) profile.packageManager = pm;
  }

  if (rootNames.has('pyproject.toml')) {
    profile.sources.push('pyproject.toml');
    const parsed = parseTomlLite(
      (await tryReadBounded(join(cwd, 'pyproject.toml'))) ?? '',
      PYPROJECT_NAME_SECTIONS,
      PYPROJECT_DEPS_SECTIONS,
    );
    profile.projectName ??= parsed.name;
    profile.projectDescription ??= parsed.description;
    profile.language ??= 'Python';
    for (const dep of parsed.deps) {
      const fw = PY_DEP_FRAMEWORKS[dep];
      if (fw !== undefined) addFramework(profile, fw);
    }
  }

  if (rootNames.has('requirements.txt') && profile.language === undefined) {
    profile.sources.push('requirements.txt');
    profile.language = 'Python';
    const src = (await tryReadBounded(join(cwd, 'requirements.txt'))) ?? '';
    for (const line of src.split(/\r?\n/).slice(0, 20)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const dep = trimmed.split(/[=<>!~]/)[0]?.trim() ?? '';
      if (dep.length === 0) continue;
      const fw = PY_DEP_FRAMEWORKS[dep];
      if (fw !== undefined) addFramework(profile, fw);
    }
  }

  if (rootNames.has('Cargo.toml')) {
    profile.sources.push('Cargo.toml');
    const parsed = parseTomlLite(
      (await tryReadBounded(join(cwd, 'Cargo.toml'))) ?? '',
      CARGO_NAME_SECTIONS,
      CARGO_DEPS_SECTIONS,
    );
    profile.projectName ??= parsed.name;
    profile.projectDescription ??= parsed.description;
    profile.language ??= 'Rust';
    for (const dep of parsed.deps) {
      const fw = RUST_DEP_FRAMEWORKS[dep];
      if (fw !== undefined) addFramework(profile, fw);
    }
  }

  if (rootNames.has('go.mod')) {
    profile.sources.push('go.mod');
    profile.language ??= 'Go';
    const first = ((await tryReadBounded(join(cwd, 'go.mod'))) ?? '').split(/\r?\n/)[0] ?? '';
    const m = first.match(/^module\s+(\S+)/);
    if (m !== null && m[1] !== undefined) profile.projectName ??= m[1];
  }

  if (rootNames.has('Gemfile')) {
    profile.sources.push('Gemfile');
    profile.language ??= 'Ruby';
    const src = (await tryReadBounded(join(cwd, 'Gemfile'))) ?? '';
    if (/gem\s+['"]rails['"]/.test(src)) addFramework(profile, 'Rails');
  }

  const hasPom = rootNames.has('pom.xml');
  const gradleName = ['build.gradle', 'build.gradle.kts'].find((n) => rootNames.has(n));
  if (hasPom || gradleName !== undefined) {
    profile.sources.push(hasPom ? 'pom.xml' : gradleName ?? 'build.gradle');
    const hasKotlinRoot = [...rootNames].some((n) => n.endsWith('.kt'));
    profile.language ??= hasKotlinRoot ? 'Kotlin' : 'Java';
    if (hasPom) {
      const src = (await tryReadBounded(join(cwd, 'pom.xml'))) ?? '';
      if (src.includes('spring-boot')) addFramework(profile, 'Spring Boot');
    }
  }
}

function detectPackageManagerFromLockfiles(rootNames: Set<string>, sources: string[]): string | undefined {
  for (const [file, pm] of LOCKFILE_PM) {
    if (rootNames.has(file)) {
      sources.push(file);
      return pm;
    }
  }
  return undefined;
}

function normalizePackageManager(value: string): string {
  const name = value.split('@')[0]?.trim().toLowerCase() ?? value;
  return name.length > 0 ? name : value;
}

function addFramework(profile: { frameworks: string[] }, fw: string): void {
  if (!profile.frameworks.includes(fw)) profile.frameworks.push(fw);
}

function applyConfigFrameworks(
  profile: { frameworks: string[]; sources: string[] },
  rootNames: Set<string>,
): void {
  for (const name of [...rootNames].sort()) {
    for (const [pattern, fw] of CONFIG_FRAMEWORK_PATTERNS) {
      if (pattern.test(name)) {
        addFramework(profile, fw);
        profile.sources.push(name);
      }
    }
  }
}

function applyScripts(target: ScriptCapabilities, scripts?: Record<string, string>): void {
  if (scripts === undefined) return;
  for (const key of Object.keys(scripts)) {
    for (const [pattern, cap] of SCRIPT_CAP_RULES) {
      if (pattern.test(key)) {
        target[cap] = true;
        break;
      }
    }
  }
}

async function scanMakefile(
  cwd: string,
  profile: { makefileTargets: string[]; scripts: ScriptCapabilities; sources: string[] },
  rootNames: Set<string>,
): Promise<void> {
  const name = MAKEFILE_NAMES.find((n) => rootNames.has(n));
  if (name === undefined) return;
  profile.sources.push(name);
  const src = (await tryReadBounded(join(cwd, name))) ?? '';
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m === null) continue;
    const target = m[1] ?? '';
    if (target.length === 0 || MAKEFILE_SKIP_TARGETS.has(target)) continue;
    if (!profile.makefileTargets.includes(target)) profile.makefileTargets.push(target);
    for (const [targetName, cap] of MAKEFILE_TARGET_CAPS) {
      if (target === targetName) {
        profile.scripts[cap] = true;
        break;
      }
    }
  }
}

async function extractReadmeDescription(
  cwd: string,
  rootNames: Set<string>,
): Promise<string | undefined> {
  const name = README_NAMES.find((n) => rootNames.has(n));
  if (name === undefined) return undefined;
  const src = (await tryReadBounded(join(cwd, name))) ?? '';
  if (src.length === 0) return undefined;

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    if (isSkippableReadmeLine(line)) continue;
    current.push(line);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  if (paragraphs.length === 0) return undefined;

  const first = paragraphs[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (first.length === 0) return undefined;
  return first.length > README_MAX_LENGTH ? `${first.slice(0, README_MAX_LENGTH).trimEnd()}…` : first;
}

function isSkippableReadmeLine(line: string): boolean {
  return (
    line.startsWith('#') ||
    line.startsWith('<') ||
    line.startsWith('!') ||
    /^!\[[^\]]*\]\([^)]*\)$/.test(line) ||
    /^\[[^\]]*\]\([^)]*\)$/.test(line)
  );
}

interface CensusResult {
  counts: Map<string, number>;
  hasTestFiles: boolean;
}

async function runCensus(cwd: string, rootEntries: Dirent[]): Promise<CensusResult> {
  const counts = new Map<string, number>();
  let hasTestFiles = false;
  let visited = 0;
  const queue: Array<{ rel: string; depth: number }> = [];

  for (const e of rootEntries) {
    if (visited >= CENSUS_MAX_ENTRIES) break;
    visited++;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) queue.push({ rel: e.name, depth: 0 });
    } else {
      tallyFile(counts, e.name);
      if (isTestFile(e.name)) hasTestFiles = true;
    }
  }

  while (queue.length > 0 && visited < CENSUS_MAX_ENTRIES) {
    const { rel, depth } = queue.shift()!;
    if (depth >= CENSUS_MAX_DEPTH) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(join(cwd, rel), { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (visited >= CENSUS_MAX_ENTRIES) break;
      visited++;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push({ rel: join(rel, e.name), depth: depth + 1 });
      } else {
        tallyFile(counts, e.name);
        if (isTestFile(e.name)) hasTestFiles = true;
      }
    }
  }

  return { counts, hasTestFiles };
}

function tallyFile(counts: Map<string, number>, name: string): void {
  const ext = extname(name).slice(1).toLowerCase();
  if (ext === '' || NON_LANGUAGE_EXTS.has(ext)) return;
  const lang = EXT_LANGUAGE[ext];
  if (lang === undefined) return;
  counts.set(lang, (counts.get(lang) ?? 0) + 1);
}

function isTestFile(name: string): boolean {
  return /\.(test|spec)\./i.test(name);
}

function languageListFromCounts(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([lang]) => lang);
}

// ── git (best-effort spawnSync — first git usage in this package) ──

interface GitResult {
  ok: boolean;
  stdout: string;
  missing: boolean;
}

function gitResult(cwd: string, args: string[]): GitResult {
  try {
    const res = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const errno = res.error as NodeJS.ErrnoException | undefined;
    return {
      ok: res.status === 0,
      stdout: (res.stdout ?? '').trim(),
      missing: errno !== undefined && errno.code === 'ENOENT',
    };
  } catch {
    return { ok: false, stdout: '', missing: true };
  }
}

function scanGit(cwd: string): GitProfile | undefined {
  const probe = gitResult(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (probe.missing) return undefined;
  if (!probe.ok || probe.stdout !== 'true') return { isRepo: false };

  const git: GitProfile = { isRepo: true };
  const origin = gitResult(cwd, ['config', '--get', 'remote.origin.url']);
  if (origin.ok && origin.stdout.length > 0) git.originUrl = origin.stdout;
  const branch = gitResult(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.ok && branch.stdout.length > 0 && branch.stdout !== 'HEAD') git.branch = branch.stdout;
  const last = gitResult(cwd, ['log', '-1', '--format=%cI']);
  if (last.ok && last.stdout.length > 0) git.lastCommitDate = last.stdout;
  return git;
}

// ── resume composition helpers ─────────────────────────────────────

function buildCapabilities(profile: WorkspaceProfile): string[] {
  const caps: string[] = ['chat', 'streaming'];
  for (const lang of profile.languages) caps.push(`lang:${languageSlug(lang)}`);
  for (const fw of profile.frameworks) caps.push(`framework:${slugify(fw)}`);
  if (profile.packageManager !== undefined) caps.push(`pm:${slugify(profile.packageManager)}`);
  const tooling: ReadonlyArray<readonly [boolean, string]> = [
    [profile.scripts.build, 'build'],
    [profile.scripts.test, 'test'],
    [profile.scripts.lint, 'lint'],
    [profile.scripts.dev, 'dev'],
    [profile.scripts.format, 'format'],
    [profile.scripts.deploy, 'deploy'],
  ];
  for (const [on, name] of tooling) if (on) caps.push(name);
  if (profile.git?.isRepo === true) caps.push('git');
  return caps;
}

function languageSlug(language: string): string {
  return LANGUAGE_SLUGS[language] ?? slugify(language);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSummary(
  input: AgentResumeInput,
  profile: WorkspaceProfile,
  capabilities: string[],
): string {
  const projectName = profile.projectName ?? workspaceLabel(input.cwd);
  const projectLine = profile.projectDescription
    ? `${projectName} — ${profile.projectDescription}`
    : projectName;
  const language = profile.language ?? profile.languages[0] ?? 'unknown';
  return [
    `${input.agentName} — ACP agent gateway bridging Shepaw to the upstream ${input.engineDisplayName} agent.`,
    `Workspace: ${projectLine}`,
    `Languages: ${language}`,
    `Capabilities: ${capabilities.join(', ')}`,
  ].join('\n');
}

function workspaceLabel(cwd: string): string {
  const base = basename(cwd);
  return base.length > 0 ? base : cwd;
}
