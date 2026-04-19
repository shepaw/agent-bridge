/**
 * Heuristics for interpreting a user's chat message as a reply to a
 * pending `ui.actionConfirmation` or `ui.form`.
 *
 * The Shepaw app turns a tap on "Allow" / "Deny" into a plain-text
 * `agent.chat` message (e.g. "用户同意执行 Bash: npm test" or
 * "Deny"). We classify that message by keyword match; if the match is
 * ambiguous we bias towards "deny" — better to re-prompt than to run a
 * command the user didn't actually want.
 *
 * All matching is case-insensitive and tolerant of whitespace.
 */

import type { ApprovalDecision } from './approval-cache.js';

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
  'go ahead',
  '同意',
  '允许',
  '通过',
  '好的',
  '可以',
  '行',
  '是',
  '批准',
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
 * Classify a user's reply to a pending confirmation.
 *
 * Returns `undefined` if the message doesn't obviously look like an
 * approval verdict; the agent should then treat it as a fresh user
 * message rather than a response to a confirmation.
 */
export function classifyApprovalMessage(message: string): ApprovalDecision | undefined {
  const lower = message.trim().toLowerCase();
  if (lower.length === 0) return undefined;

  const hasAllow = ALLOW_TOKENS.some((tok) => lower.includes(tok));
  const hasDeny = DENY_TOKENS.some((tok) => lower.includes(tok));

  if (hasDeny) return 'deny';
  if (hasAllow) return 'allow';
  return undefined;
}
