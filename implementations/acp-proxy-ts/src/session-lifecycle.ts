/**
 * Helpers for attaching ActiveSession after session/new, session/resume, or session/load.
 */

import * as acp from '@agentclientprotocol/sdk';

export function attachActiveSession(
  agent: acp.ClientContext,
  sessionId: string,
  response: Pick<acp.NewSessionResponse, 'modes' | 'configOptions' | '_meta'>,
): acp.ActiveSession {
  const attach = (agent as unknown as { attachSession(r: acp.NewSessionResponse): acp.ActiveSession })
    .attachSession;
  return attach.call(agent, {
    sessionId,
    modes: response.modes ?? null,
    configOptions: response.configOptions ?? null,
    _meta: response._meta ?? null,
  });
}

export function supportsSessionResume(caps: acp.InitializeResponse | undefined): boolean {
  return caps?.agentCapabilities?.sessionCapabilities?.resume !== undefined
    && caps?.agentCapabilities?.sessionCapabilities?.resume !== null;
}

export function supportsSessionLoad(caps: acp.InitializeResponse | undefined): boolean {
  return caps?.agentCapabilities?.loadSession === true;
}

export function supportsSessionList(caps: acp.InitializeResponse | undefined): boolean {
  return caps?.agentCapabilities?.sessionCapabilities?.list !== undefined
    && caps?.agentCapabilities?.sessionCapabilities?.list !== null;
}

export function supportsSessionDelete(caps: acp.InitializeResponse | undefined): boolean {
  return caps?.agentCapabilities?.sessionCapabilities?.delete !== undefined
    && caps?.agentCapabilities?.sessionCapabilities?.delete !== null;
}

export interface DiscardReplayOptions {
  /** Stop after this many ms without a replay update. Default 400. */
  idleMs?: number;
  /** Hard cap even if replay updates keep arriving. Default 15_000. */
  maxMs?: number;
  /** Per-read timeout when waiting for the next update. Default 100. */
  pollMs?: number;
}

function isReplayUpdate(update: acp.SessionUpdate): boolean {
  const meta = (update as { _meta?: { replay?: boolean; isReplay?: boolean } })._meta;
  if (meta?.replay === false || meta?.isReplay === false) return false;
  if (meta?.replay === true || meta?.isReplay === true) return true;

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
    case 'plan_update':
      return true;
    default:
      return false;
  }
}

/**
 * Drain history replay emitted after session/load. Uses idle detection so short
 * replays finish quickly while long histories get up to maxMs.
 */
export async function discardLoadReplayUpdates(
  session: acp.ActiveSession,
  opts: DiscardReplayOptions = {},
): Promise<number> {
  const idleMs = opts.idleMs ?? 400;
  const maxMs = opts.maxMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;

  const startedAt = Date.now();
  let lastAt = startedAt;
  let discarded = 0;

  while (Date.now() - startedAt < maxMs) {
    let pending: acp.ActiveSessionMessage | undefined;
    try {
      pending = await Promise.race([
        session.nextUpdate(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), pollMs)),
      ]);
    } catch {
      break;
    }

    if (pending === undefined) {
      if (Date.now() - lastAt >= idleMs) break;
      continue;
    }

    lastAt = Date.now();
    if (pending.kind === 'stop') break;

    if (isReplayUpdate(pending.update)) {
      discarded += 1;
      continue;
    }

    // Non-replay update after load — unexpected; stop draining.
    break;
  }

  return discarded;
}
