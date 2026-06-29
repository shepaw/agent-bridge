/**
 * Registry of industry-standard ACP agent entry points.
 *
 * Each entry spawns a subprocess that speaks JSON-RPC over stdio using the
 * Agent Client Protocol (https://agentclientprotocol.com). The unified proxy
 * acts as the ACP Client; these processes are the ACP Agents.
 */

export type AcpEngineId =
  | 'claude-code'
  | 'tclaude'
  | 'codebuddy'
  | 'codex'
  | 'tcodex'
  | 'opencode'
  | 'openclaw'
  | 'cursor'
  | 'hermes';

export interface AcpEngineSpec {
  readonly id: AcpEngineId;
  readonly displayName: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Default Shepaw agent card name when --name is not supplied. */
  readonly defaultAgentName: string;
}

export const ACP_ENGINES: Record<AcpEngineId, AcpEngineSpec> = {
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    defaultAgentName: 'Claude Code',
  },
  tclaude: {
    id: 'tclaude',
    displayName: 'TClaude',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    defaultAgentName: 'TClaude',
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
  tcodex: {
    id: 'tcodex',
    displayName: 'TCodex',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp@latest'],
    defaultAgentName: 'TCodex',
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

export function isAcpEngineId(value: string): value is AcpEngineId {
  return Object.prototype.hasOwnProperty.call(ACP_ENGINES, value);
}

export function getEngineSpec(id: AcpEngineId): AcpEngineSpec {
  return ACP_ENGINES[id];
}

export function listEngineIds(): AcpEngineId[] {
  return Object.keys(ACP_ENGINES) as AcpEngineId[];
}

/** Resolve npx on Windows (.cmd shim). */
export function spawnCommand(spec: AcpEngineSpec): { command: string; args: string[] } {
  if (spec.command === 'npx' && process.platform === 'win32') {
    return { command: 'npx.cmd', args: [...spec.args] };
  }
  return { command: spec.command, args: [...spec.args] };
}
