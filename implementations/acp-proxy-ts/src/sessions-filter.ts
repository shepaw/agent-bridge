/**
 * Filter upstream `session/list` entries before exposing them to the app.
 *
 * Cursor (and some other engines) persist prompt-less `session/new` calls used
 * only to warm slash-command caches. Those show up as untitled, empty sessions
 * and trigger repeated "sync remote session" prompts on the phone.
 */

import type * as acp from '@agentclientprotocol/sdk';

export interface SessionsListFilterContext {
  /** Warmup / disposable session ids — never sync these. */
  readonly disposableUpstreamIds: ReadonlySet<string>;
  /**
   * Upstream ids abandoned when their Shepaw conversation forked to a fresh
   * upstream session — never sync these either; the app would adopt the
   * orphaned half as a duplicate session.
   */
  readonly orphanedUpstreamIds?: ReadonlySet<string>;
  /** Upstream ids with a persisted Shepaw mapping (real conversations). */
  readonly preserveUpstreamIds: ReadonlySet<string>;
  /** Upstream ids currently live in the serving subprocess. */
  readonly activeUpstreamIds: ReadonlySet<string>;
}

export function shouldExposeListedSession(
  session: acp.SessionInfo,
  ctx: SessionsListFilterContext,
): boolean {
  const id = session.sessionId;
  if (ctx.disposableUpstreamIds.has(id)) return false;
  if (ctx.orphanedUpstreamIds?.has(id)) return false;
  if (ctx.preserveUpstreamIds.has(id)) return true;
  if (ctx.activeUpstreamIds.has(id)) return true;

  const title = session.title?.trim();
  if (title !== undefined && title.length > 0) return true;

  // Untitled + unmapped sessions are almost always warmup artifacts.
  return false;
}

export function filterListedSessions(
  sessions: ReadonlyArray<acp.SessionInfo>,
  ctx: SessionsListFilterContext,
): acp.SessionInfo[] {
  return sessions.filter((s) => shouldExposeListedSession(s, ctx));
}
