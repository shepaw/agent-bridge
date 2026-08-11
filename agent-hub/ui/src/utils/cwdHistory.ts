/**
 * Persist recently used Working Directory paths in localStorage
 * for autocomplete in the create/edit instance forms.
 */

const STORAGE_KEY = 'shepaw_cwd_history';
const MAX_ENTRIES = 30;

function normalize(path: string): string {
  return path.trim().replace(/\/+$/, '') || path.trim();
}

export function loadCwdHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(normalize);
  } catch {
    return [];
  }
}

export function saveCwdHistory(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota / private mode */
  }
}

/** Insert path at the front (most recent), dedupe, cap length. */
export function rememberCwd(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return loadCwdHistory();
  const key = normalize(trimmed);
  const next = [trimmed, ...loadCwdHistory().filter((p) => normalize(p) !== key)].slice(0, MAX_ENTRIES);
  saveCwdHistory(next);
  return next;
}

/** Merge external paths (e.g. existing instances) into history without reordering recent first. */
export function seedCwdHistory(paths: string[]): string[] {
  const existing = loadCwdHistory();
  const seen = new Set(existing.map(normalize));
  const extras: string[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    extras.push(trimmed);
  }
  if (extras.length === 0) return existing;
  const next = [...existing, ...extras].slice(0, MAX_ENTRIES);
  saveCwdHistory(next);
  return next;
}

/** Prefix filter (case-insensitive). Empty query → all history. */
export function filterCwdHistory(history: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return history;
  return history.filter((p) => p.toLowerCase().startsWith(q));
}
