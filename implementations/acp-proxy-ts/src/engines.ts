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

export type BuiltinEngineId =
  | 'claude-code'
  | 'codebuddy'
  | 'codex'
  | 'opencode'
  | 'openclaw'
  | 'cursor'
  | 'hermes';

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
    args: ['-y', '@zed-industries/codex-acp@latest'],
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

/** Resolve npx on Windows (.cmd shim). */
export function spawnCommand(spec: AcpEngineSpec): { command: string; args: string[] } {
  if (spec.command === 'npx' && process.platform === 'win32') {
    return { command: 'npx.cmd', args: [...spec.args] };
  }
  return { command: spec.command, args: [...spec.args] };
}
