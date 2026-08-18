/**
 * Registry of industry-standard ACP agent entry points.
 *
 * Each entry spawns a subprocess that speaks JSON-RPC over stdio using the
 * Agent Client Protocol (https://agentclientprotocol.com). The unified proxy
 * acts as the ACP Client; these processes are the ACP Agents.
 *
 * Built-in engines are listed here; operators can also register custom local
 * CLIs via Hub or `--acp-command` on the gateway CLI.
 */

import { parseShellCommand } from './command-line.js';
import { cursorRunModeSpawnArgs, qwenApprovalModeSpawnArgs, requestedSessionMode } from './session-mode.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export type BuiltinEngineId =
  | 'claude-code'
  | 'codebuddy'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'cursor'
  | 'hermes'
  | 'kimi'
  | 'deepseek-harness'
  | 'zcode'
  | 'qwen-code'
  | 'pi'
  | 'copilot'
  | 'gemini'
  | 'agoragentic'
  | 'amp'
  | 'auggie'
  | 'autohand'
  | 'cline'
  | 'codewhale'
  | 'cortex-code'
  | 'corust-agent'
  | 'crow-cli'
  | 'deepagents'
  | 'dimcode'
  | 'dirac'
  | 'factory-droid'
  | 'fast-agent'
  | 'glm'
  | 'goose'
  | 'grok'
  | 'junie'
  | 'kilo'
  | 'minion-code'
  | 'mistral-vibe'
  | 'nova'
  | 'poolside'
  | 'qoder'
  | 'sigit'
  | 'stakpak'
  | 'traecli'
  | 'vtcode';

/** @deprecated Use BuiltinEngineId — kept for existing imports. */
export type AcpEngineId = BuiltinEngineId;

export interface AcpEngineSpec {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Default Shepaw agent card name when --name is not supplied. */
  readonly defaultAgentName: string;
  /** Default env injected at ACP spawn (caller env wins). */
  readonly spawnEnv?: Readonly<Record<string, string>>;
}

export interface ResolveEngineSpecOptions {
  readonly displayName?: string;
  /** Full shell command when overriding or defining a custom engine. */
  readonly acpCommand?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
}

