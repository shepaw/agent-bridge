/**
 * Regression tests for the "session crossing" bug: one app (Shepaw) session
 * must never silently fork into two upstream ACP sessions. When a fork is
 * unavoidable, the abandoned upstream session must be reported via
 * `onAbandonedAcpSessionId` so session/list sync filters it out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as acp from '@agentclientprotocol/sdk';

import { AcpSubprocess, type RunPromptTurnOptions } from '../src/acp-subprocess.js';
import type { AcpEngineSpec } from '../src/engines.js';

const SPEC: AcpEngineSpec = {
  id: 'test-engine',
  displayName: 'Test Engine',
  command: 'true',
  args: [],
  defaultAgentName: 'Test',
};

const RESUME_CAPS: acp.InitializeResponse = {
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: { sessionCapabilities: { resume: {} } },
} as acp.InitializeResponse;

interface FakeActiveSession {
  sessionId: string;
  newSessionResponse: { sessionId: string; modes: null; configOptions: null; _meta: null };
  dispose: () => void;
}

function fakeActiveSession(sessionId: string): FakeActiveSession {
  return {
    sessionId,
    newSessionResponse: { sessionId, modes: null, configOptions: null, _meta: null },
    dispose: () => {},
  };
}

type RequestBehavior = (method: string) => Promise<unknown>;

function fakeConnection(opts: { onRequest: RequestBehavior; newSessionId?: string }) {
  return {
    agent: {
      request: (method: string) => opts.onRequest(method),
      attachSession: (r: { sessionId: string }) => fakeActiveSession(r.sessionId),
      buildSession: () => ({
        start: async () => fakeActiveSession(opts.newSessionId ?? 'sdk-new'),
      }),
    },
  };
}

/** A request handler that hangs forever (simulates a wedged upstream). */
const hangForever: RequestBehavior = () => new Promise<never>(() => {});
/** A request handler that rejects — resume answered with an error. */
const rejectResume: RequestBehavior = () => Promise.reject(new Error('session not found'));
/** A request handler that resolves — resume succeeded. */
const resolveResume: RequestBehavior = () => Promise.resolve({});

interface SubHarness {
  sub: AcpSubprocess;
  getOrCreate: (shepawId: string, opts: RunPromptTurnOptions) => Promise<unknown>;
  setConnection: (conn: unknown) => void;
  restartMock: ReturnType<typeof vi.fn>;
}

function makeSub(): SubHarness {
  const sub = new AcpSubprocess({ spec: SPEC, cwd: '/tmp' }) as unknown as {
    connection: unknown;
    agentCaps: acp.InitializeResponse;
    restartUpstreamAgent: () => Promise<void>;
    getOrCreateSession: (id: string, opts: RunPromptTurnOptions) => Promise<unknown>;
  };
  sub.agentCaps = RESUME_CAPS;
  const restartMock = vi.fn(async () => {});
  sub.restartUpstreamAgent = restartMock as unknown as () => Promise<void>;
  return {
    sub: sub as unknown as AcpSubprocess,
    getOrCreate: (id, opts) => sub.getOrCreateSession(id, opts),
    setConnection: (conn) => {
      sub.connection = conn;
    },
    restartMock,
  };
}

describe('getOrCreateSession fork handling', () => {
  const originalTimeout = (
    AcpSubprocess as unknown as { RESTORE_TIMEOUT_MS: number }
  ).RESTORE_TIMEOUT_MS;

  beforeEach(() => {
    // Shrink the restore timeout so wedged-upstream tests run fast.
    (AcpSubprocess as unknown as { RESTORE_TIMEOUT_MS: number }).RESTORE_TIMEOUT_MS = 30;
  });

  afterEach(() => {
    (AcpSubprocess as unknown as { RESTORE_TIMEOUT_MS: number }).RESTORE_TIMEOUT_MS =
      originalTimeout;
    vi.restoreAllMocks();
  });

  it('forks to session/new when restore fails and reports the abandoned upstream id', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: rejectResume, newSessionId: 'sdk-new' }));

    const abandoned: string[] = [];
    const restoreFailed: string[] = [];
    const mapped: Array<[string, string]> = [];

    const session = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => 'sdk-old',
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
      onRestoreFailed: (id) => restoreFailed.push(id),
      onAcpSessionId: (sid, acpId) => mapped.push([sid, acpId]),
    })) as FakeActiveSession;

    expect(session.sessionId).toBe('sdk-new');
    expect(abandoned).toEqual(['sdk-old']);
    expect(restoreFailed).toEqual(['shepaw-1']);
    expect(mapped).toEqual([['shepaw-1', 'sdk-new']]);
  });

  it('retries restore once on the restarted upstream after a timeout instead of forking', async () => {
    const h = makeSub();
    // First connection wedges; the timeout path "restarts" into a healthy one.
    h.setConnection(fakeConnection({ onRequest: hangForever }));
    h.restartMock.mockImplementation(async () => {
      h.setConnection(fakeConnection({ onRequest: resolveResume }));
    });

    const abandoned: string[] = [];
    const session = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => 'sdk-old',
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
    })) as FakeActiveSession;

    expect(session.sessionId).toBe('sdk-old');
    expect(h.restartMock).toHaveBeenCalledTimes(1);
    expect(abandoned).toEqual([]);
  });

  it('forks and orphans when the restore retry also times out', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: hangForever, newSessionId: 'sdk-new' }));
    // Restart swaps in another wedged connection (session data itself hangs).
    h.restartMock.mockImplementation(async () => {
      h.setConnection(fakeConnection({ onRequest: hangForever, newSessionId: 'sdk-new' }));
    });

    const abandoned: string[] = [];
    const session = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => 'sdk-old',
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
    })) as FakeActiveSession;

    expect(session.sessionId).toBe('sdk-new');
    expect(h.restartMock).toHaveBeenCalledTimes(2);
    expect(abandoned).toEqual(['sdk-old']);
  });

  it('creates a fresh session without orphan bookkeeping when nothing is stored', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: rejectResume, newSessionId: 'sdk-new' }));

    const abandoned: string[] = [];
    const session = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => undefined,
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
    })) as FakeActiveSession;

    expect(session.sessionId).toBe('sdk-new');
    expect(abandoned).toEqual([]);
  });
});
