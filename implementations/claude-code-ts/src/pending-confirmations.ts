/**
 * Synchronous confirmation tracker.
 *
 * The agent's `canUseTool` calls `wait()` which returns a Promise that
 * blocks until one of:
 *   - the user replies with an approval verdict (agent.onChat sees a new
 *     chat message, calls `resolveAll` with 'allow' / 'deny')
 *   - the task's AbortController fires (user cancelled the task from the
 *     app) → resolves to a deny
 *   - the timeout elapses → resolves to a deny
 *
 * Rationale: the earlier "fire-and-forget + deny" approach leaked the
 * deny message into the model's output (it would friendly-explain the
 * permission rejection to the user instead of cleanly ending). Holding
 * the SDK's turn open across the approval round-trip avoids that.
 */

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface PendingConfirmation {
  toolName: string;
  input: Record<string, unknown>;
  displayPrompt: string;
  /** ms epoch when the confirmation was issued. */
  requestedAt: number;
}

export interface WaitParams {
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  displayPrompt: string;
  /** Signal from the SDK's canUseTool options — aborts on task cancel. */
  signal: AbortSignal;
  /** Override the default timeout for this one call. */
  timeoutMs?: number;
}

interface Entry extends PendingConfirmation {
  settle(decision: PermissionDecision): void;
}

export interface PendingConfirmationsOptions {
  /** Default maximum wait per confirmation. 20 min matches ApprovalCache TTL. */
  defaultTimeoutMs?: number;
}

export class PendingConfirmations {
  private readonly bySession = new Map<string, Entry[]>();
  private readonly defaultTimeoutMs: number;

  constructor(opts: PendingConfirmationsOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 20 * 60 * 1000;
  }

  /** Block until the user's verdict arrives, or timeout / abort. */
  wait(params: WaitParams): Promise<PermissionDecision> {
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<PermissionDecision>((resolve) => {
      let settled = false;
      const settle = (d: PermissionDecision): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        params.signal.removeEventListener('abort', onAbort);
        this.remove(params.sessionId, entry);
        resolve(d);
      };

      const entry: Entry = {
        toolName: params.toolName,
        input: params.input,
        displayPrompt: params.displayPrompt,
        requestedAt: Date.now(),
        settle,
      };

      let list = this.bySession.get(params.sessionId);
      if (list === undefined) {
        list = [];
        this.bySession.set(params.sessionId, list);
      }
      list.push(entry);

      const timer = setTimeout(() => {
        settle({
          behavior: 'deny',
          message:
            'Approval request timed out. The user did not respond on their phone within 20 minutes.',
        });
      }, timeoutMs);

      const onAbort = (): void => {
        settle({ behavior: 'deny', message: 'Task cancelled by the user.' });
      };
      if (params.signal.aborted) {
        onAbort();
      } else {
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Settle every pending confirmation in a session with `verdict`.
   * Returns snapshots of what was settled so the agent can mirror the
   * decision into the cross-turn ApprovalCache.
   */
  resolveAll(
    sessionId: string,
    verdict: 'allow' | 'deny',
  ): PendingConfirmation[] {
    const list = this.bySession.get(sessionId);
    if (list === undefined || list.length === 0) return [];

    const snapshots: PendingConfirmation[] = list.map((e) => ({
      toolName: e.toolName,
      input: e.input,
      displayPrompt: e.displayPrompt,
      requestedAt: e.requestedAt,
    }));
    // Settle in FIFO order. settle() calls this.remove() which mutates
    // the list, so copy first and clear the session's slot.
    const settlers = [...list];
    this.bySession.set(sessionId, []);
    for (const entry of settlers) {
      if (verdict === 'allow') {
        entry.settle({ behavior: 'allow', updatedInput: entry.input });
      } else {
        entry.settle({ behavior: 'deny', message: 'User denied this action.' });
      }
    }
    return snapshots;
  }

  /**
   * Custom-verdict variant: for each pending, the caller builds the
   * `PermissionDecision` from the snapshot. Used by form submissions,
   * where `updatedInput` carries the raw answer text.
   * Returns the count settled.
   */
  resolveAllWith(
    sessionId: string,
    builder: (snapshot: PendingConfirmation) => PermissionDecision,
  ): number {
    const list = this.bySession.get(sessionId);
    if (list === undefined || list.length === 0) return 0;
    const settlers = [...list];
    this.bySession.set(sessionId, []);
    for (const entry of settlers) {
      entry.settle(
        builder({
          toolName: entry.toolName,
          input: entry.input,
          displayPrompt: entry.displayPrompt,
          requestedAt: entry.requestedAt,
        }),
      );
    }
    return settlers.length;
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }

  peekMostRecent(sessionId: string): PendingConfirmation | undefined {
    const list = this.bySession.get(sessionId);
    if (list === undefined || list.length === 0) return undefined;
    const top = list[list.length - 1]!;
    return {
      toolName: top.toolName,
      input: top.input,
      displayPrompt: top.displayPrompt,
      requestedAt: top.requestedAt,
    };
  }

  private remove(sessionId: string, entry: Entry): void {
    const list = this.bySession.get(sessionId);
    if (list === undefined) return;
    const idx = list.indexOf(entry);
    if (idx >= 0) list.splice(idx, 1);
  }
}
