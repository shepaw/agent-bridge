export type SettingsTab = 'global' | 'engines' | 'peer';

export interface SettingsRoute {
  active: boolean;
  tab: SettingsTab;
  focusEngineId: string | null;
}

export function parseSettingsHash(hash: string): SettingsRoute {
  if (!hash.startsWith('#settings')) {
    return { active: false, tab: 'global', focusEngineId: null };
  }
  if (hash === '#settings') {
    return { active: true, tab: 'global', focusEngineId: null };
  }
  const parts = hash.slice('#settings'.length).replace(/^\//, '').split('/').filter(Boolean);
  const tabRaw = parts[0];
  const tab: SettingsTab = tabRaw === 'engines' || tabRaw === 'peer' ? tabRaw : 'global';
  const focusEngineId = tab === 'engines' && parts[1]
    ? decodeURIComponent(parts[1])
    : null;
  return { active: true, tab, focusEngineId };
}

export function buildSettingsHash(tab: SettingsTab, focusEngineId?: string): string {
  if (tab === 'global' && !focusEngineId) return '#settings';
  if (tab === 'engines' && focusEngineId) {
    return `#settings/engines/${encodeURIComponent(focusEngineId)}`;
  }
  return `#settings/${tab}`;
}
