/**
 * Built-in and custom ACP engine definitions for Agent Hub.
 */

import { validateProjectId } from './paths.js';

export const BUILTIN_ENGINE_IDS = [
  'codebuddy',
  'claude-code',
  'tclaude',
  'codex',
  'tcodex',
  'opencode',
  'openclaw',
  'cursor',
  'hermes',
] as const;

export type BuiltinAgentEngine = (typeof BUILTIN_ENGINE_IDS)[number];

/** @deprecated Prefer BuiltinAgentEngine — kept for existing imports. */
export type AgentEngine = BuiltinAgentEngine | (string & {});

export const BUILTIN_ENGINE_LABELS: Record<BuiltinAgentEngine, string> = {
  codebuddy: 'CodeBuddy Code',
  'claude-code': 'Claude Code',
  tclaude: 'TClaude',
  codex: 'Codex',
  tcodex: 'TCodex',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  cursor: 'Cursor',
  hermes: 'Hermes',
};

export interface CustomEngineDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface EngineInfo {
  readonly id: string;
  readonly displayName: string;
  readonly acpCommand: string;
  readonly builtin: boolean;
}

export class CustomEngineExistsError extends Error {
  constructor(id: string) {
    super(`Custom engine "${id}" already exists.`);
    this.name = 'CustomEngineExistsError';
  }
}

export class CustomEngineNotFoundError extends Error {
  constructor(id: string) {
    super(`No custom engine with id "${id}".`);
    this.name = 'CustomEngineNotFoundError';
  }
}

export class CustomEngineInUseError extends Error {
  constructor(id: string, projectIds: readonly string[]) {
    super(
      `Custom engine "${id}" is used by project(s): ${projectIds.join(', ')}. ` +
        'Remove or reassign those projects first.',
    );
    this.name = 'CustomEngineInUseError';
  }
}

export function isBuiltinEngine(id: string): id is BuiltinAgentEngine {
  return (BUILTIN_ENGINE_IDS as readonly string[]).includes(id);
}

export function formatShellCommand(command: string, args: ReadonlyArray<string>): string {
  const quote = (value: string): string => {
    if (/[\s"'\\]/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  };
  return [command, ...args.map(quote)].join(' ');
}

export function parseShellCommand(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('ACP command must not be empty.');
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < trimmed.length) {
        current += trimmed[++i];
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (quote !== null) {
    throw new Error('ACP command has an unclosed quote.');
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('ACP command must not be empty.');
  }

  return { command: tokens[0]!, args: tokens.slice(1) };
}

export function validateCustomEngineId(id: string): void {
  validateProjectId(id);
  if (isBuiltinEngine(id)) {
    throw new Error(`Engine id "${id}" is reserved for a built-in engine.`);
  }
}

export function findCustomEngine(
  customEngines: ReadonlyArray<CustomEngineDefinition>,
  id: string,
): CustomEngineDefinition | undefined {
  return customEngines.find((e) => e.id === id);
}

export function isKnownEngine(
  id: string,
  customEngines: ReadonlyArray<CustomEngineDefinition>,
): boolean {
  return isBuiltinEngine(id) || findCustomEngine(customEngines, id) !== undefined;
}

export function listEngineInfos(
  customEngines: ReadonlyArray<CustomEngineDefinition>,
): EngineInfo[] {
  const builtin: EngineInfo[] = BUILTIN_ENGINE_IDS.map((id) => ({
    id,
    displayName: BUILTIN_ENGINE_LABELS[id],
    acpCommand: '',
    builtin: true,
  }));

  const custom: EngineInfo[] = customEngines.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    acpCommand: formatShellCommand(e.command, e.args),
    builtin: false,
  }));

  return [...builtin, ...custom];
}

export function addCustomEngine(
  customEngines: ReadonlyArray<CustomEngineDefinition>,
  input: { id: string; displayName: string; acpCommand: string },
): CustomEngineDefinition[] {
  validateCustomEngineId(input.id);
  if (findCustomEngine(customEngines, input.id) !== undefined) {
    throw new CustomEngineExistsError(input.id);
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new Error('Display name must not be empty.');
  }
  const parsed = parseShellCommand(input.acpCommand);
  return [
    ...customEngines,
    {
      id: input.id,
      displayName,
      command: parsed.command,
      args: parsed.args,
    },
  ];
}

export function removeCustomEngine(
  customEngines: ReadonlyArray<CustomEngineDefinition>,
  id: string,
): CustomEngineDefinition[] {
  if (findCustomEngine(customEngines, id) === undefined) {
    throw new CustomEngineNotFoundError(id);
  }
  return customEngines.filter((e) => e.id !== id);
}

export function parseCustomEngines(raw: unknown): CustomEngineDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomEngineDefinition[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.displayName !== 'string') continue;
    if (typeof obj.command !== 'string') continue;
    const args = Array.isArray(obj.args)
      ? obj.args.filter((x): x is string => typeof x === 'string')
      : [];
    out.push({ id: obj.id, displayName: obj.displayName, command: obj.command, args });
  }
  return out;
}
