/** Settings tabs (engine management moved to `#engine/<id>`; legacy links are handled by App). */
export type SettingsTab = 'global' | 'peer';

export interface SettingsRoute {
  active: boolean;
  tab: SettingsTab;
}

/**
 * Parse `#settings`, `#settings/peer`, `#settings/global`. Anything else under
 * `#settings` (e.g. legacy `#settings/engines`) maps to 'global'; App intercepts
 * the legacy engine routes before this is consulted.
 */
export function parseSettingsHash(hash: string): SettingsRoute {
  if (!hash.startsWith('#settings')) {
    return { active: false, tab: 'global' };
  }
  const parts = hash.slice('#settings'.length).replace(/^\//, '').split('/').filter(Boolean);
  const tabRaw = parts[0];
  return { active: true, tab: tabRaw === 'peer' ? 'peer' : 'global' };
}

export function buildSettingsHash(tab: SettingsTab): string {
  if (tab === 'global') return '#settings';
  return '#settings/peer';
}
