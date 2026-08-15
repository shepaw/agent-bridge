/**
 * zcode-acp-server takes the first enabled provider in ~/.zcode/v2/config.json.
 * The desktop often enables `builtin:bigmodel` with an empty apiKey (OAuth) and
 * keeps the real token on a plan provider. Headless app-server then fails with
 * `provider_not_configured`.
 *
 * Coding Plan / start-plan (`zcode-plan` URLs) also need an Aliyun captcha
 * header that only the Electron app can mint. Hub therefore prefers a
 * non-plan provider that already has an API key (often the disabled
 * `builtin:bigmodel-coding-plan` entry).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ZcodeProviderConfig {
  readonly enabled?: boolean;
  readonly kind?: string;
  readonly options?: { readonly apiKey?: string; readonly baseURL?: string };
  readonly models?: Record<string, ZcodeModelConfig | undefined>;
}

export interface ZcodeModelConfig {
  readonly reasoning?: {
    readonly enabled?: boolean;
    readonly variants?: readonly string[];
    readonly defaultVariant?: string;
  };
}

export interface ZcodeV2Config {
  readonly provider?: Record<string, ZcodeProviderConfig | undefined>;
}

export interface ZcodeV2Settings {
  readonly providerFamilyDomain?: string;
  readonly modelProviderFamilySelectedKeys?: Record<string, string>;
}

export interface ZcodeDesktopCredentials {
  readonly providerId: string;
  readonly kind: 'anthropic' | 'openai' | 'openai-compatible';
  readonly modelId: string;
  readonly modelVariant?: string;
  readonly models: readonly string[];
  readonly modelCatalog: readonly ZcodeRuntimeModelEntry[];
  readonly planEndpoint: boolean;
  readonly ZCODE_MODEL: string;
  readonly ZCODE_BASE_URL: string;
  readonly ANTHROPIC_API_KEY: string;
}

export interface ZcodeRuntimeModelEntry {
  readonly modelId: string;
  readonly reasoning?: {
    readonly enabled: boolean;
    readonly defaultLevel?: string;
    readonly levels: readonly { readonly value: string; readonly label: string }[];
  };
}

export function providerIdFromSelectedKey(raw: string): string {
  const trimmed = raw.trim();
  const builtin = trimmed.indexOf('builtin:');
  if (builtin >= 0) return trimmed.slice(builtin);
  return trimmed;
}

export function isZcodePlanProvider(id: string, baseURL: string): boolean {
  return /start-plan/i.test(id) || /zcode-plan/i.test(baseURL);
}

function apiKeyOf(provider: ZcodeProviderConfig): string {
  return (provider.options?.apiKey ?? '').trim();
}

function firstModelId(provider: ZcodeProviderConfig): string {
  const ids = Object.keys(provider.models ?? {});
  return ids[0] ?? 'GLM-5.2';
}

/** Always-thinking models (GLM-5.3) need an explicit low/high/max variant. */
function pickHeadlessModel(provider: ZcodeProviderConfig): { modelId: string; variant?: string } {
  const models = provider.models ?? {};
  const ids = Object.keys(models);
  const modelId = ids[0] ?? firstModelId(provider);
  const variant = headlessThoughtVariant(models[modelId]);
  return variant !== undefined ? { modelId, variant } : { modelId };
}

function catalogEntry(modelId: string, model: ZcodeModelConfig | undefined): ZcodeRuntimeModelEntry {
  const reasoning = model?.reasoning;
  const variants = reasoning?.variants ?? [];
  if (reasoning?.enabled === true && variants.length > 0) {
    const defaultLevel = variants.includes('low')
      ? 'low'
      : (reasoning.defaultVariant ?? variants[0]);
    return {
      modelId,
      reasoning: {
        enabled: true,
        defaultLevel,
        levels: variants.map((value) => ({ value, label: value })),
      },
    };
  }
  return { modelId };
}

function headlessThoughtVariant(model: ZcodeModelConfig | undefined): string | undefined {
  const reasoning = model?.reasoning;
  if (reasoning?.enabled !== true) return undefined;
  const variants = reasoning.variants ?? [];
  if (variants.includes('low')) return 'low';
  if (variants.includes('enabled')) return 'enabled';
  const fallback = reasoning.defaultVariant?.trim();
  if (fallback !== undefined && fallback.length > 0 && fallback !== 'off') return fallback;
  return undefined;
}

function providerKind(provider: ZcodeProviderConfig): ZcodeDesktopCredentials['kind'] {
  if (provider.kind === 'openai' || provider.kind === 'openai-compatible') {
    return provider.kind;
  }
  return 'anthropic';
}

