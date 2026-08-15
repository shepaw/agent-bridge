/**
 * Built-in ACP engine catalog.
 *
 * Covers Paseo's 39 providers (native + ACP catalog) plus Shepaw extras
 * (OpenClaw, ZCode, DeepSeek Harness). Spawn commands follow each upstream
 * CLI's ACP stdio entry; npx/uvx packages use `@latest` like existing engines.
 *
 * @see https://paseo.sh/docs/supported-providers
 * @see https://github.com/getpaseo/paseo/blob/main/packages/app/src/data/acp-provider-catalog.ts
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
    description: 'DeepSeek Harness 官方 ACP stdio 入口。',
    command: 'npx',
    args: ['-y', '@deepseek-ai/dsh-acp-demo@latest'],
    docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    checkBinary: 'npx',
    installable: true,
    customSetup: true,
  },
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    description: '阿里云 Qwen Code，原生 ACP（qwen --acp）。',
    command: 'qwen',
    args: ['--acp'],
    docsUrl: 'https://github.com/QwenLM/qwen-code',
    checkBinary: 'qwen',
    installable: true,
    customSetup: true,
    requiredEnvVars: [
      {
        key: 'OPENAI_API_KEY',
        description: 'OpenAI 兼容 API Key（已用 qwen /auth 或 ~/.qwen/settings.json 配置时可省略）',
        optional: true,
      },
      {
        key: 'OPENAI_BASE_URL',
        description: '自定义 API 端点（如 DashScope / Coding Plan / OpenRouter）',
        optional: true,
      },
      {
        key: 'OPENAI_MODEL',
        description: '默认模型 ID（如 qwen3-coder-plus）',
        optional: true,
      },
      {
        key: 'BAILIAN_CODING_PLAN_API_KEY',
        description: '阿里云百炼 Coding Plan Key（使用 Coding Plan 端点时）',
        optional: true,
      },
    ],
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
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    description: 'GitHub Copilot CLI，原生 ACP。',
    command: 'copilot',
    args: ['--acp'],
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    checkBinary: 'copilot',
    installable: true,
    installCommand: 'npm install -g @github/copilot@latest',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    description: 'Google Gemini CLI，原生 ACP。',
    command: 'npx',
    args: ['-y', '@google/gemini-cli@latest', '--acp'],
    docsUrl: 'https://geminicli.com',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y @google/gemini-cli@latest --version',
    requiredEnvVars: [
      {
        key: 'GEMINI_API_KEY',
        description: 'Gemini API Key（已用 gemini 登录时可省略）',
        optional: true,
      },
    ],
  },
  {
    id: 'agoragentic',
    displayName: 'Agoragentic',
    description: 'Agent 市场，ACP 接入。',
    command: 'npx',
    args: ['-y', 'agoragentic-mcp@latest', '--acp'],
    docsUrl: 'https://agoragentic.com',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y agoragentic-mcp@latest --version',
  },
  {
    id: 'amp',
    displayName: 'Amp',
    description: 'Sourcegraph Amp 的 ACP 封装。',
    command: 'amp-acp',
    args: [],
    docsUrl: 'https://github.com/tao12345666333/amp-acp',
    checkBinary: 'amp-acp',
    installable: false,
  },
  {
    id: 'auggie',
    displayName: 'Auggie CLI',
    description: 'Augment Code Auggie，原生 ACP。',
    command: 'npx',
    args: ['-y', '@augmentcode/auggie@latest', '--acp'],
    docsUrl: 'https://www.augmentcode.com/',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y @augmentcode/auggie@latest --version',
    spawnEnv: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  {
    id: 'autohand',
    displayName: 'Autohand Code',
    description: 'Autohand AI 编码 agent。',
    command: 'npx',
    args: ['-y', '@autohandai/autohand-acp@latest'],
    docsUrl: 'https://www.autohand.ai/cli/',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y @autohandai/autohand-acp@latest --version',
  },
  {
    id: 'cline',
    displayName: 'Cline',
    description: 'Cline 自主编码 agent CLI。',
    command: 'npx',
    args: ['-y', 'cline@latest', '--acp'],
    docsUrl: 'https://cline.bot/cli',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y cline@latest --version',
  },
  {
    id: 'codewhale',
    displayName: 'CodeWhale',
    description: '面向 DeepSeek V4 与开源模型的终端编码 agent。',
    command: 'codewhale',
    args: ['serve', '--acp'],
    docsUrl: 'https://codewhale.net/',
    checkBinary: 'codewhale',
    installable: false,
  },
  {
    id: 'cortex-code',
    displayName: 'Cortex Code',
    description: 'Snowflake Cortex Code。',
    command: 'cortex',
    args: ['acp', 'serve'],
    docsUrl: 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli',
    checkBinary: 'cortex',
    installable: false,
  },
  {
    id: 'corust-agent',
    displayName: 'Corust Agent',
    description: '面向 Rust 的结对编程 agent。',
    command: 'corust-agent-acp',
    args: [],
    docsUrl: 'https://github.com/Corust-ai/corust-agent-release/releases',
    checkBinary: 'corust-agent-acp',
    installable: false,
  },
  {
    id: 'crow-cli',
    displayName: 'crow-cli',
    description: '轻量原生 ACP 编码 agent。',
    command: 'crow-cli',
    args: ['acp'],
    docsUrl: 'https://crow-ai.dev/',
    checkBinary: 'crow-cli',
    installable: false,
  },
  {
    id: 'deepagents',
    displayName: 'DeepAgents',
    description: 'LangChain DeepAgents ACP 适配器。',
    command: 'npx',
    args: ['-y', 'deepagents-acp@latest'],
    docsUrl: 'https://docs.langchain.com/oss/javascript/deepagents/overview',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y deepagents-acp@latest --version',
  },
  {
    id: 'dimcode',
    displayName: 'DimCode',
    description: '多模型编码 agent。',
    command: 'npx',
    args: ['-y', 'dimcode@latest', 'acp'],
    docsUrl: 'https://dimcode.dev/docs/acp.html',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y dimcode@latest --version',
  },
  {
    id: 'dirac',
    displayName: 'Dirac',
    description: '开源编码 agent（并行编辑 / AST）。',
    command: 'npx',
    args: ['-y', 'dirac-cli@latest', '--acp'],
    docsUrl: 'https://dirac.run',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y dirac-cli@latest --version',
  },
  {
    id: 'factory-droid',
    displayName: 'Factory Droid',
    description: 'Factory AI Droid，ACP daemon 输出。',
    command: 'npx',
    args: ['-y', 'droid@latest', 'exec', '--output-format', 'acp-daemon'],
    docsUrl: 'https://factory.ai/product/cli',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y droid@latest --version',
    spawnEnv: {
      DROID_DISABLE_AUTO_UPDATE: 'true',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
    },
  },
  {
    id: 'fast-agent',
    displayName: 'fast-agent',
    description: '多模型编码 agent（uvx 运行 ACP 适配器）。',
    command: 'uvx',
    args: ['--from', 'fast-agent-acp', 'fast-agent-acp', '-x'],
    docsUrl: 'https://fast-agent.ai/acp/',
    checkBinary: 'uvx',
    installable: true,
    installCommand: 'uvx --from fast-agent-acp fast-agent-acp --help',
  },
  {
    id: 'glm',
    displayName: 'GLM Agent',
    description: '智谱 GLM Coding Plan ACP agent。',
    command: 'npx',
    args: ['-y', 'glm-acp-agent@latest'],
    docsUrl: 'https://github.com/stefandevo/glm-acp-agent',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y glm-acp-agent@latest --version',
    requiredEnvVars: [
      {
        key: 'ZAI_API_KEY',
        description: 'Z.AI / GLM Coding Plan API Key',
        optional: true,
      },
    ],
  },
  {
    id: 'goose',
    displayName: 'goose',
    description: 'Block goose，本地开源 agent，原生 ACP。',
    command: 'goose',
    args: ['acp'],
    docsUrl: 'https://block.github.io/goose/',
    checkBinary: 'goose',
    installable: false,
  },
  {
    id: 'grok',
    displayName: 'Grok',
    description: 'xAI Grok Build CLI（需 SuperGrok 或 X Premium+）。',
    command: 'grok',
    args: ['agent', 'stdio'],
    docsUrl: 'https://docs.x.ai/build/overview',
    checkBinary: 'grok',
    installable: false,
  },
  {
    id: 'junie',
    displayName: 'Junie',
    description: 'JetBrains Junie CLI，原生 ACP。',
    command: 'junie',
    args: ['--acp', 'true'],
    docsUrl: 'https://junie.jetbrains.com/docs/junie-cli-acp.html',
    checkBinary: 'junie',
    installable: false,
  },
  {
    id: 'kilo',
    displayName: 'Kilo',
    description: '开源编码 agent Kilo Code。',
    command: 'kilo',
    args: ['acp'],
    docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    checkBinary: 'kilo',
    installable: false,
  },
  {
    id: 'minion-code',
    displayName: 'Minion Code',
    description: 'Minion 框架编码助手（uvx）。',
    command: 'uvx',
    args: ['--from', 'minion-code', 'minion-code', 'acp'],
    docsUrl: 'https://github.com/femto/minion-code',
    checkBinary: 'uvx',
    installable: true,
    installCommand: 'uvx --from minion-code minion-code --help',
  },
  {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    description: 'Mistral 开源编码助手 ACP 入口。',
    command: 'vibe-acp',
    args: [],
    docsUrl: 'https://github.com/mistralai/mistral-vibe',
    checkBinary: 'vibe-acp',
    installable: false,
  },
  {
    id: 'nova',
    displayName: 'Nova',
    description: 'Compass AI Nova。',
    command: 'npx',
    args: ['-y', '@compass-ai/nova@latest', 'acp'],
    docsUrl: 'https://www.compassap.ai/portfolio/nova.html',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y @compass-ai/nova@latest --version',
  },
  {
    id: 'poolside',
    displayName: 'Poolside',
    description: 'Poolside 编码 agent。',
    command: 'pool',
    args: ['acp'],
    docsUrl: 'https://docs.poolside.ai/cli/pool',
    checkBinary: 'pool',
    installable: false,
  },
  {
    id: 'qoder',
    displayName: 'Qoder CLI',
    description: 'Qoder 编码助手，原生 ACP。',
    command: 'npx',
    args: ['-y', '@qoder-ai/qodercli@latest', '--acp'],
    docsUrl: 'https://qoder.com',
    checkBinary: 'npx',
    installable: true,
    installCommand: 'npx -y @qoder-ai/qodercli@latest --version',
  },
  {
    id: 'sigit',
    displayName: 'siGit Code',
    description: '本地优先编码 agent，可选端侧 LLM。',
    command: 'sigit',
    args: [],
    docsUrl: 'https://github.com/getsigit/sigit',
    checkBinary: 'sigit',
    installable: false,
  },
  {
    id: 'stakpak',
    displayName: 'Stakpak',
    description: 'Rust 实现的开源 DevOps agent。',
    command: 'stakpak',
    args: ['acp'],
    docsUrl: 'https://stakpak.dev/',
    checkBinary: 'stakpak',
    installable: false,
  },
  {
    id: 'traecli',
    displayName: 'TRAE CLI',
    description: '字节跳动 TRAE CLI，原生 ACP。',
    command: 'traecli',
    args: ['acp', 'serve'],
    docsUrl: 'https://docs.trae.cn/cli_get-started-with-trae-cli',
    checkBinary: 'traecli',
    installable: false,
  },
  {
    id: 'vtcode',
    displayName: 'VT Code',
    description: '开源多模型编码 agent，原生 ACP。',
    command: 'vtcode',
    args: ['acp'],
    docsUrl: 'https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md',
    checkBinary: 'vtcode',
    installable: false,
    spawnEnv: {
      VT_ACP_ENABLED: '1',
      VT_ACP_ZED_ENABLED: '1',
    },
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
