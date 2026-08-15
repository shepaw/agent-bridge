/**
 * Per-engine native ACP modes exposed in the Hub/App picker.
 *
 * Most engines expose permission / run modes (how often tools need approval).
 * Cursor is run mode only (`approvalMode`: auto-review / allowlist /
 * unrestricted) — not session mode (agent/plan/ask). We persist the operator's
 * choice on the instance and ask the proxy to apply it via CLI flags at spawn
 * and/or `session/set_config_option` when the agent advertises one.
 *
 * Catalogs are create/edit pickers and the App fallback when ACP has not
 * advertised modes yet (no live session). Unknown engines leave the picker
 * empty so we don't invent modes for them.
 */

export interface EngineSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface EngineSessionModeCatalog {
  readonly modes: ReadonlyArray<EngineSessionMode>;
  /** Applied when the operator does not pick a mode at create time. */
  readonly defaultModeId: string | undefined;
}

export interface ParseSessionModeOptions {
  /**
   * When true, unknown ids are forwarded as-is even if the engine has a
   * catalog. Used when persisting a mode the live agent already advertised.
   */
  readonly allowUnknown?: boolean;
}

/**
 * Cursor CLI run modes (`approvalMode` in cli-config; `--auto-review` / `--force`).
 * @see https://cursor.com/docs/agent/security/run-modes
 */
const CURSOR_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'auto-review',
  modes: [
    { id: 'auto-review', name: 'Auto-review', description: '白名单与沙箱自动执行，其余经分类器审核' },
    { id: 'allowlist', name: 'Allowlist', description: '仅白名单内自动执行，其余询问' },
    { id: 'unrestricted', name: 'Run Everything', description: '跳过几乎所有确认（`--force`）' },
  ],
};

/** Pre-run-mode catalog ids stored on older instances — mapped on read. */
const CURSOR_LEGACY_SESSION_MODE_IDS: Readonly<Record<string, string>> = {
  agent: 'auto-review',
  plan: 'allowlist',
  ask: 'allowlist',
};

/** Claude Code permission modes. */
const CLAUDE_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'acceptEdits',
  modes: [
    { id: 'default', name: 'Default', description: '读取自动放行，写入和命令需确认' },
    { id: 'acceptEdits', name: 'Accept Edits', description: '自动接受文件编辑，命令仍需确认' },
    { id: 'plan', name: 'Plan', description: '只规划，不改代码' },
    { id: 'auto', name: 'Auto', description: '后台安全检查后自动执行' },
    { id: 'dontAsk', name: "Don't Ask", description: '只运行预先批准的工具，其余拒绝' },
    { id: 'bypassPermissions', name: 'Bypass Permissions', description: '跳过几乎所有确认（仅隔离环境）' },
  ],
};

/** Codex `approval_policy` values (kebab-case). */
const CODEX_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'on-request',
  modes: [
    { id: 'untrusted', name: 'Untrusted', description: '仅放行受信任命令，其余询问' },
    { id: 'on-request', name: 'On request', description: '运行命令前询问' },
    { id: 'on-failure', name: 'On failure', description: '失败时再询问，成功则自动继续' },
    { id: 'never', name: 'Never', description: '不再询问审批' },
  ],
};

/** OpenCode primary agents advertised over ACP as session modes. */
const OPENCODE_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'build',
  modes: [
    { id: 'build', name: 'Build', description: '完整开发工具' },
    { id: 'plan', name: 'Plan', description: '只规划，不改代码' },
  ],
};

/**
 * ZCode execution modes advertised by zcode-acp-server (`plan`/`build`/`edit`/`yolo`).
 * @see https://zcode.z.ai/en/docs/agents
 */
const ZCODE_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'build',
  modes: [
    { id: 'plan', name: 'Plan', description: '先规划，确认后再改代码' },
    { id: 'build', name: 'Build', description: '改文件和命令前询问' },
    { id: 'edit', name: 'Edit', description: '自动接受文件编辑，命令仍需确认' },
    { id: 'yolo', name: 'YOLO', description: '减少确认，持续自动执行' },
  ],
};

/**
 * DeepSeek Harness sandbox / permission presets (`DSH_PERMISSION_MODE`).
 * ACP itself does not advertise modes; Hub injects the env at spawn.
 */
