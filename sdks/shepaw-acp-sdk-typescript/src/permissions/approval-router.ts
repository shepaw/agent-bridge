/**
 * Resolve a pending approval marker against an incoming chat message.
 *
 * This is the shared decision matrix that used to be duplicated in both
 * `implementations/<impl>/src/agent.ts` files. Pulling it into the SDK keeps
 * the two implementations trivially symmetric — they each call
 * `resolvePendingApproval` and only differ in the concrete SDK types
 * wrapped around the resume prompt they return.
 *
 * Decision table (inherited from the agent.ts comments):
 *
 *   pending?                   message kind          action
 *   ─────────────────────────  ────────────────────  ──────────────────────────────
 *   MARKER(tool_use)           verdict=allow, once   ApprovalCache.set('allow'),
 *                                                    drop marker, resume with
 *                                                    "retry it" prompt
 *   MARKER(tool_use)           verdict=allow, all    PatternRuleStore.addSession,
 *                                                    drop marker, resume with
 *                                                    "retry it (and similar)"
 *   MARKER(tool_use)           verdict=deny,  once   ApprovalCache.set('deny'),
 *                                                    drop marker, resume with
 *                                                    "don't retry" prompt
 *   MARKER(tool_use)           verdict=deny,  all    PatternRuleStore.addSession,
 *                                                    drop marker, resume with
 *                                                    "don't retry (and similar)"
 *   MARKER(AskUserQuestion)    "Form submitted: …"   stage answers, drop marker,
 *                                                    resume with "user answered"
 *   MARKER(AskUserQuestion)    verdict=deny          drop marker, resume with
 *                                                    "user declined to answer"
 *   MARKER(*)                  anything else         leave marker; caller treats
 *                                                    the message as a fresh user
 *                                                    message
 *   NONE                       anything              no-op (caller opens a new
 *                                                    query as usual)
 *
 * Invariant: at most one MARKER per session.
 */

import type { ApprovalCache } from './approval-cache.js';
import type { ApprovalClassification } from './approval-keywords.js';
import { deriveRule, type PatternRuleStore } from './pattern-rules.js';
import type { PendingMarkerStore } from './pending-marker.js';
import type { FormAnswerStage } from './permission-core.js';
import { log } from './log.js';

export interface ResolvePendingApprovalParams {
  sessionId: string;
  /** The raw `agent.chat` message. Used verbatim for logs and cache metadata. */
  message: string;
  /** Whether `message` starts with the form-submission marker. */
  isFormSubmission: boolean;
  /**
   * Form-submission marker prefix (e.g. `"Form submitted:"`). Kept as a
   * parameter so both implementations share a single definition without
   * the SDK hard-coding it.
   */
  formSubmissionPrefix: string;
  /**
   * `undefined` when the message isn't obviously an approval reply
   * (fresh user message) OR when it IS a form submission. Callers MUST
   * suppress classification for form submissions — otherwise a form
   * answer that happens to contain "allow" would be misread.
   */
  classification: ApprovalClassification | undefined;

  approvalCache: ApprovalCache;
  pendingMarker: PendingMarkerStore;
  patternRules: PatternRuleStore;
  formAnswers: FormAnswerStage;
}

export interface ResolvePendingApprovalResult {
  /**
   * The message to feed to the SDK as the prompt for the next turn.
   * Equal to `params.message` when no marker logic applied (i.e. the
   * caller should just pass the user's text through).
   */
  promptMessage: string;
}

