/**
 * Session-scoped approval cache.
 *
 * Non-blocking flow:
 *   1. CodeBuddy tries to use a tool → `canUseTool` callback fires.
 *   2. Cache miss → gateway sends `ui.actionConfirmation` to Shepaw AND
 *      immediately returns `{ behavior: 'deny', message: 'waiting for approval' }`
 *      to the SDK so the current turn ends.
 *   3. User taps "Allow" in Shepaw later → Shepaw sends a new
 *      `agent.chat` message like "用户同意 Bash: npm test".
 *   4. `CodeBuddyCodeAgent.onChat` detects the approval keyword and writes
 *      `{tool: 'Bash', inputHash: ...} → 'allow'` into this cache.
 *   5. The chat also forwards the user message to CodeBuddy, which retries
 *      the same tool call. `canUseTool` consults the cache first; if
 *      the entry is present and still fresh, it returns `allow`.
 *
 * Entries expire after `ttlMs` (default 20 min) so a user can't
 * accidentally pre-approve operations they'd want to review again.
 */

import { createHash } from 'node:crypto';

export type ApprovalDecision = 'allow' | 'deny';

interface Entry {
  decision: ApprovalDecision;
  /** The human-readable prompt we showed the user — kept for debugging. */
  displayPrompt: string;
  /** The user's message that granted/denied this approval. */
  sourceMessage: string;
  expiresAt: number;
}

export interface ApprovalCacheOptions {
  /** Time-to-live for each entry in milliseconds. Default 20 minutes. */
  ttlMs?: number;
}

export class ApprovalCache {
  private readonly ttlMs: number;
  /** (sessionId → (toolSignatureHash → Entry)) */
  private readonly bySession = new Map<string, Map<string, Entry>>();

  constructor(opts: ApprovalCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 20 * 60 * 1000;
  }

  /**
   * Look up a pre-existing decision for `(toolName, input)` in this session.
   * Returns `undefined` if nothing is stored or the entry has expired.
   */
  get(sessionId: string, toolName: string, input: unknown): ApprovalDecision | undefined {
    const bucket = this.bySession.get(sessionId);
    if (bucket === undefined) return undefined;
    const key = signatureKey(toolName, input);
    const entry = bucket.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      bucket.delete(key);
      return undefined;
    }
    return entry.decision;
  }

  set(
    sessionId: string,
    toolName: string,
    input: unknown,
    decision: ApprovalDecision,
    displayPrompt: string,
    sourceMessage: string,
  ): void {
    let bucket = this.bySession.get(sessionId);
    if (bucket === undefined) {
      bucket = new Map<string, Entry>();
      this.bySession.set(sessionId, bucket);
    }
    bucket.set(signatureKey(toolName, input), {
      decision,
      displayPrompt,
      sourceMessage,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Number of live entries in a session (expired entries are counted only until cleared). */
  size(sessionId: string): number {
    const bucket = this.bySession.get(sessionId);
    if (bucket === undefined) return 0;
    return bucket.size;
  }

  /** Drop all entries for a session (e.g. when the session ends). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/**
 * Stable 160-bit key derived from the tool name and a sorted JSON
 * serialisation of its input. Two calls with equivalent inputs map
 * to the same key even if key ordering differs.
 */
function signatureKey(toolName: string, input: unknown): string {
  const canonical = canonicalJson(input);
  return createHash('sha1').update(`${toolName}\u0000${canonical}`).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

// ── Pending-approval tracker ─────────────────────────────────────────
//
// Per-session ordered list of outstanding confirmations. When a user
// message comes in and matches an "approval keyword" but doesn't
// explicitly name which tool, we resolve against the most recent pending
// confirmation in the session.

export interface PendingApproval {
  toolName: string;
  input: Record<string, unknown>;
  displayPrompt: string;
  /** When this confirmation was sent (ms epoch). */
  requestedAt: number;
}

export class PendingApprovals {
  private readonly bySession = new Map<string, PendingApproval[]>();

  push(sessionId: string, approval: PendingApproval): void {
    let list = this.bySession.get(sessionId);
    if (list === undefined) {
      list = [];
      this.bySession.set(sessionId, list);
    }
    list.push(approval);
    // Keep only the last 10 to bound memory.
    if (list.length > 10) list.splice(0, list.length - 10);
  }

  /** Pop the most recent pending approval for a session, if any. */
  popMostRecent(sessionId: string): PendingApproval | undefined {
    const list = this.bySession.get(sessionId);
    if (list === undefined || list.length === 0) return undefined;
    return list.pop();
  }

  /**
   * Pop ALL pending approvals for a session, oldest first.
   *
   * Called when the user replies with an approval keyword — we apply
   * that verdict to every confirmation that's still in flight, so
   * multi-tool-call turns (e.g. CodeBuddy fires 3 different `git diff`
   * variants in one turn) don't leave zombie pendings that the user
   * would have to approve one-by-one.
   */
  popAll(sessionId: string): PendingApproval[] {
    const list = this.bySession.get(sessionId);
    if (list === undefined || list.length === 0) return [];
    this.bySession.set(sessionId, []);
    return list;
  }

  peekMostRecent(sessionId: string): PendingApproval | undefined {
    const list = this.bySession.get(sessionId);
    if (list === undefined || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
