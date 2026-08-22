/**
 * Normalize history messages so every turn carries a protocol `created_at`.
 *
 * Engine adapters (e.g. Cursor embedded `<timestamp>` tags) should populate
 * `created_at` when they can. This helper fills any remaining gaps so the app
 * only ever consumes the standard field — never engine-specific formats.
 */

import type { SessionHistoryMessage } from 'shepaw-acp-sdk';

const MINUTE_MS = 60_000;

/**
 * Ensure every message has `created_at` (ISO-8601).
 *
 * 1. Keep existing stamps.
 * 2. Propagate forward: unstamped turns get previous stamp + 1s.
 * 3. Remaining leading gaps: anchor the last message to [sessionUpdatedAt]
 *    (or now) and space earlier messages one minute apart, then merge without
 *    rewriting already-known stamps.
 */
export function ensureHistoryCreatedAt(
  messages: SessionHistoryMessage[],
  opts: { sessionUpdatedAt?: string } = {},
): SessionHistoryMessage[] {
  if (messages.length === 0) return messages;

  const out: SessionHistoryMessage[] = messages.map((m) => ({ ...m }));

  // Forward-fill from known stamps (covers agent replies after a stamped user).
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.created_at !== undefined) continue;
    if (i === 0) continue;
    const prev = out[i - 1]!.created_at;
    if (prev === undefined) continue;
    const ms = Date.parse(prev);
    if (Number.isNaN(ms)) continue;
    out[i]!.created_at = new Date(ms + 1000).toISOString();
  }

  const stillMissing = out.some((m) => m.created_at === undefined);
  if (!stillMissing) return out;

  const endMs = (() => {
    if (opts.sessionUpdatedAt !== undefined) {
      const parsed = Date.parse(opts.sessionUpdatedAt);
      if (!Number.isNaN(parsed)) return parsed;
    }
    // Prefer the latest known stamp in the transcript.
    for (let i = out.length - 1; i >= 0; i--) {
      const at = out[i]!.created_at;
      if (at === undefined) continue;
      const ms = Date.parse(at);
      if (!Number.isNaN(ms)) return ms;
    }
    return Date.now();
  })();

  for (let i = 0; i < out.length; i++) {
    if (out[i]!.created_at !== undefined) continue;
    const offsetFromEnd = out.length - 1 - i;
    out[i]!.created_at = new Date(endMs - offsetFromEnd * MINUTE_MS).toISOString();
  }

  // Keep chronological order stable if anchors mixed oddly.
  for (let i = 1; i < out.length; i++) {
    const prev = Date.parse(out[i - 1]!.created_at!);
    const cur = Date.parse(out[i]!.created_at!);
    if (!Number.isNaN(prev) && !Number.isNaN(cur) && cur < prev) {
      out[i]!.created_at = new Date(prev + 1000).toISOString();
    }
  }

  return out;
}
