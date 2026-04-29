/**
 * Route `canUseTool` from the CodeBuddy Agent SDK into Shepaw UI components.
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
 *     submission. Same round-trip as above; the answers come back in a
 *     follow-up chat message ("Form submitted: ..."). See
 *     `FORM_SUBMISSION_PREFIXES` in agent.ts for how we identify it.
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

// ── AskUserQuestion input shape (per CodeBuddy Agent SDK types) ─────

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

    // Cache hit → allow/deny immediately without asking again.
    const cached = opts.cache.get(opts.sessionId, toolName, input);
    if (cached === 'allow') {
      log.gateway('approval cache HIT for %s — allowing', toolName);
      return { behavior: 'allow', updatedInput: input };
    }
    if (cached === 'deny') {
      log.gateway('approval cache HIT for %s — denying', toolName);
      return { behavior: 'deny', message: DENY_MESSAGE_USER };
    }

    // Cache miss → send a confirmation and block until the user replies.
    const summary = summarizeToolInput(toolName, input);
    const displayPrompt = buildPrompt(toolName, summary);
    log.gateway('permission request: %s — %s (waiting)', toolName, summary.slice(0, 80));

    const cid = await ctx.sendActionConfirmation({
      prompt: displayPrompt,
      actions: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
      ],
    });

    // Race two reply paths:
    //   (A) legacy chat-verdict: user types "allow"/"deny" as a new chat
    //       message. `onChat` calls `pendingConfirmations.resolveAll(...)`
    //       which settles our `wait()`.
    //   (B) in-band `agent.submitResponse` carrying `confirmation_id=cid`.
    //       SDK's `handleSubmitResponse` resolves the `pendingResponses`
    //       deferred, which `ctx.waitForResponse(cid)` returns.
    //
    // Path B is preferred — it keeps the reply on the same task_id as the
    // outstanding SDK turn, so the Shepaw app doesn't have to open a fresh
    // task (which would race the existing taskCompleter and show an
    // empty "Task completed" placeholder). Path A is kept because older
    // apps / test harnesses still rely on sending the verdict as chat text.
    //
    // NB: when B wins, we still have an entry parked in
    // `opts.pending.bySession[sessionId]`. If we leave it there, the *next*
    // ordinary chat message from the user would trip `hasPending=true` in
    // `onChat` and get swallowed as a stale verdict. So on B-wins we clear
    // the pending list explicitly — with 'allow' so any in-flight A-branch
    // observer sees a matching verdict rather than a deny surprise.
    const waitForChat = opts.pending.wait({
      sessionId: opts.sessionId,
      toolName,
      input,
      displayPrompt,
      signal: sdkOpts.signal,
    });
    const waitForInBand = ctx
      .waitForResponse(cid)
      .then<PermissionDecision>((resp) => {
        // The Shepaw app's action-confirmation widget reads `id` off the
        // action list and reports it back as `selected_action_id`. Our
        // outbound actions (see the `sendActionConfirmation` call above)
        // set `value: 'allow' | 'deny'`, NOT `id`, so older apps end up
        // posting `selected_action_id: ''` with the human label in
        // `selected_action_label`. Accept both shapes: normalise every
        // known field to lowercase and look for an allow-ish keyword.
        const candidates: string[] = [];
        for (const key of ['selected_action_id', 'selected_action_label'] as const) {
          const v = resp[key];
          if (typeof v === 'string' && v.length > 0) candidates.push(v.toLowerCase());
        }
        const text = candidates.join(' ');
        const looksAllow = /\b(allow|approve|approved|yes|ok|confirm)\b/.test(text)
          || text.includes('同意')
          || text.includes('允许')
          || text.includes('确认')
          || text.includes('确定');
        const verdict: PermissionDecision = looksAllow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: DENY_MESSAGE_USER };
        // Drain the chat-verdict queue so the next unrelated user message
        // isn't misread as a stale confirmation reply.
        opts.pending.resolveAll(opts.sessionId, looksAllow ? 'allow' : 'deny');
        return verdict;
      })
      // `waitForResponse` throws on timeout; convert to a pending Promise
      // (never settles) so the other branch wins if chat-verdict arrives.
      .catch(() => new Promise<PermissionDecision>(() => {}));

    const decision = await Promise.race([waitForChat, waitForInBand]);
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
  // Pack all questions into a single ui.form — each question becomes a
  // radio_group or checkbox_group field.
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
    description: 'CodeBuddy needs your input to continue.',
    fields,
  });

  // Block until the user submits — resolved with 'allow' when onChat
  // sees the form submission message. The raw answer text is what
  // comes back in the follow-up chat turn; for now we simply allow so
  // the SDK ends this AskUserQuestion call cleanly, and the answers
  // flow to the model as the next user message.
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
  if (!summary) return `CodeBuddy wants to use ${toolName}`;
  return `CodeBuddy wants to use \`${toolName}\`:\n${summary}`;
}
