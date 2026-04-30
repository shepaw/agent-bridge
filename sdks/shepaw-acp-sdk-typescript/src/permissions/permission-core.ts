/**
 * Route `canUseTool` from an agent SDK (Claude Code, CodeBuddy Code, …)
 * into Shepaw UI components.
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
 * `AskUserQuestion` follows the same deny-and-resume pattern but uses a
 * **form-answer staging map** instead of a boolean cache: the user's raw
 * submission text is staged as `updatedInput.answers._raw`, and on the
 * resume turn the `canUseTool` for AskUserQuestion returns `{allow,
 * updatedInput}` so the model sees its own question plus the user's
 * free-form reply. Once consumed, the staged answer is cleared.
 *
 * Trade-off vs. the old blocking flow:
 *   + Mobile-friendly: user can close the app between ask and reply.
 *   + No open TCP sockets or task_id races while we wait for input.
 *   - One extra LLM call per approval (the retry turn). Worth it.
 *
 * Cache hits still short-circuit immediately; they're the whole point of
 * the retry turn, after all.
 */

import type { TaskContext } from '../task-context.js';

import { ApprovalCache } from './approval-cache.js';
import { log } from './log.js';
import {
  PendingConfirmations,
  type PermissionDecision,
} from './pending-confirmations.js';
import type { PendingMarkerStore } from './pending-marker.js';
import { summarizeToolInput } from './tool-summary.js';

export type { PermissionDecision };

// ── AskUserQuestion input shape (common to Claude / CodeBuddy SDKs) ──

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

// ── Form-answer staging ─────────────────────────────────────────────

/**
 * Staging slot for a pending AskUserQuestion answer. Keyed by session id;
 * one slot per session (the SDK only allows one AskUserQuestion in flight
 * per turn). Populated in `onChat` when a form submission arrives,
 * consumed on the next `--resume` turn by `canUseTool` for AskUserQuestion.
 */
export interface StagedFormAnswer {
  /** Tool name — always 'AskUserQuestion' today; kept for future form tools. */
  toolName: string;
  /** The exact `updatedInput` payload to pass back to the SDK. */
  updatedInput: Record<string, unknown>;
  /** Wall-clock when staged, for debug/telemetry. */
  stagedAtMs: number;
}

export class FormAnswerStage {
  private readonly map = new Map<string, StagedFormAnswer>();

  set(sessionId: string, answer: StagedFormAnswer): void {
    this.map.set(sessionId, answer);
  }

  /** Returns and removes the staged answer. Single-shot semantics. */
  consume(sessionId: string, toolName: string): StagedFormAnswer | undefined {
    const existing = this.map.get(sessionId);
    if (existing === undefined || existing.toolName !== toolName) return undefined;
    this.map.delete(sessionId);
    return existing;
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }
}

// ── public API ──────────────────────────────────────────────────────

export interface MakeCanUseToolOptions {
  /** Shepaw session the tool call belongs to — required for cache lookups. */
  sessionId: string;
  /** Cross-turn approval cache (allow/deny decisions that persist). */
  cache: ApprovalCache;
  /** In-flight confirmation tracker — kept for AskUserQuestion's blocking fallback (no longer used). */
  pending: PendingConfirmations;
  /** Persistent store of "session has a pending tool_use waiting for user approval". */
  pendingMarker: PendingMarkerStore;
  /** Staging slot for AskUserQuestion answers keyed by sessionId. */
  formAnswers: FormAnswerStage;
  /**
   * Human-readable agent name used in user-facing prompts, e.g. "Claude" or
   * "CodeBuddy". Appears as `"<agentDisplayName> wants to use Bash: npm test"`.
   */
  agentDisplayName: string;
}

const DENY_MESSAGE_USER = 'User denied this action.';

/** Message returned to the SDK when we defer a tool_use to the user. */
const DEFER_MESSAGE =
  'This action needs user approval. A confirmation prompt has been sent to the user. ' +
  'End this turn — the user will respond in a follow-up message, at which point we will ' +
  'resume the session and re-attempt the call if approved.';

/** Message for AskUserQuestion's initial deny — the model just waits for user input. */
const ASK_USER_DEFER_MESSAGE =
  'A question form has been sent to the user. End this turn — the user will answer in a ' +
  'follow-up message, at which point we will resume the session and re-attempt the call ' +
  'with the submitted answers populated.';

interface CanUseToolOptions {
  signal: AbortSignal;
}

/**
 * Build a `canUseTool` callback.
 *
 * Flow per call:
 *   1. If `toolName === 'AskUserQuestion'` → form-answer staging path:
 *      - Stage hit → return `{allow, updatedInput}` with the user's answers
 *        (single-shot: the staging slot is cleared on consume).
 *      - Stage miss → send `ui.form`, record a pendingMarker tagged `form`,
 *        return deny (the SDK turn ends, the user replies in a new message).
 *   2. Tool cache hit → return cached verdict immediately. (Used by the retry
 *      turn after an async approval: the cache says "yes this tool+input
 *      was approved".)
 *   3. Tool cache miss → send `ui.actionConfirmation`, record a
 *      `PendingMarker`, return deny.
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
        input,
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
    const displayPrompt = buildPrompt(opts.agentDisplayName, toolName, summary);
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

// ── AskUserQuestion (async form) ────────────────────────────────────

async function handleAskUserQuestion(
  ctx: TaskContext,
  opts: MakeCanUseToolOptions,
  sdkOpts: CanUseToolOptions,
  input: AskUserQuestionInput,
  rawInput: Record<string, unknown>,
): Promise<PermissionDecision> {
  // Stage hit? This is the --resume turn: the user already submitted the
  // form, `onChat` staged the answer, now we hand it back to the SDK so
  // the AskUserQuestion tool "executes" successfully with those answers.
  const staged = opts.formAnswers.consume(opts.sessionId, 'AskUserQuestion');
  if (staged !== undefined) {
    log.gateway(
      'AskUserQuestion form-answer stage HIT — passing user answers back to SDK (session=%s)',
      opts.sessionId,
    );
    return {
      behavior: 'allow',
      updatedInput: staged.updatedInput,
    };
  }

  // Stage miss — fresh ask. Pack all questions into a single ui.form.
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

  const formId = await ctx.sendForm({
    title: 'Clarifying questions',
    description: `${opts.agentDisplayName} needs your input to continue.`,
    fields,
  });

  // Record a pending marker tagged as a form so `onChat` knows to stage
  // the user's form-submission answer into `FormAnswerStage` rather than
  // `ApprovalCache`. Persisted to disk so the exchange survives gateway
  // restart — on re-entry, the marker is still there and the next chat
  // message that arrives (form submission or keyword verdict) resolves it.
  opts.pendingMarker.set(opts.sessionId, {
    toolName: 'AskUserQuestion',
    input: rawInput,
    cid: formId,
    displayPrompt: 'Clarifying questions form',
    requestedAtMs: Date.now(),
  });

  if (sdkOpts.signal.aborted) {
    opts.pendingMarker.delete(opts.sessionId);
    return { behavior: 'deny', message: 'Task cancelled.' };
  }

  log.gateway(
    'AskUserQuestion: sent ui.form, deferring turn (session=%s, formId=%s)',
    opts.sessionId,
    formId,
  );
  return { behavior: 'deny', message: ASK_USER_DEFER_MESSAGE };
}

// ── helpers ─────────────────────────────────────────────────────────

function buildPrompt(agentDisplayName: string, toolName: string, summary: string): string {
  if (!summary) return `${agentDisplayName} wants to use ${toolName}`;
  return `${agentDisplayName} wants to use \`${toolName}\`:\n${summary}`;
}