function fromProvider(
  cfg: ZcodeV2Config,
  id: string,
  provider: ZcodeProviderConfig,
): ZcodeDesktopCredentials | null {
  const apiKey = apiKeyOf(provider);
  if (apiKey.length === 0) return null;
  const keyUrl = (provider.options?.baseURL ?? '').trim();
  const familyId = id.replace(/-(coding-plan|start-plan)$/, '');
  const family = cfg.provider?.[familyId];
  const useFamily =
    !isZcodePlanProvider(id, keyUrl) &&
    familyId !== id &&
    family?.enabled === true;
  const runtimeId = useFamily ? familyId : id;
  const runtime = useFamily && family !== undefined ? family : provider;
  const pickedModel = pickHeadlessModel(runtime);
  const modelId = pickedModel.modelId;
  const baseURL = (runtime.options?.baseURL ?? keyUrl).trim();
  const models = Object.keys(runtime.models ?? {});
  const catalog =
    models.length > 0
      ? models.map((id) => catalogEntry(id, runtime.models?.[id]))
      : [catalogEntry(modelId, runtime.models?.[modelId])];
  return {
    providerId: runtimeId,
    kind: providerKind(runtime),
    modelId,
    ...(pickedModel.variant !== undefined ? { modelVariant: pickedModel.variant } : {}),
    models: models.length > 0 ? models : [modelId],
    modelCatalog: catalog,
    planEndpoint: isZcodePlanProvider(runtimeId, baseURL),
    ZCODE_MODEL: `${runtimeId}/${modelId}`,
    ZCODE_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: apiKey,
  };
}

function selectedProviderId(cfg: ZcodeV2Config, settings?: ZcodeV2Settings): string | undefined {
  const domain = settings?.providerFamilyDomain?.trim();
  if (domain === undefined || domain.length === 0) return undefined;
  const selectedRaw = settings?.modelProviderFamilySelectedKeys?.[domain];
  if (typeof selectedRaw !== 'string' || selectedRaw.trim().length === 0) return undefined;
  return providerIdFromSelectedKey(selectedRaw);
}

function* keyedProviders(
  cfg: ZcodeV2Config,
  settings?: ZcodeV2Settings,
): Generator<readonly [string, ZcodeProviderConfig]> {
  const providers = cfg.provider ?? {};
  const selectedId = selectedProviderId(cfg, settings);
  if (selectedId !== undefined) {
    const selected = providers[selectedId];
    if (selected !== undefined) yield [selectedId, selected];
  }
  for (const [id, provider] of Object.entries(providers)) {
    if (id !== selectedId && provider?.enabled === true) yield [id, provider];
  }
  for (const [id, provider] of Object.entries(providers)) {
    if (id !== selectedId && provider !== undefined && provider.enabled !== true) {
      yield [id, provider];
    }
  }
}

export function pickZcodeDesktopCredentials(
  cfg: ZcodeV2Config,
  settings?: ZcodeV2Settings,
): ZcodeDesktopCredentials | null {
  let planFallback: ZcodeDesktopCredentials | null = null;
  for (const [id, provider] of keyedProviders(cfg, settings)) {
    const picked = fromProvider(cfg, id, provider);
    if (picked === null) continue;
    if (!picked.planEndpoint) return picked;
    planFallback ??= picked;
  }
  return planFallback;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function loadZcodeDesktopCredentials(
  home: string = homedir(),
): ZcodeDesktopCredentials | null {
  const cfg = readJsonFile(join(home, '.zcode', 'v2', 'config.json'));
  if (cfg === undefined || typeof cfg !== 'object' || cfg === null) return null;
  const settingsRaw = readJsonFile(join(home, '.zcode', 'v2', 'setting.json'));
  const settings =
    settingsRaw !== undefined && typeof settingsRaw === 'object' && settingsRaw !== null
      ? (settingsRaw as ZcodeV2Settings)
      : undefined;
  return pickZcodeDesktopCredentials(cfg as ZcodeV2Config, settings);
}

/**
 * Fill ANTHROPIC_API_KEY from desktop config when the operator did not set one.
 *
 * Do not copy the provider `baseURL` onto `ZCODE_BASE_URL`: zcode.cjs treats
 * that env as the product origin, not the Anthropic-compatible API endpoint.
 */
export function overlayZcodeDesktopCredentials(
  env: NodeJS.ProcessEnv,
  creds: ZcodeDesktopCredentials | null = loadZcodeDesktopCredentials(),
): NodeJS.ProcessEnv {
  if (creds === null) return env;
  if ((env.ANTHROPIC_API_KEY ?? '').trim().length > 0) return env;
  return {
    ...env,
    ANTHROPIC_API_KEY: creds.ANTHROPIC_API_KEY,
    ZCODE_API_KEY: creds.ANTHROPIC_API_KEY,
  };
}
