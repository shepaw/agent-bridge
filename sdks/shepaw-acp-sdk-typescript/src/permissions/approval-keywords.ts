/**
 * Heuristics for interpreting a user's chat message as a reply to a
 * pending `ui.actionConfirmation` or `ui.form`.
 *
 * The Shepaw app turns a tap on "Allow" / "Deny" / "Allow All Similar"
 * into a plain-text `agent.chat` message — e.g. "Allow", "Deny", or
 * "用户同意执行 Bash: npm test"; the user can also hand-type messages
 * like "allow all npm" or "拒绝所有 git". We classify that message
 * into two axes:
 *
 *   - `verdict`: `'allow'` or `'deny'` — the decision itself
 *   - `scope`:   `'once'` or `'pattern'` — whether it's for this one
 *                tool call (the exact-hash cache) or for every call
 *                that matches the derived pattern (the rule store)
 *
 * If the match is ambiguous we bias towards `'deny'` — better to
 * re-prompt than to run a command the user didn't actually want.
 *
 * Matching strategy
 * -----------------
 * ASCII tokens use whole-word matching (regex \b boundaries) so that
 * short tokens like "all" or "no" cannot accidentally fire as substrings
 * of longer words (e.g. "allow" contains "all", "know" contains "no").
 * CJK tokens use plain `includes` because CJK text has no word-boundary
 * concept and the tokens themselves are unambiguous multi-character
 * sequences.
 */

const ALLOW_TOKENS: readonly string[] = [
  'allow',
  'approve',
  'approved',
  'yes',
  'ok',
  'okay',
  'sure',
  'confirm',
  'confirmed',
  'submit',
  'submitted',
  'go ahead',
  '同意',
  '允许',
  '通过',
  '好的',
  '可以',
  '行',
  '是',
  '批准',
  '确认',
  '确定',
  '提交',
];

const DENY_TOKENS: readonly string[] = [
  'deny',
  'denied',
  'no',
  'cancel',
  'reject',
  'rejected',
  'stop',
  '拒绝',
  '不允许',
  '不同意',
  '不行',
  '否',
  '取消',
];

/**
 * Tokens that escalate the scope from "this one call" to "every call
 * matching the derived pattern". Matched anywhere in the message with
 * whole-word semantics (for ASCII) so that "allow" does not trigger
 * scope='pattern' via the substring "all".
 */
const ALWAYS_TOKENS: readonly string[] = [
  'all',
  'always',
  'every',
  'similar',
  'all similar',
  '所有',
  '每次',
  '总是',
  '同类',
  '全部',
];

/** A user's reply to a pending confirmation, split along two axes. */
export type ApprovalVerdict = 'allow' | 'deny';
export type ApprovalScope = 'once' | 'pattern';

export interface ApprovalClassification {
  /** Did the user approve or decline? */
  verdict: ApprovalVerdict;
  /**
   * Did the user want this decision to apply only to the exact
   * pending call (`'once'`), or to every similar future call
   * (`'pattern'`)? Triggered by words like "all", "always", "similar",
   * "所有", "同类", etc.
   */
  scope: ApprovalScope;
}

/**
 * Returns true when `token` appears as a standalone word in `text`.
 *
 * - ASCII tokens: matched with \b word-boundary anchors (case-insensitive).
 *   This prevents short tokens like "all" or "no" from firing as
 *   substrings of longer words ("allow", "know", "another").
 * - CJK tokens: matched with plain `includes` — CJK text has no
 *   word-boundary concept and CJK token strings are inherently
 *   unambiguous multi-character sequences.
 *
 * `text` should already be lowercased by the caller for ASCII tokens
 * (the regex flag handles that redundantly, but callers own casing).
 */
function tokenMatches(text: string, token: string): boolean {
  // Detect CJK by checking the first character's code point.
  const isCjk = token.length > 0 && token.charCodeAt(0) > 0x2e7f;
  if (isCjk) return text.includes(token);
  // Escape regex metacharacters in the token (e.g. spaces in "all similar",
  // "go ahead") then wrap with word boundaries.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Classify a user's reply to a pending confirmation.
 *
 * Returns `undefined` if the message doesn't obviously look like an
 * approval verdict; the agent should then treat it as a fresh user
 * message rather than a response to a confirmation.
 */
export function classifyApprovalMessage(
  message: string,
): ApprovalClassification | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;

  const hasAllow = ALLOW_TOKENS.some((tok) => tokenMatches(trimmed, tok));
  const hasDeny = DENY_TOKENS.some((tok) => tokenMatches(trimmed, tok));

  let verdict: ApprovalVerdict;
  if (hasDeny) {
    verdict = 'deny';
  } else if (hasAllow) {
    verdict = 'allow';
  } else {
    return undefined;
  }

  const hasAlways = ALWAYS_TOKENS.some((tok) => tokenMatches(trimmed, tok));
  const scope: ApprovalScope = hasAlways ? 'pattern' : 'once';

  return { verdict, scope };
}

export { ALLOW_TOKENS, DENY_TOKENS, ALWAYS_TOKENS };