export const ACP_ENGINES: Record<BuiltinEngineId, AcpEngineSpec> = {
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    defaultAgentName: 'Claude Code',
  },
  codebuddy: {
    id: 'codebuddy',
    displayName: 'CodeBuddy Code',
    command: 'codebuddy',
    args: ['--acp'],
    defaultAgentName: 'CodeBuddy Code',
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    command: 'npx',
    // Official ACP adapter (Codex App Server). Replaces deprecated
    // @zed-industries/codex-acp, which cannot parse newer ~/.codex/models.json.
    args: ['-y', '@agentclientprotocol/codex-acp@latest'],
    defaultAgentName: 'Codex',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'npx',
    args: ['-y', 'opencode-ai@latest', 'acp'],
    defaultAgentName: 'OpenCode',
  },
  openclaw: {
    id: 'openclaw',
    displayName: 'OpenClaw',
    command: 'npx',
    args: ['-y', 'openclaw', 'acp'],
    defaultAgentName: 'OpenClaw',
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    command: 'agent',
    args: ['acp'],
    defaultAgentName: 'Cursor',
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes',
    command: 'hermes',
    args: ['acp'],
    defaultAgentName: 'Hermes',
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi CLI',
    command: 'kimi',
    args: ['acp'],
    defaultAgentName: 'Kimi CLI',
  },
  zcode: {
    id: 'zcode',
    displayName: 'ZCode',
    command: 'npx',
    // Community ACP adapter that launches `zcode app-server --stdio`.
    // Injects ZCODE_BIN at spawn when the desktop CLI is off PATH.
    args: ['-y', 'zcode-acp-server@latest'],
    defaultAgentName: 'ZCode',
  },
  'deepseek-harness': {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    command: 'npx',
    // Official ACP stdio bin (`dsh-acp-demo`). Needs DEEPSEEK_API_KEY and a
    // cordis.yml in the instance cwd (see Hub engine setup).
    // Pin to a known-good rc: the `latest` dist-tag still points at
    // 0.0.1-rc.1, whose peer-dependency tree fails to resolve (ERESOLVE).
    args: ['-y', '@deepseek-ai/dsh-acp-demo@0.1.0-rc.7'],
    defaultAgentName: 'DeepSeek Harness',
  },
  'qwen-code': {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    command: 'qwen',
    args: ['--acp'],
    defaultAgentName: 'Qwen Code',
  },
  pi: {
    id: 'pi',
    displayName: 'Pi',
    command: 'npx',
    args: ['-y', 'pi-acp'],
    defaultAgentName: 'Pi',
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    command: 'copilot',
    args: ['--acp'],
    defaultAgentName: 'GitHub Copilot',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    command: 'npx',
    args: ['-y', '@google/gemini-cli@latest', '--acp'],
    defaultAgentName: 'Gemini CLI',
  },
  agoragentic: {
    id: 'agoragentic',
    displayName: 'Agoragentic',
    command: 'npx',
    args: ['-y', 'agoragentic-mcp@latest', '--acp'],
    defaultAgentName: 'Agoragentic',
  },
  amp: {
    id: 'amp',
    displayName: 'Amp',
    command: 'amp-acp',
    args: [],
    defaultAgentName: 'Amp',
  },
  auggie: {
    id: 'auggie',
    displayName: 'Auggie CLI',
    command: 'npx',
    args: ['-y', '@augmentcode/auggie@latest', '--acp'],
    defaultAgentName: 'Auggie CLI',
    spawnEnv: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  autohand: {
    id: 'autohand',
    displayName: 'Autohand Code',
    command: 'npx',
    args: ['-y', '@autohandai/autohand-acp@latest'],
    defaultAgentName: 'Autohand Code',
  },
  cline: {
    id: 'cline',
    displayName: 'Cline',
    command: 'npx',
    args: ['-y', 'cline@latest', '--acp'],
    defaultAgentName: 'Cline',
  },
  codewhale: {
    id: 'codewhale',
    displayName: 'CodeWhale',
    command: 'codewhale',
    args: ['serve', '--acp'],
    defaultAgentName: 'CodeWhale',
  },
  'cortex-code': {
    id: 'cortex-code',
    displayName: 'Cortex Code',
    command: 'cortex',
    args: ['acp', 'serve'],
    defaultAgentName: 'Cortex Code',
  },
  'corust-agent': {
    id: 'corust-agent',
    displayName: 'Corust Agent',
    command: 'corust-agent-acp',
    args: [],
    defaultAgentName: 'Corust Agent',
  },
  'crow-cli': {
    id: 'crow-cli',
    displayName: 'crow-cli',
    command: 'crow-cli',
    args: ['acp'],
    defaultAgentName: 'crow-cli',
  },
  deepagents: {
    id: 'deepagents',
    displayName: 'DeepAgents',
    command: 'npx',
    args: ['-y', 'deepagents-acp@latest'],
    defaultAgentName: 'DeepAgents',
  },
  dimcode: {
    id: 'dimcode',
    displayName: 'DimCode',
    command: 'npx',
    args: ['-y', 'dimcode@latest', 'acp'],
    defaultAgentName: 'DimCode',
  },
  dirac: {
    id: 'dirac',
    displayName: 'Dirac',
    command: 'npx',
    args: ['-y', 'dirac-cli@latest', '--acp'],
    defaultAgentName: 'Dirac',
  },
  'factory-droid': {
    id: 'factory-droid',
    displayName: 'Factory Droid',
    command: 'npx',
    args: ['-y', 'droid@latest', 'exec', '--output-format', 'acp-daemon'],
    defaultAgentName: 'Factory Droid',
    spawnEnv: {
      DROID_DISABLE_AUTO_UPDATE: 'true',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
    },
  },
  'fast-agent': {
    id: 'fast-agent',
    displayName: 'fast-agent',
    command: 'uvx',
    args: ['--from', 'fast-agent-acp', 'fast-agent-acp', '-x'],
    defaultAgentName: 'fast-agent',
  },
  glm: {
    id: 'glm',
    displayName: 'GLM Agent',
    command: 'npx',
    args: ['-y', 'glm-acp-agent@latest'],
    defaultAgentName: 'GLM Agent',
  },
  goose: {
    id: 'goose',
    displayName: 'goose',
    command: 'goose',
    args: ['acp'],
    defaultAgentName: 'goose',
  },
  grok: {
    id: 'grok',
    displayName: 'Grok',
    command: 'grok',
    args: ['agent', 'stdio'],
    defaultAgentName: 'Grok',
  },
  junie: {
    id: 'junie',
    displayName: 'Junie',
    command: 'junie',
    args: ['--acp', 'true'],
    defaultAgentName: 'Junie',
  },
  kilo: {
    id: 'kilo',
    displayName: 'Kilo',
    command: 'kilo',
    args: ['acp'],
    defaultAgentName: 'Kilo',
  },
  'minion-code': {
    id: 'minion-code',
    displayName: 'Minion Code',
    command: 'uvx',
    args: ['--from', 'minion-code', 'minion-code', 'acp'],
    defaultAgentName: 'Minion Code',
  },
  'mistral-vibe': {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    command: 'vibe-acp',
    args: [],
    defaultAgentName: 'Mistral Vibe',
  },
  nova: {
    id: 'nova',
    displayName: 'Nova',
    command: 'npx',
    args: ['-y', '@compass-ai/nova@latest', 'acp'],
    defaultAgentName: 'Nova',
  },
  poolside: {
    id: 'poolside',
    displayName: 'Poolside',
    command: 'pool',
    args: ['acp'],
    defaultAgentName: 'Poolside',
  },
  qoder: {
    id: 'qoder',
    displayName: 'Qoder CLI',
    command: 'npx',
    args: ['-y', '@qoder-ai/qodercli@latest', '--acp'],
    defaultAgentName: 'Qoder CLI',
  },
  sigit: {
    id: 'sigit',
    displayName: 'siGit Code',
    command: 'sigit',
    args: [],
    defaultAgentName: 'siGit Code',
  },
  stakpak: {
    id: 'stakpak',
    displayName: 'Stakpak',
    command: 'stakpak',
    args: ['acp'],
    defaultAgentName: 'Stakpak',
  },
  traecli: {
    id: 'traecli',
    displayName: 'TRAE CLI',
    command: 'traecli',
    args: ['acp', 'serve'],
    defaultAgentName: 'TRAE CLI',
  },
  vtcode: {
    id: 'vtcode',
    displayName: 'VT Code',
    command: 'vtcode',
    args: ['acp'],
    defaultAgentName: 'VT Code',
    spawnEnv: {
      VT_ACP_ENABLED: '1',
      VT_ACP_ZED_ENABLED: '1',
    },
  },
};

