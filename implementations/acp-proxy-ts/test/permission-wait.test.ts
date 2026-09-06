/**
 * Regression tests for the delayed-review deadlock.
 *
 * ACP `session/request_permission` is synchronous: while the Shepaw app holds
 * the review card, the proxy blocks the upstream agent's tool call on
 * `taskCtx.waitForResponse`. The old code armed a 20-minute deadline and, on
 * expiry, silently returned `cancelled` — aborting a tool the human was still
 * legitimately deciding on. The late submitResponse then found no waiter, was
 * dropped after 2s, and the turn never saw `stop` (conversation wedged).
 *
 * These tests pin the fix: the permission waiter must be registered with NO
 * reply deadline (`timeoutMs: 0`), a review that arrives after any plausible
 * short deadline still resolves to `selected`, and only a genuine teardown
 * (waiter rejected, e.g. task.cancel) still cancels the tool.
 */

import { describe, expect, it, vi } from 'vitest';

import { AcpSubprocess, type TurnContext } from '../src/acp-subprocess.js';
import type { AcpEngineSpec } from '../src/engines.js';

const SPEC: AcpEngineSpec = {
  id: 'test-engine',
  displayName: 'Test Engine',
  command: 'true',
  args: [],
  defaultAgentName: 'Test',
};

/** One permission tool call of kind `execute` (policy default = ask). */
const TOOL_CALL = {
  toolCallId: 'call_git_diff',
  title: 'Run git diff',
  kind: 'execute',
  rawInput: { command: 'git diff' },
};

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
];

interface PermissionOutcome {
  outcome: { outcome: string; optionId?: string };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wire an AcpSubprocess with a fake currentTurn whose waiters we control. */
function setup() {
  const sub = new AcpSubprocess({ spec: SPEC, cwd: '/tmp' }) as unknown as {
    currentTurn: TurnContext;
    handleRequestPermission(
      params: unknown,
      signal: AbortSignal,
    ): Promise<PermissionOutcome>;
  };
  const turnAbort = new AbortController();
  const d = makeDeferred<Record<string, unknown>>();
  const waitForResponse = vi.fn().mockReturnValue(d.promise);
  const sendActionConfirmation = vi.fn().mockResolvedValue(undefined);
  sub.currentTurn = {
    taskCtx: { waitForResponse, sendActionConfirmation } as never,
    signal: turnAbort.signal,
  } as TurnContext;
  return { sub, d, waitForResponse, sendActionConfirmation };
}

describe('request_permission — no silent cancel on a slow human review', () => {
  it('registers the permission waiter with no reply deadline (not 20 minutes)', async () => {
    const { sub, d, waitForResponse, sendActionConfirmation } = setup();

    const request = { toolCall: TOOL_CALL, options: OPTIONS };
    const resultPromise = sub.handleRequestPermission(request, new AbortController().signal);

    await vi.waitFor(() => expect(waitForResponse).toHaveBeenCalledTimes(1));
    expect(sendActionConfirmation).toHaveBeenCalledTimes(1);
    const [, opts] = waitForResponse.mock.calls[0] as [
      string,
      { timeoutMs?: number },
    ];
    // The regression: this used to be 20 * 60 * 1000, which silently turned a
    // late-but-legitimate approval into a tool abort and wedged the turn.
    expect(opts.timeoutMs).toBe(0);

    // The reviewer answers long after the card was emitted — must be honored.
    d.resolve({ confirmation_id: 'perm_x', selected_action_id: 'allow_once' });
    const result = await resultPromise;
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });

  it('still cancels the tool when the waiter is torn down (task cancel / abort)', async () => {
    const { sub, d, waitForResponse } = setup();

    const request = { toolCall: TOOL_CALL, options: OPTIONS };
    const resultPromise = sub.handleRequestPermission(request, new AbortController().signal);
    await vi.waitFor(() => expect(waitForResponse).toHaveBeenCalledTimes(1));

    // task.cancel rejects every pending waiter — the tool must be denied.
    d.reject(new Error('Task cancelled'));
    const result = await resultPromise;
    expect(result.outcome.outcome).toBe('cancelled');
  });

  it('denies the tool when the whole request/turn was aborted before the reply', async () => {
    const { sub, d, waitForResponse } = setup();
    const signal = new AbortController();

    const request = { toolCall: TOOL_CALL, options: OPTIONS };
    const resultPromise = sub.handleRequestPermission(request, signal.signal);
    await vi.waitFor(() => expect(waitForResponse).toHaveBeenCalledTimes(1));

    // Reply resolves but the turn already went away — treat as cancelled.
    signal.abort();
    d.resolve({ confirmation_id: 'perm_x', selected_action_id: 'allow_once' });
    const result = await resultPromise;
    expect(result.outcome.outcome).toBe('cancelled');
  });
});
