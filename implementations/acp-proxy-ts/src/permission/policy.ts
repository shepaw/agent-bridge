/**
 * Tool-call approval policy — lets an operator pre-decide which permissions
 * are auto-approved (skipped), which are auto-denied, and which always require
 * remote review in the Shepaw app.
 *
 * Configured via env vars (optional; Hub no longer injects these — remaining
 * `session/request_permission` calls are forwarded to the Shepaw app):
 *
 *   PAW_ACP_APPROVAL_MODE           ask | auto | custom   (default: ask)
 *   PAW_ACP_APPROVAL_ALLOW_KINDS    comma list of ToolKind to auto-allow
 *   PAW_ACP_APPROVAL_ASK_KINDS      comma list of ToolKind to ALWAYS ask
 *   PAW_ACP_APPROVAL_ALLOW_PATTERNS newline list of regexes (auto-allow)
 *   PAW_ACP_APPROVAL_DENY_PATTERNS  newline list of regexes (auto-deny)
 *
 * Resolution precedence (first match wins):
 *   1. deny patterns              → deny
 *   2. ask kinds                  → ask   (safety override; can't be skipped)
 *   3. mode=auto                  → allow (yolo — approve everything else)
 *   4. allow patterns             → allow
 *   5. allow kinds                → allow
 *   6. default                    → ask
 *
 * `ask` kinds always win over allow kinds/patterns so an operator can express
 * "auto-allow everything EXCEPT execute/delete".
 */

import type * as acp from '@agentclientprotocol/sdk';

import { extractCommand } from './format.js';

export type PolicyMode = 'ask' | 'auto' | 'custom';
export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface ApprovalPolicyConfig {
  mode: PolicyMode;
  allowKinds: string[];
  askKinds: string[];
  allowPatterns: string[];
  denyPatterns: string[];
}

export interface PolicyResult {
  decision: PolicyDecision;
  /** Short machine-readable reason, e.g. "deny-pattern:rm -rf" — for audit logs. */
  reason: string;
}

const VALID_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export const DEFAULT_POLICY: ApprovalPolicyConfig = {
  mode: 'ask',
  allowKinds: [],
  askKinds: [],
  allowPatterns: [],
  denyPatterns: [],
};

function splitCsv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function splitLines(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMode(raw: string | undefined): PolicyMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'auto' || v === 'yolo') return 'auto';
  if (v === 'custom') return 'custom';
  return 'ask';
}

/** Build a config from environment variables (or an explicit env-like map). */
export function loadPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): ApprovalPolicyConfig {
  return {
    mode: parseMode(env.PAW_ACP_APPROVAL_MODE),
    allowKinds: splitCsv(env.PAW_ACP_APPROVAL_ALLOW_KINDS).filter((k) => VALID_KINDS.has(k)),
    askKinds: splitCsv(env.PAW_ACP_APPROVAL_ASK_KINDS).filter((k) => VALID_KINDS.has(k)),
    allowPatterns: splitLines(env.PAW_ACP_APPROVAL_ALLOW_PATTERNS),
    denyPatterns: splitLines(env.PAW_ACP_APPROVAL_DENY_PATTERNS),
  };
}

function compile(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      /* skip invalid regex rather than crash the gateway */
    }
  }
  return out;
}

export class PermissionPolicy {
  private readonly cfg: ApprovalPolicyConfig;
  private readonly allowRx: RegExp[];
  private readonly denyRx: RegExp[];

  constructor(cfg: ApprovalPolicyConfig = DEFAULT_POLICY) {
    this.cfg = cfg;
    this.allowRx = compile(cfg.allowPatterns);
    this.denyRx = compile(cfg.denyPatterns);
  }

  get mode(): PolicyMode {
    return this.cfg.mode;
  }

  /** True when the policy might resolve without asking the user. */
  get canAutoDecide(): boolean {
    return (
      this.cfg.mode === 'auto' ||
      this.cfg.allowKinds.length > 0 ||
      this.allowRx.length > 0 ||
      this.denyRx.length > 0
    );
  }

  decide(toolCall: acp.ToolCallUpdate): PolicyResult {
    const kind = (toolCall.kind ?? 'other').toLowerCase();
    const command = extractCommand(toolCall);
    const haystack = `${toolCall.title ?? ''}\n${command}`.trim();

    for (const rx of this.denyRx) {
      if (rx.test(haystack)) return { decision: 'deny', reason: `deny-pattern:${rx.source}` };
    }

    if (this.cfg.askKinds.includes(kind)) {
      return { decision: 'ask', reason: `ask-kind:${kind}` };
    }

    if (this.cfg.mode === 'auto') {
      return { decision: 'allow', reason: 'mode:auto' };
    }

    for (const rx of this.allowRx) {
      if (rx.test(haystack)) return { decision: 'allow', reason: `allow-pattern:${rx.source}` };
    }

    if (this.cfg.allowKinds.includes(kind)) {
      return { decision: 'allow', reason: `allow-kind:${kind}` };
    }

    return { decision: 'ask', reason: 'default:ask' };
  }
}