export function resolvePendingApproval(
  p: ResolvePendingApprovalParams,
): ResolvePendingApprovalResult {
  const marker = p.pendingMarker.get(p.sessionId);
  let promptMessage = p.message;
  if (marker === undefined) return { promptMessage };

  const isAskUserQuestionMarker = marker.toolName === 'AskUserQuestion';
  const verdict = p.classification?.verdict;
  const scope = p.classification?.scope ?? 'once';

  if (isAskUserQuestionMarker && p.isFormSubmission) {
    // Stage the user's raw form-submission text under
    // `updatedInput.answers._raw` so the next `--resume` turn's
    // `canUseTool(AskUserQuestion)` returns `{allow, updatedInput}` and
    // the SDK treats the tool as having executed successfully.
    const rawAnswers = p.message.slice(p.formSubmissionPrefix.length).trim();
    p.formAnswers.set(p.sessionId, {
      toolName: 'AskUserQuestion',
      updatedInput: {
        ...marker.input,
        answers: { _raw: rawAnswers },
      },
      stagedAtMs: Date.now(),
    });
    p.pendingMarker.delete(p.sessionId);
    log.gateway(
      'AskUserQuestion form answer staged (session=%s, %d chars); resuming SDK',
      p.sessionId,
      rawAnswers.length,
    );
    promptMessage =
      'The user answered the clarifying questions. Please continue based on their input.';
    return { promptMessage };
  }

  if (isAskUserQuestionMarker && verdict === 'deny') {
    // User explicitly declined to answer. Drop without staging;
    // canUseTool on resume will send another form OR the model gives
    // up. The explicit-decline prompt nudges the model towards the
    // latter rather than looping forever.
    p.formAnswers.delete(p.sessionId);
    p.pendingMarker.delete(p.sessionId);
    log.gateway(
      'AskUserQuestion declined by user (session=%s); resuming SDK with decline prompt',
      p.sessionId,
    );
    promptMessage =
      'The user declined to answer the clarifying questions. Please proceed with a reasonable default or move on.';
    return { promptMessage };
  }

  if (!isAskUserQuestionMarker && (verdict === 'allow' || verdict === 'deny')) {
    // Tool-use marker + allow/deny verdict. Two sub-cases by scope:
    //   'once'    → one-shot cache entry for this exact input
    //   'pattern' → persistent rule covering the whole derived family
    //               (e.g. `Bash npm install *`). The user sees a single
    //               "Allow All Similar" tap; every future call of that
    //               family short-circuits in `canUseTool` via the
    //               PatternRuleStore, no cache entry needed.
    if (scope === 'pattern') {
      const { permission, pattern } = deriveRule(marker.toolName, marker.input);
      p.patternRules.addSession(p.sessionId, {
        permission,
        pattern,
        action: verdict,
        createdAtMs: Date.now(),
      });
      log.gateway(
        'async-confirmation %s ALL SIMILAR for %s (%s %s, session=%s); resuming SDK',
        verdict,
        marker.toolName,
        permission,
        pattern,
        p.sessionId,
      );
    } else {
      p.approvalCache.set(
        p.sessionId,
        marker.toolName,
        marker.input,
        verdict,
        marker.displayPrompt,
        p.message,
      );
      log.gateway(
        'async-confirmation %s for %s (session=%s); resuming SDK with synthetic prompt',
        verdict,
        marker.toolName,
        p.sessionId,
      );
    }
    p.pendingMarker.delete(p.sessionId);

    // The resume prompt tells the model whether the approval was
    // one-shot or blanket; the latter phrasing nudges it to stop
    // asking for the same family again rather than defensively
    // re-confirming next time.
    if (verdict === 'allow') {
      promptMessage =
        scope === 'pattern'
          ? `The user approved the previous \`${marker.toolName}\` request and all similar future calls. Please retry it now.`
          : `The user approved the previous \`${marker.toolName}\` request. Please retry it now.`;
    } else {
      promptMessage =
        scope === 'pattern'
          ? `The user denied the previous \`${marker.toolName}\` request and all similar future calls. Please acknowledge the denial and do not retry.`
          : `The user denied the previous \`${marker.toolName}\` request. Please acknowledge the denial and do not retry.`;
    }
    return { promptMessage };
  }

  // Non-verdict, non-form-submission message while a marker is live —
  // leave the marker in place; the user may still respond later.
  log.gateway(
    'non-verdict message while pendingMarker is live (session=%s, tool=%s); keeping marker and opening new query',
    p.sessionId,
    marker.toolName,
  );
  return { promptMessage };
}
