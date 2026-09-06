/**
 * Hash routes for the per-engine configuration page.
 *   #engine/<encodeURIComponent(id)>
 *
 * Also recognises the legacy engine-management deep links that used to live
 * under Settings (`#settings/engines[/<id>]`) so old bookmarks / tabs still
 * land sensibly: with an id → the engine config page; without → the hub page.
 */

export interface EngineRoute {
  engineId: string;
}

/** Parse `#engine/<id>`. Returns null for any other hash. */
export function parseEngineHash(hash: string): { engineId: string } | null {
  const m = hash.match(/^#engine\/([^/]+)$/);
  if (!m) return null;
  try {
    return { engineId: decodeURIComponent(m[1]!) };
  } catch {
    return null;
  }
}

/** Build a `#engine/<id>`-style route fragment (no leading #, like the other builders). */
export function buildEngineHash(id: string): string {
  return `engine/${encodeURIComponent(id)}`;
}

/** Recognise legacy `#settings/engines[/<id>]` deep links for compatible redirects. */
export function parseLegacyEngineSettingsHash(hash: string): {
  active: boolean;
  engineId: string | null;
} {
  if (!hash.startsWith('#settings/engines')) return { active: false, engineId: null };
  if (hash === '#settings/engines' || hash === '#settings/engines/') {
    return { active: true, engineId: null };
  }
  const rest = hash.slice('#settings/engines'.length).replace(/^\//, '');
  if (!rest) return { active: true, engineId: null };
  try {
    return { active: true, engineId: decodeURIComponent(rest) };
  } catch {
    return { active: true, engineId: null };
  }
}
