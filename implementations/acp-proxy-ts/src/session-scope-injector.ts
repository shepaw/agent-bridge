/**
 * Scope Card injection channel per upstream ACP engine.
 *
 * Phase 2: stable Scope Card via `session/new` `_meta.systemPrompt` when the
 * engine supports it (claude-agent-acp, OpenCode ACP bridge, etc.). Unsupported
 * engines fall back to prepending a user text block each turn (Phase 1).
 *
 * Env:
 * - `SHEPAW_SCOPE_CARD_MODE=auto|system|user` (default `auto`)
 */

export type ScopeCardInjectionChannel = 'system' | 'user';

const CLAUDE_ENGINE_IDS = new Set([
  'claude-code',
  'tclaude',
  'claude-internal',
]);

/** Engines known to honor `_meta.systemPrompt` on `session/new`. */
export function engineSupportsSystemScopeCard(engineId: string): boolean {
  if (CLAUDE_ENGINE_IDS.has(engineId)) return true;
  switch (engineId) {
    case 'opencode':
    case 'cursor':
      return true;
    default:
      return false;
  }
}

/**
 * Resolve injection channel from env + engine capability.
 * `auto` picks `system` when the engine advertises support, else `user`.
 */
export function resolveScopeCardChannel(
  engineId: string,
  env: NodeJS.ProcessEnv = process.env,
): ScopeCardInjectionChannel {
  const flag = (env.SHEPAW_SCOPE_CARD_MODE ?? 'auto').trim().toLowerCase();
  if (flag === 'user') return 'user';
  if (flag === 'system') return 'system';
  return engineSupportsSystemScopeCard(engineId) ? 'system' : 'user';
}

/** `_meta` payload for `session/new` — append stable card to engine system prompt. */
export function buildSessionNewScopeMeta(
  stableCard: string,
): Record<string, unknown> | undefined {
  const text = stableCard.trim();
  if (text.length === 0) return undefined;
  return { systemPrompt: { append: text } };
}

export interface ScopeInjectionTurn {
  readonly stableCard: string;
  readonly channel: ScopeCardInjectionChannel;
}
