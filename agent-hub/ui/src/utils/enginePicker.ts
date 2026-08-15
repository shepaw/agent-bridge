import type { EngineInfo } from '../api/types.js';

/** Available engines first; original relative order preserved within each group. */
export function sortEnginesUnavailableLast(engines: readonly EngineInfo[]): EngineInfo[] {
  const available: EngineInfo[] = [];
  const unavailable: EngineInfo[] = [];
  for (const engine of engines) {
    if (engine.available === false) unavailable.push(engine);
    else available.push(engine);
  }
  return [...available, ...unavailable];
}

function subsequenceMatch(haystack: string, query: string): boolean {
  let i = 0;
  for (const ch of query) {
    i = haystack.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

/** Case-insensitive substring or subsequence match on id / display name / description. */
export function matchEngineKeyword(engine: EngineInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [engine.id, engine.displayName, engine.description ?? ''];
  for (const field of fields) {
    const hay = field.toLowerCase();
    if (hay.includes(q) || subsequenceMatch(hay, q)) return true;
  }
  return false;
}

export function filterAndSortEngines(
  engines: readonly EngineInfo[],
  query: string,
): EngineInfo[] {
  return sortEnginesUnavailableLast(engines).filter((engine) => matchEngineKeyword(engine, query));
}
