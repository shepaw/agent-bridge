/**
 * Detect Cursor ACP's known stale-auth assistant reply.
 *
 * Long-lived `agent acp` processes sometimes emit
 * "Please sign in to continue" as normal agent_message_chunk text instead of
 * a structured auth error. See:
 * https://forum.cursor.com/t/cursor-agent-acp-live-process-returns-sign-in-prompt-as-assistant-content-after-auth-state-goes-stale/163787
 */

export const CURSOR_STALE_AUTH_MESSAGE = 'Please sign in to continue';

const STALE_AUTH_CANONICAL = CURSOR_STALE_AUTH_MESSAGE.toLowerCase();

/** Max re-runs after the first stale-auth failure (total attempts = 1 + this). */
export const CURSOR_STALE_AUTH_RETRIES = 3;

function normalizeAssistantText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!。！]+$/, '')
    .trim();
}

/** True when `text` is exactly the Cursor stale-auth reply (modulo trim/punct). */
export function isStaleAuthMessage(text: string): boolean {
  return normalizeAssistantText(text) === STALE_AUTH_CANONICAL;
}

/**
 * True while buffered agent text could still become the stale-auth reply.
 * Used to hold `agent_message_chunk` streaming until the turn ends (or the
 * buffer diverges from the known error prefix).
 */
export function isPossibleStaleAuthPrefix(text: string): boolean {
  const t = normalizeAssistantText(text);
  if (t.length === 0) return true;
  return STALE_AUTH_CANONICAL.startsWith(t);
}
