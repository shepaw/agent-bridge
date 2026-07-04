/**
 * Per-engine environment setup guides, prerequisite checks, and one-click
 * install helpers for the Agent Hub dashboard.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { findCustomEngine, isBuiltinEngine, type BuiltinAgentEngine, type CustomEngineDefinition, type EngineInfo } from './engines.js';

export interface EngineSetupStep {
  readonly title: string;
  readonly description: string;
  /** Optional shell command shown for copy/paste. */
  readonly command?: string;
}

export interface EngineEnvVarHint {
  readonly key: string;
  readonly description: string;
  readonly optional?: boolean;
}

export interface EngineSetupGuide {
  readonly engineId: string;
  readonly summary: string;
  readonly acpCommand: string;
  readonly docsUrl?: string;
  readonly steps: readonly EngineSetupStep[];
  /** Shell command run by POST /api/engines/:id/install. Omitted when manual-only. */
  readonly installCommand?: string;
  /** Binary name or path used for prerequisite detection. */
  readonly checkBinary: string;
  /** Extra directories searched before PATH (e.g. ~/.local/bin for Cursor CLI). */
  readonly checkPaths?: readonly string[];
  readonly requiredEnvVars?: readonly EngineEnvVarHint[];
  readonly installable: boolean;
  /** Hub host OS this guide was generated for (install commands run on the Hub machine). */
  readonly platform?: HubPlatform;
  readonly platformLabel?: string;
}

/** Normalized OS for setup guides and install scripts (Hub server side). */
export type HubPlatform = 'darwin' | 'linux' | 'win32';

export function detectHubPlatform(platform: NodeJS.Platform = process.platform): HubPlatform {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

export function hubPlatformLabel(platform: HubPlatform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
  }
}

function withPlatformMeta(guide: EngineSetupGuide, platform: HubPlatform): EngineSetupGuide {
  return { ...guide, platform, platformLabel: hubPlatformLabel(platform) };
}

export interface EngineInstallStatus {
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly checkError: string | null;
}

export interface EngineAvailability extends EngineInstallStatus {
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface EngineInstallResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: EngineInstallStatus;
}

/** Built-in upstream ACP spawn commands (mirrors acp-proxy-ts/src/engines.ts). */
export const BUILTIN_ENGINE_ACP_COMMANDS: Record<BuiltinAgentEngine, string> = {
  'claude-code': 'npx -y @agentclientprotocol/claude-agent-acp@latest',
  codebuddy: 'codebuddy --acp',
  codex: 'npx -y @zed-industries/codex-acp@latest',
  opencode: 'npx -y opencode-ai@latest acp',
  openclaw: 'npx -y openclaw acp',
  cursor: 'agent acp',
  hermes: 'hermes acp',
};

const LOCAL_BIN = join(homedir(), '.local', 'bin');

/** Cursor CLI may be installed as `agent` or `cursor-agent` (Homebrew cask). */
export const CURSOR_CLI_BINARIES = ['agent', 'cursor-agent'] as const;

export function cursorCliSearchPaths(platform: HubPlatform = detectHubPlatform()): string[] {
  const paths = [LOCAL_BIN, join(homedir(), '.codebuddy', 'bin')];
  if (platform === 'darwin') {
    paths.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      paths.push(join(localAppData, 'cursor-agent'));
      paths.push(join(localAppData, 'Programs', 'cursor-agent'));
    }
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      paths.push(join(userProfile, '.local', 'bin'));
    }
  }
  return paths;
}

export function getCursorAcpCommand(): string {
  const bin = resolveCursorCliBinary();
  return bin !== null ? `${bin} acp` : BUILTIN_ENGINE_ACP_COMMANDS.cursor;
}

/** Warn when ~/.local is not writable (blocks the official curl installer). */
export function detectLocalDirPermissionIssue(): string | null {
  const local = join(homedir(), '.local');
  if (!existsSync(local)) return null;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) return null;
    const st = statSync(local);
    if (st.uid !== uid) {
      return (
        `~/.local 目录属主异常（当前用户无法写入），官方 curl 安装会失败。` +
        ` 请检查目录权限，或按当前系统文档使用其他安装方式。`
      );
    }
  } catch {
    // ignore
  }
  return null;
}

