/**
 * Shepaw `agent.models.*` wire encoding for DSH's `{ provider, model }` routes.
 */

/** Separator between provider route and model id in Shepaw model `value` strings. */
export const MODEL_VALUE_SEP = '/';

/** Encode a DSH provider/model pair for `agent.models.list` / `setCurrent`. */
export function encodeModelValue(provider: string, model: string): string {
  return `${provider}${MODEL_VALUE_SEP}${model}`;
}

/** Decode a Shepaw model `value`; returns undefined when malformed. */
export function decodeModelValue(value: string): { provider: string; model: string } | undefined {
  const idx = value.indexOf(MODEL_VALUE_SEP);
  if (idx <= 0 || idx >= value.length - 1) return undefined;
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}

/** Human label for a model row (provider name when it adds context). */
export function displayNameForModel(
  providerId: string,
  modelName: string,
  providerName?: string,
): string {
  if (providerName !== undefined && providerName.length > 0 && providerName !== providerId) {
    return `${providerName} · ${modelName}`;
  }
  return modelName;
}

export interface CatalogModelRow {
  value: string;
  display_name: string;
}

/** Resolve a requested wire value against a flattened catalog (exact match first). */
export function resolveCatalogModelValue(
  requested: string,
  catalog: readonly CatalogModelRow[],
): string | undefined {
  if (catalog.some((row) => row.value === requested)) return requested;

  const decoded = decodeModelValue(requested);
  if (decoded !== undefined) {
    const suffix = `${MODEL_VALUE_SEP}${decoded.model}`;
    const byModelId = catalog.filter((row) => row.value.endsWith(suffix));
    if (byModelId.length === 1) return byModelId[0]!.value;
    return undefined;
  }

  const bareSuffix = `${MODEL_VALUE_SEP}${requested}`;
  const byBareModelId = catalog.filter((row) => row.value.endsWith(bareSuffix));
  if (byBareModelId.length === 1) return byBareModelId[0]!.value;
  return undefined;
}
