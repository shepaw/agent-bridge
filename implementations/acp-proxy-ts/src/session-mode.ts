/**
 * Apply the operator-chosen ACP mode from `PAW_ACP_SESSION_MODE`.
 *
 * Hub catalogs per-engine ids (Cursor run mode `auto-review`/`allowlist`/
 * `unrestricted`, Claude `acceptEdits`, Codex `on-request`, OpenCode `build`,
 * …). Proxy matches that id against whatever the agent advertised after
 * `session/new|resume|load`:
 *   - `configOptions` with `approvalMode` / `approvalPolicy` / `permissionMode`
 *     + `session/set_config_option`
 *   - legacy `modes.availableModes` + `session/set_mode` (non-Cursor engines)
 *
 * Cursor run mode is also applied at spawn via `--auto-review` / `--force`.
 * Unset / empty → leave the agent's default.
 */

import type * as acp from '@agentclientprotocol/sdk';

import { flattenSelectOptions } from './config-options.js';

export type SessionModePlan =
  | { readonly kind: 'config-select'; readonly configId: string; readonly value: string }
  | { readonly kind: 'set-mode'; readonly modeId: string };

/**
 * Hub catalog id → ids/names an upstream agent might advertise.
 * Keys are {@link normalize}d.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  autoreview: ['autoreview', 'auto-review'],
  allowlist: ['allowlist'],
  unrestricted: ['unrestricted', 'runeverything', 'run-everything', 'yolo', 'force'],
  auto: ['auto', 'yolo', 'onfailure'],
  agent: ['agent', 'agentic', 'code', 'build'],
  plan: ['plan', 'architect'],
  ask: ['ask', 'read', 'readonly', 'chat'],
  default: ['default', 'onrequest'],
  acceptedits: ['acceptedits', 'autoedit', 'auto-edit'],
  autoedit: ['autoedit', 'auto-edit', 'acceptedits'],
  dontask: ['dontask'],
  bypasspermissions: ['bypasspermissions'],
  onrequest: ['onrequest', 'default', 'ask'],
  onfailure: ['onfailure', 'auto'],
  never: ['never', 'fullauto'],
  untrusted: ['untrusted'],
  build: ['build', 'agent', 'code'],
  edit: ['edit', 'autoedit'],
  yolo: ['yolo', 'fullaccess'],
  readonly: ['readonly', 'read-only', 'ask'],
  workspacewrite: ['workspacewrite', 'workspace-write'],
  dangerfullaccess: ['dangerfullaccess', 'danger-full-access', 'unrestricted', 'never'],
};

function normalize(raw: string): string {
  return raw.toLowerCase().replace(/[\s_-]/g, '');
}

/** Instance mode injected by Hub. Empty / unset → do not change the session. */
export function requestedSessionMode(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const v = (env.PAW_ACP_SESSION_MODE ?? '').trim();
  return v.length > 0 ? v : undefined;
}

function aliasKeys(requested: string): string[] {
  const key = normalize(requested);
  const extra = [...(ALIASES[key] ?? [])];
  for (const [canonical, vals] of Object.entries(ALIASES)) {
    if (canonical === key || vals.some((v) => normalize(v) === key)) {
      extra.push(canonical, ...vals);
    }
  }
  return [key, ...extra.map(normalize)];
}

function isRunModeConfigOption(opt: acp.SessionConfigOption): boolean {
  if (opt.type !== 'select') return false;
  const hay = `${opt.id} ${opt.name}`;
  return /approvalMode|approvalPolicy|permissionMode|runMode|run.?mode|approval.?polic/i.test(hay);
}

export function findModeConfigOption(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
): (acp.SessionConfigOption & { type: 'select' }) | undefined {
  if (configOptions === undefined || configOptions === null) return undefined;
  for (const opt of configOptions) {
    if (isRunModeConfigOption(opt)) {
      return opt as acp.SessionConfigOption & { type: 'select' };
    }
  }
  for (const opt of configOptions) {
    if (opt.type !== 'select') continue;
    if (opt.category === 'mode') return opt;
  }
  for (const opt of configOptions) {
    if (opt.type !== 'select') continue;
    if (opt.category === 'model' || opt.category === 'model_config') continue;
    const hay = `${opt.id} ${opt.name}`;
    if (
      /permission.?mode/i.test(hay) ||
      /^mode$/i.test(opt.id) ||
      /session.?mode/i.test(hay) ||
      /approval.?polic/i.test(hay) ||
      /^approvalPolicy$/i.test(opt.id)
    ) {
      return opt;
    }
  }
  return undefined;
}

/** Extra `agent acp` argv for a Cursor run mode (Hub `PAW_ACP_SESSION_MODE`). */
export function cursorRunModeSpawnArgs(
  mode: string | undefined,
  existingArgs: readonly string[],
): string[] {
  if (mode === undefined) return [...existingArgs];
  const key = normalize(mode);
  const args = [...existingArgs];
  const has = (flag: string): boolean => args.includes(flag);
  if (key === 'autoreview') {
    if (!has('--auto-review')) args.unshift('--auto-review');
  } else if (key === 'unrestricted' || key === 'yolo' || key === 'force') {
    if (!has('--force') && !has('--yolo')) args.unshift('--force');
  }
  return args;
}

