/**
 * Map ACP session config options ↔ Shepaw model picker API.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { ModelInfo, ModelsListResult, ModelsSetCurrentResult } from 'shepaw-acp-sdk';

export function flattenSelectOptions(
  options: acp.SessionConfigSelectOptions,
): acp.SessionConfigSelectOption[] {
  const out: acp.SessionConfigSelectOption[] = [];
  for (const item of options) {
    if ('group' in item && Array.isArray(item.options)) {
      out.push(...item.options);
    } else if ('value' in item && 'name' in item) {
      out.push(item);
    }
  }
  return out;
}

export function findModelConfigOption(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
): (acp.SessionConfigOption & { type: 'select' }) | undefined {
  if (configOptions === undefined || configOptions === null) return undefined;
  for (const opt of configOptions) {
    if (opt.type !== 'select') continue;
    if (opt.category === 'model' || /model/i.test(opt.id) || /model/i.test(opt.name)) {
      return opt;
    }
  }
  // Fallback: first select option if no category match.
  return configOptions.find((o): o is acp.SessionConfigOption & { type: 'select' } => o.type === 'select');
}

export function configOptionsToModelsList(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
): ModelsListResult {
  const modelOpt = findModelConfigOption(configOptions);
  if (modelOpt === undefined) {
    return { models: [], current: undefined };
  }

  const models: ModelInfo[] = flattenSelectOptions(modelOpt.options).map((o) => ({
    value: o.value,
    display_name: o.name,
    description: o.description ?? '',
  }));

  const current = modelOpt.currentValue;
  return {
    models,
    current: models.some((m) => m.value === current) ? current : undefined,
  };
}

export function displayNameForModel(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
  modelValue: string,
): string | undefined {
  const modelOpt = findModelConfigOption(configOptions);
  if (modelOpt === undefined) return undefined;
  const match = flattenSelectOptions(modelOpt.options).find((o) => o.value === modelValue);
  return match?.name;
}

export function mergeConfigOptions(
  prior: ReadonlyArray<acp.SessionConfigOption> | undefined,
  next: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
): acp.SessionConfigOption[] {
  if (next === undefined || next === null || next.length === 0) {
    return prior !== undefined ? [...prior] : [];
  }
  const map = new Map<string, acp.SessionConfigOption>();
  if (prior !== undefined) {
    for (const o of prior) map.set(o.id, o);
  }
  for (const o of next) map.set(o.id, o);
  return [...map.values()];
}

export function buildSetModelResult(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | undefined | null,
  modelValue: string,
): ModelsSetCurrentResult {
  return {
    model: modelValue,
    display_name: displayNameForModel(configOptions, modelValue),
  };
}
