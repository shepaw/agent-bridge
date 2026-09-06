import type { EngineInfo, Instance } from '../api/types.js';
import { matchInstanceLabel } from './instanceFilters.js';
import { matchEngineKeyword } from './enginePicker.js';

/**
 * Grouping of engines + instances for the merged "My Agents" page.
 *
 * Ordering:
 *   1. engines that have instances (most instances first)
 *   2. available engines with no instances
 *   3. engines needing setup with no instances
 *   4. disabled engines with no instances
 * …each group sorted by display name. The catalog is the baseline; instance
 * engine ids that are no longer in the catalog (deleted custom engines) are
 * synthesised as minimal "ghost" entries so their agents stay visible.
 */

export type EngineAvailability = 'ready' | 'needs-setup' | 'disabled';

export interface AgentGroup {
  engine: EngineInfo;
  /** False when the engine is not in the current catalog (deleted custom engine). */
  inCatalog: boolean;
  count: number;
  instances: Instance[];
}

/** Categorise an engine for the UI (disabled wins over unavailable). */
export function engineState(e: EngineInfo): EngineAvailability {
  if (e.disabled === true) return 'disabled';
  if (e.available === false) return 'needs-setup';
  return 'ready';
}

/** Minimal entry for an instance whose engine was deleted from the catalog. */
export function synthesizeEngine(id: string): EngineInfo {
  return { id, displayName: id, acpCommand: '', builtin: false };
}

const STATE_RANK: Record<EngineAvailability, number> = {
  ready: 0,
  'needs-setup': 1,
  disabled: 2,
};

export function buildAgentGroups(engines: EngineInfo[], instances: Instance[]): AgentGroup[] {
  const catalogById = new Map(engines.map((e) => [e.id, e]));
  const allIds = [...new Set([...catalogById.keys(), ...instances.map((i) => i.engine)])];

  const groups: AgentGroup[] = allIds.map((id) => {
    const engine = catalogById.get(id) ?? synthesizeEngine(id);
    const groupInstances = instances.filter((i) => i.engine === id);
    return {
      engine,
      inCatalog: catalogById.has(id),
      count: groupInstances.length,
      instances: groupInstances,
    };
  });

  groups.sort((a, b) => {
    const aHas = a.count > 0;
    const bHas = b.count > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    const nameDiff = a.engine.displayName.localeCompare(b.engine.displayName);
    if (aHas) return b.count - a.count || nameDiff;
    const rankDiff = STATE_RANK[engineState(a.engine)] - STATE_RANK[engineState(b.engine)];
    if (rankDiff !== 0) return rankDiff;
    return nameDiff;
  });

  return groups;
}

/**
 * Keyword filter over groups: a group survives when its engine name/id matches
 * or any of its instance labels match. When only instance labels match, the
 * group is trimmed to the matching instances; an engine match keeps the whole
 * group visible.
 */
export function filterAgentGroups(groups: AgentGroup[], q: string): AgentGroup[] {
  const query = q.trim();
  if (!query) return groups;
  const filtered: AgentGroup[] = [];
  for (const group of groups) {
    const engineMatch = matchEngineKeyword(group.engine, query);
    const instances = group.instances.filter((p) => matchInstanceLabel(p, query));
    if (engineMatch || instances.length > 0) {
      filtered.push({
        ...group,
        count: engineMatch ? group.count : instances.length,
        instances: engineMatch ? group.instances : instances,
      });
    }
  }
  return filtered;
}