export const BUILTIN_ENGINE_IDS = Object.keys(ACP_ENGINES) as BuiltinEngineId[];

export function isBuiltinEngineId(value: string): value is BuiltinEngineId {
  return Object.prototype.hasOwnProperty.call(ACP_ENGINES, value);
}

/** @deprecated Use isBuiltinEngineId */
export function isAcpEngineId(value: string): value is BuiltinEngineId {
  return isBuiltinEngineId(value);
}

export function getBuiltinEngineSpec(id: BuiltinEngineId): AcpEngineSpec {
  return ACP_ENGINES[id];
}

/** @deprecated Use getBuiltinEngineSpec */
export function getEngineSpec(id: BuiltinEngineId): AcpEngineSpec {
  return getBuiltinEngineSpec(id);
}

export function listBuiltinEngineIds(): BuiltinEngineId[] {
  return [...BUILTIN_ENGINE_IDS];
}

/** @deprecated Use listBuiltinEngineIds */
export function listEngineIds(): BuiltinEngineId[] {
  return listBuiltinEngineIds();
}

export function resolveEngineSpec(engineId: string, opts: ResolveEngineSpecOptions = {}): AcpEngineSpec {
  if (opts.acpCommand !== undefined && opts.acpCommand.trim().length > 0) {
    const parsed = parseShellCommand(opts.acpCommand);
    const displayName = opts.displayName ?? engineId;
    return {
      id: engineId,
      displayName,
      command: parsed.command,
      args: parsed.args,
      defaultAgentName: displayName,
    };
  }

  if (opts.command !== undefined) {
    const displayName = opts.displayName ?? engineId;
    return {
      id: engineId,
      displayName,
      command: opts.command,
      args: opts.args ?? [],
      defaultAgentName: displayName,
    };
  }

  if (isBuiltinEngineId(engineId)) {
    return ACP_ENGINES[engineId];
  }

  throw new Error(
    `Unknown engine "${engineId}". Register it in Agent Hub or pass --acp-command.`,
  );
}

function isHealthyCursorCli(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      env: { ...process.env, NO_OPEN_BROWSER: '1', CURSOR_AGENT_DISABLE_DEBUG_LOG: '1' },
      encoding: 'utf8',
      timeout: 12_000,
      stdio: 'pipe',
    });
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) return false;
    if (combined.includes('index.js:')) return false;
    return combined.trim().length > 0 && combined.length < 120;
  } catch {
    return false;
  }
}

function commonCliDirs(): string[] {
  return [
    join(homedir(), '.local', 'bin'),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA ?? '', 'cursor-agent'),
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor-agent'),
          join(process.env.USERPROFILE ?? '', '.local', 'bin'),
        ].filter((p) => p.length > 0)
      : []),
  ];
}

function whichBinary(name: string): string | null {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  if (which.status !== 0) return null;
  const line = which.stdout.trim().split(/\r?\n/)[0]?.trim();
  return line && line.length > 0 ? line : null;
}

function resolveCursorCliBinary(): string | null {
  const dirs = commonCliDirs();
  const candidates: string[] = [];
  for (const name of ['agent', 'cursor-agent']) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (existsSync(full)) candidates.push(full);
    }
    const found = whichBinary(name);
    if (found !== null) candidates.push(found);
  }
  const unique = [...new Set(candidates)];
  const healthy = unique.filter((p) => isHealthyCursorCli(p));
  if (healthy.length > 0) return healthy[0]!;
  return unique[0] ?? null;
}

