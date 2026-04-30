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
 * All matching is case-insensitive and tolerant of whitespace.
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
 * matching the derived pattern". Matched anywhere in the message, so
 * "allow all npm" and "deny all similar" both trigger scope='pattern'.
 *
 * The English tokens are lowercased and substring-matched like the
 * allow/deny sets above; the Chinese tokens work by raw `includes`
 * against the trimmed (non-lowercased) original message so CJK case
 * folding isn't a concern.
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
  const lower = trimmed.toLowerCase();

  const hasAllow = ALLOW_TOKENS.some((tok) => lower.includes(tok));
  const hasDeny = DENY_TOKENS.some((tok) => lower.includes(tok));

  let verdict: ApprovalVerdict;
  if (hasDeny) {
    verdict = 'deny';
  } else if (hasAllow) {
    verdict = 'allow';
  } else {
    return undefined;
  }

  // Scope detection: check lowered message for ASCII tokens and the
  // raw (trimmed) message for CJK tokens. `some` is fine either way —
  // `includes` ignores case for ASCII after lowercasing, and CJK is
  // caseless.
  const hasAlways = ALWAYS_TOKENS.some((tok) => lower.includes(tok) || trimmed.includes(tok));
  const scope: ApprovalScope = hasAlways ? 'pattern' : 'once';

  return { verdict, scope };
}

export { ALLOW_TOKENS, DENY_TOKENS, ALWAYS_TOKENS };
