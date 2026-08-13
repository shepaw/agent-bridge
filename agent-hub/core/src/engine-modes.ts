/**
 * Per-engine native session / permission modes.
 *
 * Hub does not invent its own allow/ask/deny policy. Each ACP agent already
 * has modes that control how often it prompts; we just persist the operator's
 * choice on the instance and ask the proxy to set it via ACP
 * `session/set_mode` / `session/set_config_option`.
 *
 * Catalogs are create/edit pickers. The live App list comes from whatever the
 * agent advertised — unknown engines and engines without a catalog leave the
 * picker empty so we don't pretend they share Cursor's modes.
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

/** Cursor ACP: agent / plan / ask (https://cursor.com/docs/cli/acp). */
const CURSOR_MODES: EngineSessionModeCatalog = {
  defaultModeId: 'agent',
  modes: [
    { id: 'agent', name: 'Agent', description: '完整工具权限，必要时询问' },
    { id: 'plan', name: 'Plan', description: '只规划，不改代码' },
    { id: 'ask', name: 'Ask', description: '只问答，只读' },
  ],
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
};

export function getEngineSessionCatalog(engineId: string): EngineSessionModeCatalog {
  return BY_ENGINE[engineId] ?? EMPTY_CATALOG;
}

export function defaultSessionModeId(engineId: string): string | undefined {
  return getEngineSessionCatalog(engineId).defaultModeId;
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
  const id = raw.trim();
  if (id.length === 0) return undefined;
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
