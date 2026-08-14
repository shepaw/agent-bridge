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
import { cursorRunModeSpawnArgs, requestedSessionMode } from './session-mode.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type BuiltinEngineId =
  | 'claude-code'
  | 'codebuddy'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'cursor'
  | 'hermes'
  | 'kimi';

/** @deprecated Use BuiltinEngineId — kept for existing imports. */
export type AcpEngineId = BuiltinEngineId;

export interface AcpEngineSpec {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Default Shepaw agent card name when --name is not supplied. */
  readonly defaultAgentName: string;
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
  if (command === 'npx' && process.platform === 'win32') {
    return { command: 'npx.cmd', args };
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
