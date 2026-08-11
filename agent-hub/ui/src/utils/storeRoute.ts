/**
 * Hash routes for the store (储物袋) browser.
 *   #store
 *   #store/<encodeURIComponent(store://…)>
 */

export interface StoreRoute {
  active: boolean;
  uri: string | null;
}

export function parseStoreHash(hash: string): StoreRoute {
  if (!hash.startsWith('#store')) {
    return { active: false, uri: null };
  }
  if (hash === '#store' || hash === '#store/') {
    return { active: true, uri: null };
  }
  const rest = hash.slice('#store'.length).replace(/^\//, '');
  if (!rest) return { active: true, uri: null };
  try {
    const uri = decodeURIComponent(rest);
    return { active: true, uri: uri.startsWith('store://') ? uri : null };
  } catch {
    return { active: true, uri: null };
  }
}

export function buildStoreHash(uri?: string | null): string {
  if (!uri || !uri.trim()) return '#store';
  return `#store/${encodeURIComponent(uri.trim())}`;
}
