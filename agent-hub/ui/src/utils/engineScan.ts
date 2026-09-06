import type { EngineInfo } from '../api/types.js';

/**
 * Pure summary of the server-side engine availability probe
 * (GET /api/engines runs enrichEngineInfo → per-engine local detection).
 *
 * Categorisation mirrors AddInstanceModal's selection rule:
 *   - ready     = `available !== false` (available or unknown — never probe-blocked)
 *   - needSetup = `available === false && !disabled` (missing binary / missing key)
 *   - disabled  = operator disabled via `disabled === true` (folded out of needSetup)
 */
export interface EngineScanSummary {
  total: number;
  ready: number;
  needSetup: EngineInfo[];
  disabled: EngineInfo[];
}

export function summarizeEngines(engines: EngineInfo[]): EngineScanSummary {
  const disabled = engines.filter((e) => e.disabled === true);
  const needSetup = engines.filter((e) => e.available === false && e.disabled !== true);
  const ready = engines.filter((e) => e.available !== false).length;
  return { total: engines.length, ready, needSetup, disabled };
}
