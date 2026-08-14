/**
 * Regression tests for strict app↔upstream session binding.
 *
 * When sessions.json already maps an app session to an upstream id, ACP
 * restart must resume that id — never silently session/new a parallel
 * upstream session. Forking is only allowed when session/list returns a
 * non-empty set that does not include the bound id (empty list is unknown).
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
  agentCapabilities: {
    sessionCapabilities: { resume: {}, list: {} },
  },
} as acp.InitializeResponse;

const RESUME_ONLY_CAPS: acp.InitializeResponse = {
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

type RequestBehavior = (method: string, params?: unknown) => Promise<unknown>;

function fakeConnection(opts: {
  onRequest: RequestBehavior;
  newSessionId?: string;
}) {
  return {
    agent: {
      request: (method: string, params?: unknown) => opts.onRequest(method, params),
      attachSession: (r: { sessionId: string }) => fakeActiveSession(r.sessionId),
      buildSession: () => ({
        start: async () => fakeActiveSession(opts.newSessionId ?? 'sdk-new'),
        withMcpServer: function withMcpServer() {
          return this;
        },
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

const rejectResumeListEmpty: RequestBehavior = (method) => {
  if (method.includes('list')) return Promise.resolve({ sessions: [] });
  return Promise.reject(new Error('session not found'));
};

function rejectResumeListHas(id: string): RequestBehavior {
  return (method) => {
    if (method.includes('list')) {
      return Promise.resolve({ sessions: [{ sessionId: id, cwd: '/tmp' }] });
    }
    return Promise.reject(new Error('resume rejected'));
  };
}

function rejectResumeListOthers(missingId: string): RequestBehavior {
  return (method) => {
    if (method.includes('list')) {
      return Promise.resolve({ sessions: [{ sessionId: 'someone-else', cwd: '/tmp' }] });
    }
    return Promise.reject(new Error(`session ${missingId} not found`));
  };
}

interface SubHarness {
  sub: AcpSubprocess;
  getOrCreate: (shepawId: string, opts: RunPromptTurnOptions) => Promise<unknown>;
  setConnection: (conn: unknown) => void;
  setCaps: (caps: acp.InitializeResponse) => void;
  restartMock: ReturnType<typeof vi.fn>;
}

function makeSub(caps: acp.InitializeResponse = RESUME_CAPS): SubHarness {
  const sub = new AcpSubprocess({ spec: SPEC, cwd: '/tmp' }) as unknown as {
    connection: unknown;
    agentCaps: acp.InitializeResponse;
    restartUpstreamAgent: () => Promise<void>;
    getOrCreateSession: (id: string, opts: RunPromptTurnOptions) => Promise<unknown>;
  };
  sub.agentCaps = caps;
  const restartMock = vi.fn(async () => {});
  sub.restartUpstreamAgent = restartMock as unknown as () => Promise<void>;
  return {
    sub: sub as unknown as AcpSubprocess,
    getOrCreate: (id, opts) => sub.getOrCreateSession(id, opts),
    setConnection: (conn) => {
      sub.connection = conn;
    },
    setCaps: (next) => {
      sub.agentCaps = next;
    },
    restartMock,
  };
}

describe('getOrCreateSession strict binding', () => {
  const originalTimeout = (
    AcpSubprocess as unknown as { RESTORE_TIMEOUT_MS: number }
  ).RESTORE_TIMEOUT_MS;

  beforeEach(() => {
    (AcpSubprocess as unknown as { RESTORE_TIMEOUT_MS: number }).RESTORE_TIMEOUT_MS = 30;
  });

  afterEach(() => {
    (AcpSubprocess as unknown as { RESTORE_TIMEOUT_MS: number }).RESTORE_TIMEOUT_MS =
      originalTimeout;
    vi.restoreAllMocks();
  });

  it('does not treat an empty session/list as confirmed-gone (idle death)', async () => {
    const h = makeSub();
    h.setConnection(
      fakeConnection({ onRequest: rejectResumeListEmpty, newSessionId: 'sdk-new' }),
    );

    const abandoned: string[] = [];
    await expect(
      h.getOrCreate('shepaw-1', {
        getStoredAcpSessionId: () => 'sdk-old',
        onAbandonedAcpSessionId: (id) => abandoned.push(id),
      }),
    ).rejects.toThrow(/could not verify via session\/list/);
    expect(abandoned).toEqual([]);
  });

  it('forks and rehydrates when restore fails, list is empty, and prior history is present', async () => {
    const h = makeSub();
    h.setConnection(
      fakeConnection({ onRequest: rejectResumeListEmpty, newSessionId: 'sdk-new' }),
    );

    const abandoned: string[] = [];
    const restoreFailed: string[] = [];
    const result = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => 'sdk-old',
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
      onRestoreFailed: (id) => restoreFailed.push(id),
      priorHistory: [{ role: 'user', content: 'hello' }],
    })) as { session: FakeActiveSession; origin: string };

    expect(result.session.sessionId).toBe('sdk-new');
    expect(result.origin).toBe('created');
    expect(abandoned).toEqual(['sdk-old']);
    expect(restoreFailed).toEqual(['shepaw-1']);
  });

  it('forks only when restore fails and session/list confirms the upstream id is gone', async () => {
    const h = makeSub();
    h.setConnection(
      fakeConnection({ onRequest: rejectResumeListOthers('sdk-old'), newSessionId: 'sdk-new' }),
    );

    const abandoned: string[] = [];
    const restoreFailed: string[] = [];
    const mapped: Array<[string, string]> = [];

    const result = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => 'sdk-old',
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
      onRestoreFailed: (id) => restoreFailed.push(id),
      onAcpSessionId: (sid, acpId) => mapped.push([sid, acpId]),
    })) as { session: FakeActiveSession; origin: string };

    expect(result.session.sessionId).toBe('sdk-new');
    expect(result.origin).toBe('created');
    expect(abandoned).toEqual(['sdk-old']);
    expect(restoreFailed).toEqual(['shepaw-1']);
    expect(mapped).toEqual([['shepaw-1', 'sdk-new']]);
  });

  it('keeps the binding and throws when restore fails but upstream session still exists', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: rejectResumeListHas('sdk-old') }));

    const abandoned: string[] = [];
    await expect(
      h.getOrCreate('shepaw-1', {
        getStoredAcpSessionId: () => 'sdk-old',
        onAbandonedAcpSessionId: (id) => abandoned.push(id),
      }),
    ).rejects.toThrow(/binding kept/);
    expect(abandoned).toEqual([]);
  });

  it('retries restore once on the restarted upstream after a timeout instead of forking', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: hangForever }));
    h.restartMock.mockImplementation(async () => {
      h.setConnection(fakeConnection({ onRequest: resolveResume }));
    });

    const abandoned: string[] = [];
    const session = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => 'sdk-old',
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
    })) as { session: FakeActiveSession };

    expect(session.session.sessionId).toBe('sdk-old');
    expect(h.restartMock).toHaveBeenCalledTimes(1);
    expect(abandoned).toEqual([]);
  });

  it('keeps the binding and throws when the restore retry also times out', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: hangForever, newSessionId: 'sdk-new' }));
    h.restartMock.mockImplementation(async () => {
      h.setConnection(fakeConnection({ onRequest: hangForever, newSessionId: 'sdk-new' }));
    });

    const abandoned: string[] = [];
    await expect(
      h.getOrCreate('shepaw-1', {
        getStoredAcpSessionId: () => 'sdk-old',
        onAbandonedAcpSessionId: (id) => abandoned.push(id),
      }),
    ).rejects.toThrow(/timed out.*binding kept/i);
    expect(h.restartMock).toHaveBeenCalledTimes(2);
    expect(abandoned).toEqual([]);
  });

  it('creates a fresh session without orphan bookkeeping when nothing is stored', async () => {
    const h = makeSub();
    h.setConnection(fakeConnection({ onRequest: rejectResume, newSessionId: 'sdk-new' }));

    const abandoned: string[] = [];
    const result = (await h.getOrCreate('shepaw-1', {
      getStoredAcpSessionId: () => undefined,
      onAbandonedAcpSessionId: (id) => abandoned.push(id),
    })) as { session: FakeActiveSession; origin: string };

    expect(result.session.sessionId).toBe('sdk-new');
    expect(result.origin).toBe('created');
    expect(abandoned).toEqual([]);
  });

  it('keeps the binding when session/list is unavailable after a failed restore', async () => {
    const h = makeSub(RESUME_ONLY_CAPS);
    h.setConnection(fakeConnection({ onRequest: rejectResume }));

    const abandoned: string[] = [];
    await expect(
      h.getOrCreate('shepaw-1', {
        getStoredAcpSessionId: () => 'sdk-old',
        onAbandonedAcpSessionId: (id) => abandoned.push(id),
      }),
    ).rejects.toThrow(/binding kept/);
    expect(abandoned).toEqual([]);
  });
});
