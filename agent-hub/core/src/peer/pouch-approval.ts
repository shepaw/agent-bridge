/**
 * Tool-approval waiters for pouch turns.
 *
 * The host emits `pouch_turn_event` kind `approval` and blocks the worker
 * until the display layer answers with `pouch_interaction_resp`.
 */

export interface PouchApprovalVerdict {
  readonly id: string;
  readonly label?: string;
}

type Waiter = {
  resolve: (verdict: PouchApprovalVerdict) => void;
  timer: NodeJS.Timeout;
};

const waiters = new Map<string, Waiter>();

const DEFAULT_TIMEOUT_MS = 120_000;

/** Block until `settlePouchApproval` or the timeout (empty id = deny). */
export function beginPouchApproval(
  approvalId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PouchApprovalVerdict> {
  const existing = waiters.get(approvalId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve({ id: '' });
    waiters.delete(approvalId);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(approvalId);
      resolve({ id: '' });
    }, timeoutMs);
    waiters.set(approvalId, { resolve, timer });
  });
}

/** Deliver a display-layer choice. Returns false when nothing is waiting. */
export function settlePouchApproval(
  approvalId: string,
  verdict: PouchApprovalVerdict,
): boolean {
  const waiter = waiters.get(approvalId);
  if (!waiter) return false;
  waiters.delete(approvalId);
  clearTimeout(waiter.timer);
  waiter.resolve(verdict);
  return true;
}

/** Test-only: drop waiters so suites do not leak timers. */
export function resetPouchApprovalsForTest(): void {
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve({ id: '' });
  }
  waiters.clear();
}
