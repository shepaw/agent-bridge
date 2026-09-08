/**
 * Built-in ACP engine catalog.
 *
 * Spawn commands follow each upstream CLI's ACP stdio entry; npx/uvx
 * packages use `@latest` like existing engines.
 *
 * Only engines that were verified end to end — and that ship a bundled avatar
 * under `core/assets/engines/` — are listed. Unverified engines are re-added
 * one at a time once they pass testing.
 */

export interface BuiltinEngineEnvHint {
  readonly key: string;
  readonly description: string;
  readonly optional?: boolean;
}

export interface BuiltinEngineDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly docsUrl?: string;
  readonly checkBinary: string;
  readonly checkPaths?: readonly string[];
  readonly installable: boolean;
  readonly installCommand?: string;
  /** Default env injected at ACP spawn (instance/engine env overrides). */
  readonly spawnEnv?: Readonly<Record<string, string>>;
  readonly requiredEnvVars?: readonly BuiltinEngineEnvHint[];
  /**
   * When true, {@link buildBuiltinSetupGuide} keeps a hand-written guide
   * (auth probes, non-PATH binaries, extra install steps).
   */
  readonly customSetup?: boolean;
}

function defineCatalog<const T extends readonly BuiltinEngineDefinition[]>(catalog: T): T {
  return catalog;
}

export const BUILTIN_ENGINE_CATALOG = defineCatalog([
  {
    id: 'codebuddy',
    displayName: 'CodeBuddy Code',
    description: '腾讯云 CodeBuddy Code，原生 ACP。',
    command: 'codebuddy',
    args: ['--acp'],
    docsUrl: 'https://www.codebuddy.cn/cli/',
    checkBinary: 'codebuddy',
    installable: false,
    customSetup: true,
    requiredEnvVars: [{ key: 'CODEBUDDY_AUTH_TOKEN', description: 'CodeBuddy 认证 Token' }],
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Anthropic Claude Code，经社区 ACP 适配器接入。',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    docsUrl: 'https://agentclientprotocol.com',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y @agentclientprotocol/claude-agent-acp@latest --version',
    customSetup: true,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex，经官方 @agentclientprotocol/codex-acp 接入。',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@latest'],
    checkBinary: 'codex',
    installable: true,
    installCommand: 'npm install -g @openai/codex@latest',
    customSetup: true,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    description: '开源编码助手，npx 运行 ACP 子命令。',
    command: 'npx',
    args: ['-y', 'opencode-ai@latest', 'acp'],
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y opencode-ai@latest --version',
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    description: 'OpenClaw ACP 模式。',
    command: 'npx',
    args: ['-y', 'openclaw', 'acp'],
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y openclaw --version',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    description: "Cursor CLI（agent / cursor-agent）ACP 模式。",
    command: 'agent',
    args: ['acp'],
    docsUrl: 'https://cursor.com/docs/cli/acp',
    checkBinary: 'agent',
    installable: true,
    customSetup: true,
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    description: 'Nous Research Hermes，原生 ACP。',
    command: 'hermes',
    args: ['acp'],
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
    checkBinary: 'hermes',
    installable: false,
  },
  {
    id: 'kimi',
    displayName: 'Kimi CLI',
    description: 'Moonshot AI Kimi Code CLI，原生 ACP。',
    command: 'kimi',
    args: ['acp'],
    docsUrl: 'https://github.com/MoonshotAI/kimi-code',
    checkBinary: 'kimi',
    installable: true,
    customSetup: true,
  },
  {
    id: 'zcode',
    displayName: 'ZCode',
    description: '智谱 Z.AI ZCode，经 zcode-acp-server 接入。',
    command: 'npx',
    args: ['-y', 'zcode-acp-server@latest'],
    docsUrl: 'https://zcode.z.ai/en/docs/install',
    checkBinary: 'zcode',
    installable: false,
    customSetup: true,
  },
  {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    description: 'DeepSeek Harness，以「DSH + Shepaw 插件」方式接入（dsh --profile shepaw）。',
    command: 'dsh',
    args: ['--profile', 'shepaw'],
    docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    checkBinary: 'dsh',
    installable: true,
    customSetup: true,
  },
  {
    id: 'pi',
    displayName: 'Pi',
    description: 'Pi coding agent，经社区 ACP 适配器 pi-acp 接入（需本机 pi CLI）。',
    command: 'npx',
    args: ['-y', 'pi-acp'],
    docsUrl: 'https://pi.dev',
    checkBinary: 'pi',
    installable: true,
    installCommand: 'npm install -g @earendil-works/pi-coding-agent@latest',
  },
]);

export type BuiltinAgentEngine = (typeof BUILTIN_ENGINE_CATALOG)[number]['id'];

export const BUILTIN_ENGINE_IDS: readonly BuiltinAgentEngine[] = BUILTIN_ENGINE_CATALOG.map(
  (e) => e.id,
);

const labels = {} as Record<BuiltinAgentEngine, string>;
const byId = {} as Record<BuiltinAgentEngine, BuiltinEngineDefinition>;
for (const entry of BUILTIN_ENGINE_CATALOG) {
  labels[entry.id] = entry.displayName;
  byId[entry.id] = entry;
}

export const BUILTIN_ENGINE_LABELS: Record<BuiltinAgentEngine, string> = labels;
export const BUILTIN_ENGINE_BY_ID: Record<BuiltinAgentEngine, BuiltinEngineDefinition> = byId;

export function isBuiltinEngineId(id: string): id is BuiltinAgentEngine {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ENGINE_BY_ID, id);
}

export function findBuiltinEngineDefinition(id: string): BuiltinEngineDefinition | undefined {
  if (!isBuiltinEngineId(id)) return undefined;
  return BUILTIN_ENGINE_BY_ID[id];
}

export function formatCatalogAcpCommand(entry: BuiltinEngineDefinition): string {
  return [entry.command, ...entry.args].join(' ').trim();
}

export function acpCommandForEngine(id: BuiltinAgentEngine): string {
  return formatCatalogAcpCommand(BUILTIN_ENGINE_BY_ID[id]);
}