/**
 * Prefer a real Codex CLI on PATH / common install dirs.
 * `@agentclientprotocol/codex-acp` uses CODEX_PATH when set; otherwise it falls
 * back to a bundled `@openai/codex` that often fails under `npx` (missing
 * optional platform binary).
 */
export function resolveCodexCliBinary(): string | null {
  const found = whichBinary('codex');
  if (found !== null) return found;
  for (const dir of commonCliDirs()) {
    const full = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    if (existsSync(full)) return full;
    if (process.platform === 'win32') {
      const exe = join(dir, 'codex.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/**
 * Claude / OpenRouter keys that Hub often has in its own process env.
 * `zcode-acp-server` treats a non-empty `ANTHROPIC_API_KEY` as an override of
 * `~/.zcode/v2/config.json`; leaking OpenRouter's token + base URL makes
 * `session/create` hang until the adapter's 15s timeout.
 */
export const ZCODE_FOREIGN_ANTHROPIC_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
] as const;

/**
 * Strip inherited Claude env and point `ZCODE_NODE` at this process's Node
 * when it can load `node:sqlite` (Node ≥ 22). Desktop API-key login in
 * `~/.zcode/v2/config.json` then applies unchanged.
 */
export function sanitizeZcodeAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of ZCODE_FOREIGN_ANTHROPIC_KEYS) {
    delete next[key];
  }
  if (!(next.ANTHROPIC_API_KEY ?? '').trim()) {
    delete next.ANTHROPIC_API_KEY;
  }
  if (!(next.ZCODE_NODE ?? '').trim()) {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (major >= 22) {
      next.ZCODE_NODE = process.execPath;
    }
  }
  return next;
}

/** Path to the stdio shim that answers ZCode server→client requests. */
export function resolveZcodeAppServerProxy(): string | null {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const name of ['zcode-app-server-proxy.js', 'zcode-app-server-proxy.ts']) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Point `ZCODE_BIN` at our stdio proxy and stash the real `zcode.cjs` in
 * `ZCODE_REAL_BIN`. zcode-acp-server launches `[node, ZCODE_BIN, app-server, --stdio]`.
 */
export function applyZcodeStdioBridge(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxy = resolveZcodeAppServerProxy();
  if (proxy === null) return env;
  const current = env.ZCODE_BIN?.trim() ?? '';
  if (current === proxy) return env;
  const real = current.length > 0 ? current : resolveZcodeCliBinary();
  if (real === null) return env;
  return { ...env, ZCODE_REAL_BIN: real, ZCODE_BIN: proxy };
}

/**
 * Prefer `ZCODE_BIN`, then PATH `zcode`, then the ZCode desktop bundled
 * `zcode.cjs`. `zcode-acp-server` uses ZCODE_BIN when set.
 */
export function resolveZcodeCliBinary(): string | null {
  const fromEnv = process.env.ZCODE_BIN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  const found = whichBinary('zcode');
  if (found !== null) return found;
  const bundled =
    process.platform === 'darwin'
      ? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
        : join(homedir(), 'ZCode', 'resources', 'glm', 'zcode.cjs');
  if (bundled.length > 0 && existsSync(bundled)) return bundled;
  if (process.platform === 'linux') {
    const opt = '/opt/ZCode/resources/glm/zcode.cjs';
    if (existsSync(opt)) return opt;
  }
  return null;
}

/** Resolve npx on Windows (.cmd shim); resolve Cursor CLI binary at spawn time. */
export function spawnCommand(
  spec: AcpEngineSpec,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  let command = spec.command;
  let args = [...spec.args];
  if (spec.id === 'cursor') {
    const resolved = resolveCursorCliBinary();
    if (resolved !== null) command = resolved;
    const apiKey = env.CURSOR_API_KEY;
    if (typeof apiKey === 'string' && apiKey.length > 0 && !args.includes('--api-key')) {
      args = ['--api-key', apiKey, ...args];
    }
    args = cursorRunModeSpawnArgs(requestedSessionMode(env), args);
  }
  if (spec.id === 'qwen-code') {
    args = qwenApprovalModeSpawnArgs(requestedSessionMode(env), args);
  }
  if (command === 'npx' && process.platform === 'win32') {
    return { command: 'npx.cmd', args };
  }
  if (command === 'uvx' && process.platform === 'win32') {
    return { command: 'uvx.exe', args };
  }
  return { command, args };
}

/** Log-safe spawn line (redacts --api-key values). */
export function formatSpawnCommandLine(
  command: string,
  args: readonly string[],
): string {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && i + 1 < args.length) {
      redacted.push('--api-key', '<redacted>');
      i++;
      continue;
    }
    redacted.push(args[i]!);
  }
  return `${command} ${redacted.join(' ')}`;
}
