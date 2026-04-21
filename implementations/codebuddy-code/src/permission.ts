/**
 * Route `canUseTool` from the CodeBuddy Agent SDK into Shepaw UI components.
 *
 * Non-blocking flow:
 *   - On cache miss, fire-and-forget a `ui.actionConfirmation` to the
 *     phone, record the pending approval, and DENY the tool call so
 *     CodeBuddy ends the current turn. When the user replies later, the
 *     agent's `onChat` writes the verdict into `ApprovalCache` and
 *     forwards the message to CodeBuddy, which retries the tool call;
 *     this time the cache hit short-circuits to ALLOW.
 *   - `AskUserQuestion` → fire-and-forget `ui.form` (with
 *     `radio_group` / `checkbox_group` fields) and also DENY so the
 *     current turn ends. When the user fills in the form Shepaw sends
 *     a plain-text message ("用户选择了 TypeScript") which CodeBuddy
 *     picks up on the next turn.
 */

import type { TaskContext } from 'shepaw-acp-sdk';

import {
  ApprovalCache,
  PendingApprovals,
} from './approval-cache.js';
import { log } from './debug.js';
import { summarizeToolInput } from './tool-summary.js';

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

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
  /** Shared approval cache (per-agent). */
  cache: ApprovalCache;
  /** Shared pending-approvals tracker (per-agent). */
  pending: PendingApprovals;
}

const DENY_MESSAGE_PENDING =
  "Waiting on the user to approve this exact tool call on their phone. " +
  "Do NOT retry with different arguments, do NOT paraphrase, do NOT try a " +
  "workaround. End this turn immediately with a short message like " +
  "'waiting for approval' — when the user replies I will re-issue the " +
  "identical tool call and it will succeed.";
const DENY_MESSAGE_QUESTION_SENT =
  "I've sent a form to the user on their phone to gather the clarification. " +
  "End this turn now; their reply will arrive as the next user message.";
const DENY_MESSAGE_USER = 'User denied this action.';

/**
 * Build a `canUseTool` callback that proxies every approval to the phone
 * in a non-blocking way (see module docstring).
 */
export function makeCanUseTool(ctx: TaskContext, opts: MakeCanUseToolOptions) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestion(ctx, input as unknown as AskUserQuestionInput);
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

    // Cache miss → fire-and-forget a confirmation and DENY so the turn ends.
    const summary = summarizeToolInput(toolName, input);
    const displayPrompt = buildPrompt(toolName, summary);
    log.gateway('permission request: %s — %s', toolName, summary.slice(0, 80));

    await ctx.sendActionConfirmation({
      prompt: displayPrompt,
      actions: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' },
      ],
    });
    opts.pending.push(opts.sessionId, {
      toolName,
      input,
      displayPrompt,
      requestedAt: Date.now(),
    });

    return { behavior: 'deny', message: DENY_MESSAGE_PENDING };
  };
}

// ── AskUserQuestion (fire-and-forget form) ──────────────────────────

async function handleAskUserQuestion(
  ctx: TaskContext,
  input: AskUserQuestionInput,
): Promise<PermissionDecision> {
  // Pack all questions into a single ui.form — each question becomes a
  // radio_group or checkbox_group field. If there's only one question
  // the form has a single field; no UI change needed on the app side.
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

  return { behavior: 'deny', message: DENY_MESSAGE_QUESTION_SENT };
}

// ── helpers ─────────────────────────────────────────────────────────

function buildPrompt(toolName: string, summary: string): string {
  if (!summary) return `CodeBuddy wants to use ${toolName}`;
  return `CodeBuddy wants to use \`${toolName}\`:\n${summary}`;
}
