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