const QWEN_APPROVAL_MODE_BY_KEY: Readonly<Record<string, string>> = {
  plan: 'plan',
  default: 'default',
  autoedit: 'auto-edit',
  acceptedits: 'auto-edit',
  auto: 'auto',
  yolo: 'yolo',
  unrestricted: 'yolo',
  bypasspermissions: 'yolo',
};

/** Extra `qwen --acp` argv for a Qwen Code approval mode (Hub `PAW_ACP_SESSION_MODE`). */
export function qwenApprovalModeSpawnArgs(
  mode: string | undefined,
  existingArgs: readonly string[],
): string[] {
  if (mode === undefined) return [...existingArgs];
  const args = [...existingArgs];
  if (args.includes('--approval-mode')) return args;
  const mapped = QWEN_APPROVAL_MODE_BY_KEY[normalize(mode)];
  if (mapped === undefined) return args;
  args.push('--approval-mode', mapped);
  return args;
}

export interface ListedSessionMode {
  readonly value: string;
  readonly display_name: string;
  readonly description: string;
}

function pickListedCurrent(
  modes: ReadonlyArray<ListedSessionMode>,
  advertised: string | undefined,
  override: string | undefined,
): string | undefined {
  if (override !== undefined && modes.some((m) => m.value === override)) return override;
  if (advertised !== undefined && modes.some((m) => m.value === advertised)) return advertised;
  return undefined;
}

/** Flatten advertised configOptions / legacy modes into the Shepaw picker list. */
export function advertisedModesList(input: {
  readonly configOptions?: ReadonlyArray<acp.SessionConfigOption> | null;
  readonly modes?: acp.SessionModeState | null;
  readonly currentOverride?: string;
}): { modes: ListedSessionMode[]; current?: string } {
  const modeOpt = findModeConfigOption(input.configOptions);
  if (modeOpt !== undefined) {
    const modes = flattenSelectOptions(modeOpt.options).map((o) => ({
      value: o.value,
      display_name: o.name,
      description: o.description ?? '',
    }));
    return {
      modes,
      current: pickListedCurrent(modes, modeOpt.currentValue, input.currentOverride),
    };
  }

  if (input.modes !== undefined && input.modes !== null) {
    const modes = input.modes.availableModes.map((m) => ({
      value: m.id,
      display_name: m.name ?? m.id,
      description: m.description ?? '',
    }));
    return {
      modes,
      current: pickListedCurrent(modes, input.modes.currentModeId, input.currentOverride),
    };
  }

  return { modes: [], current: undefined };
}

export function displayNameForMode(
  listed: ReadonlyArray<ListedSessionMode>,
  modeValue: string,
): string | undefined {
  return listed.find((m) => m.value === modeValue)?.display_name;
}

/**
 * Resolve `requested` to an advertised id (exact, then alias). Does not
 * skip when the session is already on that mode.
 */
export function resolveRequestedModeId(
  available: ReadonlyArray<{ readonly id: string; readonly name?: string | null }>,
  requested: string,
): string | undefined {
  if (available.length === 0) return undefined;
  const wanted = normalize(requested);
  const aliases = new Set(aliasKeys(requested));

  let exact: string | undefined;
  let aliasHit: string | undefined;
  for (const mode of available) {
    const idKey = normalize(mode.id);
    const nameKey = normalize(mode.name ?? '');
    if (idKey === wanted || nameKey === wanted) {
      exact = mode.id;
      break;
    }
    if (aliasHit === undefined && (aliases.has(idKey) || aliases.has(nameKey))) {
      aliasHit = mode.id;
    }
  }
  return exact ?? aliasHit;
}

/**
 * Pick the advertised mode that matches `requested`. Returns undefined when
 * nothing matches, or the session is already on that mode.
 */
export function matchRequestedModeId(
  available: ReadonlyArray<{ readonly id: string; readonly name?: string | null }>,
  requested: string,
  currentId: string | undefined,
): string | undefined {
  const picked = resolveRequestedModeId(available, requested);
  if (picked === undefined) return undefined;
  if (currentId !== undefined && normalize(currentId) === normalize(picked)) return undefined;
  return picked;
}

export function planRequestedMode(input: {
  readonly requested: string;
  readonly configOptions?: ReadonlyArray<acp.SessionConfigOption> | null;
  readonly modes?: acp.SessionModeState | null;
}): SessionModePlan | undefined {
  const { requested, configOptions, modes } = input;

  const modeOpt = findModeConfigOption(configOptions);
  if (modeOpt !== undefined) {
    const value = matchRequestedModeId(
      flattenSelectOptions(modeOpt.options).map((o) => ({ id: o.value, name: o.name })),
      requested,
      modeOpt.currentValue,
    );
    if (value !== undefined) {
      return { kind: 'config-select', configId: modeOpt.id, value };
    }
  }

  if (modes !== undefined && modes !== null) {
    const modeId = matchRequestedModeId(modes.availableModes, requested, modes.currentModeId);
    if (modeId !== undefined) {
      return { kind: 'set-mode', modeId };
    }
  }

  return undefined;
}

export function describeSessionModePlan(plan: SessionModePlan): string {
  switch (plan.kind) {
    case 'config-select':
      return `config ${plan.configId}=${plan.value}`;
    case 'set-mode':
      return `mode ${plan.modeId}`;
  }
}
