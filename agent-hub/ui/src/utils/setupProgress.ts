/**
 * First-install setup progress persisted per-browser.
 *
 * Only three stages are ever persisted:
 *   - 'engines': hub has no instances yet; guide lives on the engine page.
 *   - 'pair':    first instance created; guide lives on the scan-to-pair page.
 *   - 'done':    setup finished (or hub already had instances) — no guide.
 *
 * The in-memory marker 'new' (key absent from localStorage) is owned by App.tsx,
 * not stored here.
 */

export type SetupStage = 'engines' | 'pair' | 'done';

export const SETUP_PROGRESS_KEY = 'shepaw_setup_progress';

const STAGES: SetupStage[] = ['engines', 'pair', 'done'];

export function readSetupProgress(): SetupStage | null {
  try {
    const raw = localStorage.getItem(SETUP_PROGRESS_KEY);
    if (raw === null) return null;
    // Whitelist-check so a stale/corrupt value behaves like "no marker".
    return (STAGES as string[]).includes(raw) ? (raw as SetupStage) : null;
  } catch {
    /* private mode */
    return null;
  }
}

export function writeSetupProgress(stage: SetupStage): void {
  try {
    localStorage.setItem(SETUP_PROGRESS_KEY, stage);
  } catch {
    /* private mode */
  }
}
