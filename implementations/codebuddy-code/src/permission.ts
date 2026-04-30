/**
 * Route `canUseTool` from the CodeBuddy Agent SDK into Shepaw UI components.
 *
 * Async-confirmation flow (default):
 *   - On cache miss, fire `ui.actionConfirmation` to the phone, record a
 *     `PendingMarker` (toolName + input + cid), and IMMEDIATELY return
 *     `deny` to the SDK. The SDK injects a `tool_result: error` and the
 *     assistant turn ends naturally — the user's phone sees
 *     `task.completed`, no "loading..." spinner.
 *   - The user taps Allow / Deny (in-band `submitResponse`) or types an
 *     approval keyword in a new chat message.
 *   - `onChat` observes the pending marker + verdict, populates the
 *     `ApprovalCache` with the verdict, and re-runs the SDK via `--resume`
 *     with a prompt that asks the model to retry. On that retry the
 *     cache short-circuits `canUseTool` and the tool actually executes.
 *
 * Trade-off vs. the old blocking flow:
 *   + Mobile-friendly: user can close the app between ask and reply.
 *   + No open TCP sockets or task_id races while we wait for input.
 *   - One extra LLM call per approval (the retry turn). Worth it.
 *
 * `AskUserQuestion` keeps the old blocking model for now — it carries a
 * free-form reply (not a boolean), which is harder to replay through the
 * approval cache. Follow-up: make it async too by staging the form answer
 * as an `updatedInput` and using `--resume` with a custom system prompt.
 *
 * Cache hits still short-circuit immediately; they're the whole point of
 * the retry turn, after all.
 */

import type { TaskContext } from 'shepaw-acp-sdk';

import { ApprovalCache } from './approval-cache.js';
import { log } from './debug.js';
import {
  PendingConfirmations,
  type PermissionDecision,
} from './pending-confirmations.js';
import type { PendingMarkerStore } from './pending-marker.js';
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
  /** In-flight confirmation tracker — used by the legacy blocking path for AskUserQuestion. */
  pending: PendingConfirmations;
  /** Persistent store of "session has a pending tool_use waiting for user approval". */
  pendingMarker: PendingMarkerStore;
}

const DENY_MESSAGE_USER = 'User denied this action.';

/** Message returned to the SDK when we defer a tool_use to the user. */
const DEFER_MESSAGE =
  'This action needs user approval. A confirmation prompt has been sent to the user. ' +
  'End this turn — the user will respond in a follow-up message, at which point we will ' +
  'resume the session and re-attempt the call if approved.';

interface CanUseToolOptions {
  signal: AbortSignal;
}

/**
 * Build a `canUseTool` callback.
 *
 * Flow per call:
 *   1. If `toolName === 'AskUserQuestion'` → legacy blocking path (form UI).
 *   2. Cache hit → return cached verdict immediately. (Used by the retry
 *      turn after an async approval: the cache says "yes this tool+input
 *      was approved".)
 *   3. Cache miss → send `ui.actionConfirmation`, record a `PendingMarker`,
 *      return deny. The SDK terminates the turn shortly after.
 */
export function makeCanUseTool(ctx: TaskContext, opts: MakeCanUseToolOptions) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    sdkOpts: CanUseToolOptions,
  ): Promise<PermissionDecision> {
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestion(
        ctx,
        opts,
        sdkOpts,
        input as unknown as AskUserQuestionInput,
      );
    }

    // Cache hit → short-circuit.
    const cached = opts.cache.get(opts.sessionId, toolName, input);
    if (cached === 'allow') {
      log.gateway('approval cache HIT for %s — allowing', toolName);
      return { behavior: 'allow', updatedInput: input };
    }
    if (cached === 'deny') {
      log.gateway('approval cache HIT for %s — denying', toolName);
      return { behavior: 'deny', message: DENY_MESSAGE_USER };
    }

    // Cache miss → emit confirmation and defer.
    const summary = summarizeToolInput(toolName, input);
    const displayPrompt = buildPrompt(toolName, summary);
    log.gateway(
      'permission request: %s — %s (deferring; user will respond in a follow-up turn)',
      toolName,
      summary.slice(0, 80),
    );

    const cid = await ctx.sendActionConfirmation({
      prompt: displayPrompt,
      actions: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
      ],
    });

    // Record the pending approval persistently so `onChat` can resolve it
    // even across gateway restarts. Note: we only keep ONE pending marker
    // per session at a time. If there were somehow two concurrent
    // canUseTool calls in the same session (shouldn't happen under normal
    // SDK use — turns are serial), the later one overwrites the earlier.
    opts.pendingMarker.set(opts.sessionId, {
      toolName,
      input,
      cid,
      displayPrompt,
      requestedAtMs: Date.now(),
    });

    // Respect task cancellation: if the whole turn was aborted (e.g. the
    // user explicitly stopped the task), settle as deny without expecting
    // a follow-up.
    if (sdkOpts.signal.aborted) {
      opts.pendingMarker.delete(opts.sessionId);
      return { behavior: 'deny', message: 'Task cancelled.' };
    }

    return { behavior: 'deny', message: DEFER_MESSAGE };
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

  // Block until the user submits. Kept blocking for now because form
  // answers are free-form text — no simple "allow/deny" cache key. A
  // follow-up can make this async by storing the raw submission as an
  // `updatedInput` and re-running via --resume.
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
