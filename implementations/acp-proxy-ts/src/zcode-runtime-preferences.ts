/**
 * Newer ZCode app-server (`zcode.cjs` 0.16+) asks the stdio client for runtime
 * preferences while `session/create` is still in flight. zcode-acp-server 0.1.0
 * only drains those server→client requests during a prompt turn, so create
 * waits 15s and surfaces `zcode create failed: timeout`.
 *
 * Plan / OAuth providers (`builtin:bigmodel-start-plan`) also send
 * `interaction/requestProviderRuntimeHeaders` before each model call. The
 * adapter treats unknown methods as `bridge unsupported`, which becomes
 * `model_request_failed`. Desktop applies OAuth headers as a side effect;
 * headless already overlays the selected provider JWT as ANTHROPIC_API_KEY,
 * so acknowledging `headersApplied: true` is enough.
 *
 * Schema from zcode.cjs: `rKt` (runtime preferences), `SKt` (runtime headers).
 */

export const ZCODE_RUNTIME_PREFERENCES_METHOD = 'session/requestRuntimePreferences';

export const ZCODE_PROVIDER_RUNTIME_HEADERS_METHOD =
  'interaction/requestProviderRuntimeHeaders';

export const DEFAULT_ZCODE_RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
} as const;

export const DEFAULT_ZCODE_PROVIDER_RUNTIME_HEADERS = {
  headersApplied: true,
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
  if (msg.id === undefined || msg.id === null) return null;
  if (msg.method === ZCODE_RUNTIME_PREFERENCES_METHOD) {
    return JSON.stringify({
      id: msg.id,
      result: { ...DEFAULT_ZCODE_RUNTIME_PREFERENCES },
    });
  }
  if (msg.method === ZCODE_PROVIDER_RUNTIME_HEADERS_METHOD) {
    return JSON.stringify({
      id: msg.id,
      result: { ...DEFAULT_ZCODE_PROVIDER_RUNTIME_HEADERS },
    });
  }
  return null;
}
