/**
 * Route `canUseTool` from the Claude Agent SDK into Shepaw UI components.
 *
 * - `AskUserQuestion` → one `ui.singleSelect` / `ui.multiSelect` per question
 * - every other tool → one `ui.actionConfirmation`
 *
 * Responses from the phone come back via `agent.submitResponse` and are
 * resolved by `ctx.waitForResponse()` in the base SDK.
 */

import type { TaskContext } from 'shepaw-acp-sdk';

import { log } from './debug.js';
import { summarizeToolInput } from './tool-summary.js';

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

// ── Agent SDK permission result (narrow to what we return) ──────────

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

// ── public API ──────────────────────────────────────────────────────

export interface MakeCanUseToolOptions {
  /** Per-tool approval timeout. Default 5 min. */
  approvalTimeoutMs?: number;
  /** Per-question timeout for AskUserQuestion. Default 10 min. */
  questionTimeoutMs?: number;
  /**
   * If provided, values returned from the Shepaw app for
   * `sendActionConfirmation` are interpreted as: any of these allows the
   * tool to run; anything else denies.
   *
   * Default: `['allow', 'allow_always', 'y', 'yes']`.
   */
  allowValues?: ReadonlySet<string>;
}

const DEFAULT_ALLOW_VALUES: ReadonlySet<string> = new Set([
  'allow',
  'allow_always',
  'y',
  'yes',
]);

/** Build a `canUseTool` callback that proxies every approval to the phone. */
export function makeCanUseTool(ctx: TaskContext, opts: MakeCanUseToolOptions = {}) {
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 5 * 60_000;
  const questionTimeoutMs = opts.questionTimeoutMs ?? 10 * 60_000;
  const allowValues = opts.allowValues ?? DEFAULT_ALLOW_VALUES;

  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestion(ctx, input as unknown as AskUserQuestionInput, {
        questionTimeoutMs,
      });
    }

    const summary = summarizeToolInput(toolName, input);
    log.gateway('permission request: %s — %s', toolName, summary.slice(0, 80));

    const confirmId = await ctx.sendActionConfirmation({
      prompt: buildPrompt(toolName, summary),
      actions: [
        { label: 'Allow', value: 'allow' },
        { label: 'Allow & remember', value: 'allow_always' },
        { label: 'Deny', value: 'deny' },
      ],
    });

    let response: Record<string, unknown>;
    try {
      response = await ctx.waitForResponse(confirmId, { timeoutMs: approvalTimeoutMs });
    } catch (err) {
      return { behavior: 'deny', message: `Approval failed: ${String(err)}` };
    }

    const rawValue =
      typeof response.value === 'string'
        ? (response.value as string)
        : typeof response.action === 'string'
          ? (response.action as string)
          : '';
    const value = rawValue.toLowerCase();

    if (allowValues.has(value)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: 'User denied this action' };
  };
}

// ── AskUserQuestion handler ─────────────────────────────────────────

async function handleAskUserQuestion(
  ctx: TaskContext,
  input: AskUserQuestionInput,
  opts: { questionTimeoutMs: number },
): Promise<PermissionDecision> {
  const answers: Record<string, string> = {};

  for (const q of input.questions ?? []) {
    const uiOptions = q.options.map((o) => ({
      label: o.label,
      value: o.label,
      description: o.description,
    }));

    const selectId = q.multiSelect
      ? await ctx.sendMultiSelect({
          prompt: q.question,
          options: uiOptions,
          minSelect: 1,
        })
      : await ctx.sendSingleSelect({
          prompt: q.question,
          options: uiOptions,
        });

    let response: Record<string, unknown>;
    try {
      response = await ctx.waitForResponse(selectId, { timeoutMs: opts.questionTimeoutMs });
    } catch (err) {
      return { behavior: 'deny', message: `Question timed out: ${String(err)}` };
    }

    answers[q.question] = extractAnswer(response, Boolean(q.multiSelect));
  }

  return {
    behavior: 'allow',
    updatedInput: {
      questions: input.questions,
      answers,
    },
  };
}

function extractAnswer(response: Record<string, unknown>, multi: boolean): string {
  if (multi) {
    const values = response.values;
    if (Array.isArray(values)) {
      return values.filter((v): v is string => typeof v === 'string').join(', ');
    }
    const value = response.value;
    return typeof value === 'string' ? value : '';
  }
  const value = response.value;
  if (typeof value === 'string') return value;
  const label = response.label;
  return typeof label === 'string' ? label : '';
}

function buildPrompt(toolName: string, summary: string): string {
  if (!summary) return `Claude wants to use ${toolName}`;
  return `Claude wants to use \`${toolName}\`:\n${summary}`;
}