const DEEPSEEK_HARNESS_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'workspace-write',
  modes: [
    { id: 'read-only', name: 'Read only', description: '禁止写入工作区文件' },
    { id: 'workspace-write', name: 'Workspace write', description: '写入限于工作区与临时目录，其余询问' },
    { id: 'danger-full-access', name: 'Full access', description: '跳过沙箱与审批（仅隔离环境）' },
  ],
};

/**
 * Qwen Code approval modes advertised over ACP (`session/set_mode`).
 * @see https://qwenlm.github.io/qwen-code-docs/en/users/features/approval-mode/
 */
const QWEN_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'auto',
  modes: [
    { id: 'plan', name: 'Plan', description: '只分析规划，不改文件、不跑命令' },
    { id: 'default', name: 'Ask Permissions', description: '文件编辑和命令均需确认' },
    { id: 'auto-edit', name: 'Auto-edit', description: '自动接受文件编辑，命令仍需确认' },
    { id: 'auto', name: 'Auto', description: '分类器自动放行安全操作，高风险仍拦截' },
    { id: 'yolo', name: 'YOLO', description: '跳过几乎所有确认（仅隔离环境）' },
  ],
};

const EMPTY_CATALOG: EngineSessionModeCatalog = {
  defaultModeId: undefined,
  modes: [],
};

const BY_ENGINE: Record<string, EngineSessionModeCatalog> = {
  cursor: CURSOR_MODES,
  'claude-code': CLAUDE_MODES,
  codex: CODEX_MODES,
  opencode: OPENCODE_MODES,
  openclaw: EMPTY_CATALOG,
  hermes: EMPTY_CATALOG,
  kimi: EMPTY_CATALOG,
  codebuddy: EMPTY_CATALOG,
  zcode: ZCODE_MODES,
  'deepseek-harness': DEEPSEEK_HARNESS_MODES,
  'qwen-code': QWEN_MODES,
};

export function getEngineSessionCatalog(engineId: string): EngineSessionModeCatalog {
  return BY_ENGINE[engineId] ?? EMPTY_CATALOG;
}

export function defaultSessionModeId(engineId: string): string | undefined {
  return getEngineSessionCatalog(engineId).defaultModeId;
}

/** Wire payload for App `agent_modes_resp` when ACP has not advertised modes yet. */
export function catalogModesWire(
  engineId: string,
  current?: string,
): {
  modes: Array<{ value: string; display_name: string; description: string }>;
  current?: string;
} {
  const catalog = getEngineSessionCatalog(engineId);
  const modes = catalog.modes.map((m) => ({
    value: m.id,
    display_name: m.name,
    description: m.description,
  }));
  const resolved =
    current !== undefined && current.length > 0 && modes.some((m) => m.value === current)
      ? current
      : catalog.defaultModeId;
  return {
    modes,
    ...(resolved !== undefined ? { current: resolved } : {}),
  };
}

export function isKnownSessionMode(engineId: string, modeId: string): boolean {
  const catalog = getEngineSessionCatalog(engineId);
  if (catalog.modes.length === 0) return false;
  return catalog.modes.some((m) => m.id === modeId);
}

/**
 * Validate an operator-supplied mode. Empty / omitted is allowed (caller may
 * fill in the engine default). Unknown ids are rejected for engines that
 * publish a catalog unless {@link ParseSessionModeOptions.allowUnknown} is set
 * (live agent advertised the id). Engines without a catalog accept any
 * non-empty id so it can be forwarded to ACP as-is.
 */
export function parseSessionMode(
  engineId: string,
  raw: unknown,
  opts?: ParseSessionModeOptions,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error('sessionMode must be a string.');
  }
  let id = raw.trim();
  if (id.length === 0) return undefined;
  if (engineId === 'cursor') {
    id = CURSOR_LEGACY_SESSION_MODE_IDS[id] ?? id;
  }
  const catalog = getEngineSessionCatalog(engineId);
  if (
    catalog.modes.length > 0 &&
    !catalog.modes.some((m) => m.id === id) &&
    opts?.allowUnknown !== true
  ) {
    throw new Error(
      `Unknown session mode "${id}" for engine "${engineId}". ` +
        `Available: ${catalog.modes.map((m) => m.id).join(', ')}.`,
    );
  }
  return id;
}