export function checkCursorInstallStatus(): EngineInstallStatus {
  const candidates = cursorCliCandidates();
  const healthy = candidates.filter((p) => isHealthyCursorCli(p));
  const binaryPath = healthy[0] ?? candidates[0] ?? null;
  if (binaryPath === null) {
    return {
      installed: false,
      binaryPath: null,
      version: null,
      checkError: detectLocalDirPermissionIssue() ?? '未找到 agent 或 cursor-agent 命令',
    };
  }
  if (!isHealthyCursorCli(binaryPath)) {
    return {
      installed: false,
      binaryPath,
      version: null,
      checkError:
        '已找到 cursor-agent 但 CLI 无法正常运行（Homebrew 版本已知有问题）。' +
        '请运行：curl https://cursor.com/install -fsS | bash',
    };
  }
  return {
    installed: true,
    binaryPath,
    version: probeVersion(binaryPath, binaryPath.endsWith('cursor-agent') ? 'cursor-agent' : 'agent'),
    checkError: null,
  };
}

const CURSOR_API_PROBE_URL = 'https://api.cursor.com/v0/me';

/** Probe whether a Cursor User API Key is accepted (sync, ~1–3s). */
export function probeCursorApiKey(apiKey: string): 'valid' | 'invalid' | 'unknown' {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return 'invalid';
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const r=await fetch(${JSON.stringify(CURSOR_API_PROBE_URL)},{headers:{Authorization:'Bearer '+process.env._CURSOR_PROBE_KEY}});process.exit(r.ok?0:r.status===401?1:2);`,
      ],
      {
        env: { ...process.env, _CURSOR_PROBE_KEY: trimmed },
        timeout: 12_000,
        stdio: 'pipe',
      },
    );
    if (result.status === 0) return 'valid';
    if (result.status === 1) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** True when the CLI responds cleanly to --version (Homebrew cask builds have regressed). */
export function isHealthyCursorCli(binaryPath: string): boolean {
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

function cursorCliCandidates(): string[] {
  const names = [...CURSOR_CLI_BINARIES];
  const paths = cursorCliSearchPaths();
  const found: string[] = [];
  for (const name of names) {
    const path = resolveBinaryPath(name, paths);
    if (path !== null) found.push(path);
  }
  return [...new Set(found)];
}

export function resolveCursorCliBinary(): string | null {
  const candidates = cursorCliCandidates();
  const healthy = candidates.filter((p) => isHealthyCursorCli(p));
  if (healthy.length > 0) return healthy[0]!;
  return candidates[0] ?? null;
}

function resolveCursorAuthAvailability(
  status: EngineInstallStatus,
  cursorApiKey: string | undefined,
): EngineAvailability | null {
  const key = cursorApiKey?.trim();
  if (key === undefined || key.length === 0) {
    return {
      ...status,
      available: false,
      unavailableReason:
        '未认证：请运行 cursor-agent login，或在引擎设置中配置有效的 CURSOR_API_KEY（Cursor → Settings → Integrations → User API Keys）',
    };
  }
  const probe = probeCursorApiKey(key);
  if (probe === 'invalid') {
    return {
      ...status,
      available: false,
      unavailableReason:
        'CURSOR_API_KEY 无效（API 返回 401）。请在 Cursor → Settings → Integrations 重新生成 User API Key 并更新引擎凭据',
    };
  }
  return null;
}

function nodeInstallStep(platform: HubPlatform): EngineSetupStep {
  if (platform === 'win32') {
    return {
      title: '安装 Node.js',
      description:
        '需要 Node.js 18+ 与 npm/npx。可从 https://nodejs.org 下载 Windows 安装包，或使用 winget：winget install OpenJS.NodeJS.LTS。',
      command: 'node --version && npx --version',
    };
  }
  if (platform === 'darwin') {
    return {
      title: '安装 Node.js',
      description:
        '需要 Node.js 18+ 与 npm/npx。可用 Homebrew（brew install node）、nvm，或从 https://nodejs.org 安装。',
      command: 'node --version && npx --version',
    };
  }
  return {
    title: '安装 Node.js',
    description:
      '需要 Node.js 18+ 与 npm/npx。可用发行版包管理器、nvm，或从 https://nodejs.org 安装。',
    command: 'node --version && npx --version',
  };
}

const CURSOR_INSTALL_WIN32 =
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm 'https://cursor.com/install?win32=true' | iex\"";
const CURSOR_INSTALL_UNIX = 'curl https://cursor.com/install -fsS | bash';

function buildCursorGuide(platform: HubPlatform): EngineSetupGuide {
  const checkPaths =
    platform === 'darwin'
      ? [LOCAL_BIN, '/opt/homebrew/bin']
      : platform === 'win32'
        ? [
            join(process.env.LOCALAPPDATA ?? '', 'cursor-agent'),
            join(process.env.USERPROFILE ?? '', '.local', 'bin'),
          ].filter((p) => p.length > 0)
        : [LOCAL_BIN];

  if (platform === 'win32') {
    return {
      engineId: 'cursor',
      summary:
        'Cursor CLI（agent）提供 ACP 服务；需单独安装，与 Cursor 桌面版不同。以下步骤适用于 Windows（Hub 所在机器）。',
      acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.cursor,
      docsUrl: 'https://cursor.com/docs/cli/acp',
      checkBinary: 'agent',
      checkPaths,
      installable: true,
      installCommand: CURSOR_INSTALL_WIN32,
      requiredEnvVars: [
        {
          key: 'CURSOR_API_KEY',
          description: 'User API Key（Cursor → Integrations）；ACP 需要有效 Key 或 agent login',
          optional: true,
        },
      ],
      steps: [
        {
          title: '安装 Cursor CLI',
          description: '在 PowerShell 中运行官方安装脚本（安装 agent 到用户目录）。',
          command: "irm 'https://cursor.com/install?win32=true' | iex",
        },
        {
          title: '确保 CLI 在 PATH 中',
          description:
            '安装后重新打开终端，或把 agent 所在目录加入用户 PATH。Hub 启动 gateway 时会追加常见安装路径。',
        },
        {
          title: '完成认证',
          description: '运行 agent login，或在默认凭据区配置 CURSOR_API_KEY。',
          command: 'agent login',
        },
        {
          title: '验证 ACP 模式',
          description:
            '进程应保持运行（Ctrl+C 退出）。若立即退出，请检查 API Key 或重新 login。',
          command: '$env:NO_OPEN_BROWSER=1; agent acp',
        },
      ],
    };
  }

  const unixInstallNote =
    platform === 'darwin'
      ? '推荐官方 curl 安装（~/.local/bin/agent）。Homebrew 的 cursor-agent 在部分版本上无法正常启动 ACP。'
      : '推荐官方 curl 安装（~/.local/bin/agent）。';

  return {
    engineId: 'cursor',
    summary:
      `Cursor CLI（agent / cursor-agent）提供 ACP 服务；需单独安装，与 Cursor 桌面版不同。以下步骤适用于 ${hubPlatformLabel(platform)}（Hub 所在机器）。`,
    acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.cursor,
    docsUrl: 'https://cursor.com/docs/cli/acp',
    checkBinary: 'agent',
    checkPaths,
    installable: true,
    installCommand: CURSOR_INSTALL_UNIX,
    requiredEnvVars: [
      {
        key: 'CURSOR_API_KEY',
        description: 'User API Key（Cursor → Integrations）；ACP 需要有效 Key 或 agent login',
        optional: true,
      },
    ],
    steps: [
      {
        title: '安装 Cursor CLI',
        description: unixInstallNote,
        command: CURSOR_INSTALL_UNIX,
      },
      {
        title: '确保 CLI 在 PATH 中',
        description:
          platform === 'darwin'
            ? 'curl 安装通常在 ~/.local/bin；Homebrew 在 /opt/homebrew/bin。可执行 export PATH="$HOME/.local/bin:$PATH"。Hub 启动时会自动追加这些路径。'
            : 'curl 安装通常在 ~/.local/bin。可执行 export PATH="$HOME/.local/bin:$PATH"。Hub 启动时会自动追加该路径。',
      },
      {
        title: '完成认证',
        description: '运行 agent login，或在默认凭据区配置 CURSOR_API_KEY。',
        command: 'agent login',
      },
      {
        title: '验证 ACP 模式',
        description:
          '能启动即表示 CLI 可用（Ctrl+C 退出）。若立即退出，请检查 API Key 或重新 login。',
        command: 'NO_OPEN_BROWSER=1 agent acp',
      },
    ],
  };
}

function buildBuiltinSetupGuide(engineId: BuiltinAgentEngine, platform: HubPlatform): EngineSetupGuide {
  switch (engineId) {
    case 'claude-code':
      return {
        engineId: 'claude-code',
        summary: `通过 npx 拉取 Claude Code 官方 ACP 适配器（${hubPlatformLabel(platform)}）。需要 Node.js 与 Anthropic 凭据。`,
        acpCommand: BUILTIN_ENGINE_ACP_COMMANDS['claude-code'],
        docsUrl: 'https://agentclientprotocol.com',
        checkBinary: 'npx',
        installable: true,
        installCommand: 'npx -y @agentclientprotocol/claude-agent-acp@latest --version',
        requiredEnvVars: [
          { key: 'ANTHROPIC_API_KEY', description: 'Anthropic API Key（或在下方凭据区配置）' },
        ],
        steps: [
          nodeInstallStep(platform),
          {
            title: '配置 Anthropic 凭据',
            description: '在下方「默认凭据」添加 ANTHROPIC_API_KEY，或在实例环境变量中覆盖。',
          },
          {
            title: '预热 ACP 包（可选）',
            description: '首次启动也会自动下载；一键安装会预先拉取适配器包。',
            command: 'npx -y @agentclientprotocol/claude-agent-acp@latest --version',
          },
        ],
      };
    case 'codebuddy':
      return {
        engineId: 'codebuddy',
        summary: `CodeBuddy Code 原生支持 ACP，需单独安装 codebuddy CLI（${hubPlatformLabel(platform)}）。`,
        acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.codebuddy,
        docsUrl: 'https://www.codebuddy.ai',
        checkBinary: 'codebuddy',
        checkPaths: [join(homedir(), '.codebuddy', 'bin')],
        installable: false,
        requiredEnvVars: [{ key: 'CODEBUDDY_AUTH_TOKEN', description: 'CodeBuddy 认证 Token' }],
        steps: [
          {
            title: '安装 CodeBuddy CLI',
            description: `按 CodeBuddy 官方文档在 ${hubPlatformLabel(platform)} 上安装 CLI，并确保 codebuddy 在 PATH 中。`,
            command: 'codebuddy --version',
          },
          {
            title: '验证 ACP 模式',
            description: 'Gateway 会执行 codebuddy --acp 作为上游子进程。',
            command: 'codebuddy --acp',
          },
          { title: '配置凭据', description: '在默认凭据区添加 CODEBUDDY_AUTH_TOKEN。' },
        ],
      };
    case 'codex':
      return {
        engineId: 'codex',
        summary: `通过 npx 运行 Codex ACP 适配器（${hubPlatformLabel(platform)}）；需要 Node.js 与 OpenAI 凭据。`,
        acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.codex,
        checkBinary: 'npx',
        installable: true,
        installCommand: 'npx -y @zed-industries/codex-acp@latest --version',
        requiredEnvVars: [{ key: 'OPENAI_API_KEY', description: 'OpenAI API Key' }],
        steps: [
          nodeInstallStep(platform),
          { title: '配置 OPENAI_API_KEY', description: '在默认凭据区或实例环境变量中设置。' },
          {
            title: '预热适配器',
            command: 'npx -y @zed-industries/codex-acp@latest --version',
            description: '一键安装会预先下载 Codex ACP 包。',
          },
        ],
      };
    case 'opencode':
      return {
        engineId: 'opencode',
        summary: `通过 npx 运行 OpenCode ACP 子命令（${hubPlatformLabel(platform)}）。`,
        acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.opencode,
        checkBinary: 'npx',
        installable: true,
        installCommand: 'npx -y opencode-ai@latest --version',
        steps: [
          nodeInstallStep(platform),
          {
            title: '预热 OpenCode',
            command: 'npx -y opencode-ai@latest acp',
            description: '首次对话时也会自动拉取；一键安装预先下载 CLI 包。',
          },
        ],
      };
    case 'openclaw':
      return {
        engineId: 'openclaw',
        summary: `通过 npx 运行 OpenClaw ACP 模式（${hubPlatformLabel(platform)}）。`,
        acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.openclaw,
        checkBinary: 'npx',
        installable: true,
        installCommand: 'npx -y openclaw --version',
        steps: [
          nodeInstallStep(platform),
          {
            title: '预热 OpenClaw',
            command: 'npx -y openclaw acp',
            description: '一键安装预先下载 openclaw 包。',
          },
        ],
      };
    case 'cursor':
      return buildCursorGuide(platform);
    case 'hermes':
      return {
        engineId: 'hermes',
        summary: `Hermes 提供原生 ACP 接口，需按上游文档在 ${hubPlatformLabel(platform)} 上自行安装 hermes CLI。`,
        acpCommand: BUILTIN_ENGINE_ACP_COMMANDS.hermes,
        checkBinary: 'hermes',
        installable: false,
        steps: [
          {
            title: '安装 Hermes CLI',
            description: '按 Hermes 项目文档安装，并确保 hermes 在 PATH 中。',
            command: 'hermes --version',
          },
          {
            title: '验证 ACP',
            command: 'hermes acp',
            description: 'Gateway 通过 hermes acp 子进程接入。',
          },
        ],
      };
  }
}

const CUSTOM_ENGINE_SETUP: EngineSetupGuide = {
  engineId: 'custom',
  summary: '自定义引擎需手动安装上游 CLI，并在上方配置 ACP 启动命令。',
  acpCommand: '',
  installable: false,
  checkBinary: '',
  steps: [
    {
      title: '安装上游 CLI',
      description: '按你的 agent 文档安装，并确保命令在 Hub 进程的 PATH 中可用。',
    },
    {
      title: '配置 ACP 命令',
      description: '在「引擎命令」中填写完整 spawn 命令，例如 /usr/local/bin/my-cli --acp。',
    },
    {
      title: '配置凭据（如需要）',
      description: '在下方默认凭据区添加该 CLI 所需的环境变量。',
    },
  ],
};

/** Directories commonly holding agent CLIs; prepended to PATH at gateway spawn. */
export function spawnPathPrefixes(platform: HubPlatform = detectHubPlatform()): readonly string[] {
  const prefixes: string[] = [LOCAL_BIN, join(homedir(), '.codebuddy', 'bin')];
  if (platform === 'darwin') {
    prefixes.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      prefixes.push(join(localAppData, 'cursor-agent'));
      prefixes.push(join(localAppData, 'Programs', 'cursor-agent'));
    }
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      prefixes.push(join(userProfile, '.local', 'bin'));
    }
  }
  return prefixes;
}

/** @deprecated Use spawnPathPrefixes() — kept for importers expecting a constant. */
export const SPAWN_PATH_PREFIXES: readonly string[] = spawnPathPrefixes();

export function augmentSpawnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const current = env[pathKey] ?? env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const extras = spawnPathPrefixes().filter((d) => existsSync(d));
  if (extras.length === 0) return env;
  const prefix = extras.join(sep);
  if (current.split(sep).some((p) => extras.includes(p))) return env;
  return { ...env, [pathKey]: `${prefix}${sep}${current}` };
}

export function getEngineSetupGuide(
  engineId: string,
  platform: HubPlatform = detectHubPlatform(),
): EngineSetupGuide {
  if (isBuiltinEngine(engineId)) {
    return withPlatformMeta(buildBuiltinSetupGuide(engineId, platform), platform);
  }
  return withPlatformMeta({ ...CUSTOM_ENGINE_SETUP, engineId, acpCommand: '' }, platform);
}

export function resolveBinaryPath(
  command: string,
  extraPaths: readonly string[] = [],
): string | null {
  if (command.length === 0) return null;

  const candidate = expandHome(command);
  if (candidate.includes('/') || candidate.includes('\\')) {
    return existsSync(candidate) ? candidate : null;
  }

  for (const dir of extraPaths) {
    const full = join(expandHome(dir), command);
    if (process.platform === 'win32') {
      if (existsSync(`${full}.cmd`)) return `${full}.cmd`;
      if (existsSync(`${full}.exe`)) return `${full}.exe`;
    }
    if (existsSync(full)) return full;
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(whichCmd, [command], { encoding: 'utf8' });
  if (result.status === 0) {
    const line = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (line) return line;
  }
  return null;
}

export function checkCustomEngineInstallStatus(command: string): EngineInstallStatus {
  const binaryPath = resolveBinaryPath(command, [...SPAWN_PATH_PREFIXES]);
  if (binaryPath === null) {
    return {
      installed: false,
      binaryPath: null,
      version: null,
      checkError: `未找到 ${command} 命令`,
    };
  }
  return {
    installed: true,
    binaryPath,
    version: probeVersion(binaryPath, command),
    checkError: null,
  };
}

/**
 * Whether an engine can be selected for new instances: not disabled and CLI/runtime present.
 */
export function resolveEngineAvailability(
  engineId: string,
  opts: { disabled?: boolean; customCommand?: string; cursorApiKey?: string } = {},
): EngineAvailability {
  const status = opts.customCommand !== undefined
    ? checkCustomEngineInstallStatus(opts.customCommand)
    : checkEngineInstallStatus(engineId);

  if (opts.disabled === true) {
    return {
      ...status,
      available: false,
      unavailableReason: '引擎已禁用',
    };
  }
  if (!status.installed) {
    return {
      ...status,
      available: false,
      unavailableReason: status.checkError ?? '运行环境未就绪',
    };
  }
  if (engineId === 'cursor') {
    const authBlock = resolveCursorAuthAvailability(status, opts.cursorApiKey);
    if (authBlock !== null) return authBlock;
  }
  return {
    ...status,
    available: true,
    unavailableReason: null,
  };
}

export function enrichEngineInfo(
  info: EngineInfo,
  customEngines: readonly CustomEngineDefinition[],
  disabled: boolean,
  opts: { cursorApiKey?: string } = {},
): EngineInfo {
  const custom = findCustomEngine(customEngines, info.id);
  const avail = resolveEngineAvailability(info.id, {
    disabled,
    customCommand: custom?.command,
    cursorApiKey: info.id === 'cursor' ? opts.cursorApiKey : undefined,
  });
  return {
    ...info,
    available: avail.available,
    unavailableReason: avail.unavailableReason,
  };
}

export function checkEngineInstallStatus(
  engineId: string,
  platform: HubPlatform = detectHubPlatform(),
): EngineInstallStatus {
  if (engineId === 'cursor') {
    return checkCursorInstallStatus();
  }

  const guide = getEngineSetupGuide(engineId, platform);
  if (guide.checkBinary.length === 0) {
    return { installed: false, binaryPath: null, version: null, checkError: null };
  }

  const binaryPath = resolveBinaryPath(guide.checkBinary, [
    ...SPAWN_PATH_PREFIXES,
    ...(guide.checkPaths ?? []),
  ]);

  if (binaryPath === null) {
    return {
      installed: false,
      binaryPath: null,
      version: null,
      checkError: `未找到 ${guide.checkBinary} 命令`,
    };
  }

  const version = probeVersion(binaryPath, guide.checkBinary);
  return {
    installed: true,
    binaryPath,
    version,
    checkError: null,
  };
}

export function runEngineInstall(
  engineId: string,
  platform: HubPlatform = detectHubPlatform(),
): EngineInstallResult {
  const guide = getEngineSetupGuide(engineId, platform);
  if (!guide.installable || guide.installCommand === undefined) {
    throw new Error(`引擎 "${engineId}" 不支持一键安装，请按文档手动配置。`);
  }

  let stdout = '';
  let stderr = '';
  let ok = false;

  try {
    const result = spawnSync(guide.installCommand, {
      shell: true,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      env: augmentSpawnPath(process.env),
    });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
    ok = result.status === 0;
    if (!ok && result.error) {
      stderr = `${stderr}\n${result.error.message}`.trim();
    }
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
  }

  const status = checkEngineInstallStatus(engineId, platform);
  let combinedStderr = stderr;
  if (engineId === 'cursor' && !status.installed) {
    const hint = detectLocalDirPermissionIssue();
    if (hint) combinedStderr = [combinedStderr, hint].filter(Boolean).join('\n');
  }
  return {
    ok: ok && status.installed,
    stdout,
    stderr: combinedStderr,
    status,
  };
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function probeVersion(binaryPath: string, binaryName: string): string | null {
  for (const args of [['--version'], ['version'], ['-V']]) {
    try {
      const out = execFileSync(binaryPath, args, {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (out.length > 0) return out.split(/\r?\n/)[0] ?? out;
    } catch {
      // try next flag
    }
  }

  if (binaryName === 'npx') {
    try {
      const node = resolveBinaryPath('node', SPAWN_PATH_PREFIXES);
      if (node) {
        return execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
      }
    } catch {
      // ignore
    }
  }
  return null;
}
