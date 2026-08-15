/**
 * Newer ZCode app-server (`zcode.cjs` 0.16+) asks the stdio client for runtime
 * preferences while `session/create` is still in flight. zcode-acp-server 0.1.0
 * only drains those server→client requests during a prompt turn, so create
 * waits 15s and surfaces `zcode create failed: timeout`.
 *
 * The stdio proxy answers this one method with headless defaults so create
 * can finish. Schema from zcode.cjs (`rKt`): nativeSearchEnhancementsEnabled
 * is required; the rest have defaults.
 */

export const ZCODE_RUNTIME_PREFERENCES_METHOD = 'session/requestRuntimePreferences';

export const DEFAULT_ZCODE_RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
} as const;

export function replyForZcodeServerRequest(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let msg: { id?: unknown; method?: unknown };
  try {
    msg = JSON.parse(trimmed) as { id?: unknown; method?: unknown };
  } catch {
    return null;
  }
  if (msg.method !== ZCODE_RUNTIME_PREFERENCES_METHOD) return null;
  if (msg.id === undefined || msg.id === null) return null;
  return JSON.stringify({
    id: msg.id,
    result: { ...DEFAULT_ZCODE_RUNTIME_PREFERENCES },
  });
}
