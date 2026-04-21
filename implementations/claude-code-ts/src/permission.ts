/**
 * Route `canUseTool` from the Claude Agent SDK into Shepaw UI components.
 *
 * Blocking flow:
 *   - On cache miss, fire `ui.actionConfirmation` to the phone and
 *     AWAIT the user's reply. The SDK's turn stays open. When the user
 *     taps Allow / Deny (or types an approval keyword in a new chat
 *     message) the onChat handler calls `pending.resolveAll(...)`, our
 *     Promise resolves, `canUseTool` returns, and the same SDK turn
 *     proceeds with the tool call. No retry, no second query(), no
 *     "deny and hope the model tries again" leakage.
 *   - `AskUserQuestion` → fire `ui.form` and AWAIT the user's form
 *     submission. Same round-trip; the answers come back in a
 *     follow-up chat message ("Form submitted: ...").
 *   - Cache hit (allow) → return immediately without a UI prompt.
 *   - Cache hit (deny) → return deny immediately.
 *   - Task cancel (abort signal) → any in-flight wait resolves to deny.
 */

import type { TaskContext } from 'shepaw-acp-sdk';

import { ApprovalCache } from './approval-cache.js';
import { log } from './debug.js';
import {
  PendingConfirmations,
  type PermissionDecision,
} from './pending-confirmations.js';
import { summarizeToolInput } from './tool-summary.js';

export type { PermissionDecision };

// ── AskUserQuestion input shape (per Claude Agent SDK docs) ─────────

interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

// ── public API ──────────────────────────────────────────────────────

export interface MakeCanUseToolOptions {
  /** Shepaw session the tool call belongs to — required for cache lookups. */
  sessionId: string;
  /** Cross-turn approval cache (allow/deny decisions that persist). */
  cache: ApprovalCache;
  /** In-flight confirmation tracker — await these from canUseTool. */
  pending: PendingConfirmations;
}

const DENY_MESSAGE_USER = 'User denied this action.';

interface CanUseToolOptions {
  signal: AbortSignal;
}

/**
 * Build a `canUseTool` callback that blocks the SDK turn until the
 * user replies on their phone.
 */
export function makeCanUseTool(ctx: TaskContext, opts: MakeCanUseToolOptions) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    sdkOpts: CanUseToolOptions,
  ): Promise<PermissionDecision> {
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestion(ctx, opts, sdkOpts, input as unknown as AskUserQuestionInput);
    }

    const cached = opts.cache.get(opts.sessionId, toolName, input);
    if (cached === 'allow') {
      log.gateway('approval cache HIT for %s — allowing', toolName);
      return { behavior: 'allow', updatedInput: input };
    }
    if (cached === 'deny') {
      log.gateway('approval cache HIT for %s — denying', toolName);
      return { behavior: 'deny', message: DENY_MESSAGE_USER };
    }

    const summary = summarizeToolInput(toolName, input);
    const displayPrompt = buildPrompt(toolName, summary);
    log.gateway('permission request: %s — %s (waiting)', toolName, summary.slice(0, 80));

    await ctx.sendActionConfirmation({
      prompt: displayPrompt,
      actions: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
      ],
    });

    const decision = await opts.pending.wait({
      sessionId: opts.sessionId,
      toolName,
      input,
      displayPrompt,
      signal: sdkOpts.signal,
    });
    log.gateway('permission resolved: %s — %s', toolName, decision.behavior);
    return decision;
  };
}

// ── AskUserQuestion (blocking form) ─────────────────────────────────

async function handleAskUserQuestion(
  ctx: TaskContext,
  opts: MakeCanUseToolOptions,
  sdkOpts: CanUseToolOptions,
  input: AskUserQuestionInput,
): Promise<PermissionDecision> {
  const fields = (input.questions ?? []).map((q, idx) => ({
    name:
      q.header !== undefined && q.header.length > 0 ? `q${idx}_${q.header}` : `q${idx}`,
    label: q.question,
    type: (q.multiSelect === true ? 'checkbox_group' : 'radio_group') as
      | 'checkbox_group'
      | 'radio_group',
    required: true,
    options: q.options.map((o) => ({
      label: o.label,
      value: o.label,
      description: o.description,
    })),
  }));

  await ctx.sendForm({
    title: 'Clarifying questions',
    description: 'Claude needs your input to continue.',
    fields,
  });

  const decision = await opts.pending.wait({
    sessionId: opts.sessionId,
    toolName: 'AskUserQuestion',
    input: input as unknown as Record<string, unknown>,
    displayPrompt: 'Clarifying questions form',
    signal: sdkOpts.signal,
  });
  log.gateway('AskUserQuestion resolved: %s', decision.behavior);
  return decision;
}

// ── helpers ─────────────────────────────────────────────────────────

function buildPrompt(toolName: string, summary: string): string {
  if (!summary) return `Claude wants to use ${toolName}`;
  return `Claude wants to use \`${toolName}\`:\n${summary}`;
}
