/**
 * Pattern-based approval rules — the engine behind "Allow All Similar".
 *
 * Why rules on top of the exact hash cache:
 *   `ApprovalCache` remembers a user's verdict for the EXACT tool input
 *   they saw. Good for "approved this specific `ls` call", useless for
 *   "approved ALL `npm install` invocations". This module adds that
 *   second layer with glob-style wildcards so a single user click can
 *   cover a whole family of commands.
 *
 * Two layers of rules:
 *   - **Global rules** — a hand-edited read-only policy file
 *     (`global-rules.json`) loaded at process start. Think "team
 *     defaults": always allow `Read *`, always deny `Bash rm -rf *`.
 *   - **Session rules** — created when a user taps "Allow All Similar"
 *     or types "allow all npm". Persisted to `approval-rules.json`
 *     keyed by Shepaw sessionId so they survive gateway restarts
 *     within the same conversation.
 *
 * Matching order (last-match-wins):
 *   `evaluate(permission, pattern, globalRules, sessionRules)` flattens
 *   both rulesets in that order, then `findLast`s the first rule whose
 *   `permission` and `pattern` both glob-match. Because session rules
 *   come AFTER globals in the flattened list, a session rule naturally
 *   overrides any conflicting global rule.
 *
 *   Example: global says `allow Bash *`, session says `deny Bash rm *`.
 *   Evaluating `Bash rm foo` finds both rules match; session's `deny
 *   Bash rm *` wins because it's later in the list.
 *
 * This file is a direct adaptation of opencode's
 * `packages/opencode/src/permission/evaluate.ts`, trimmed to what we
 * need (no effect-ts, no Newtype, plain TS).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  approvalRulesPath,
  globalApprovalRulesPath,
  type GatewayStorageConfig,
} from '../storage-paths.js';
import { prefix as arityPrefix } from './arity.js';
import { log } from './log.js';
import { match as wildcardMatch } from './wildcard.js';

/**
 * What a rule tells us to do.
 *
 * `'ask'` is the default rule returned when no rule matches; it means
 * "fall through to the confirmation UI". Users can also write explicit
 * `'ask'` rules to re-prompt despite a broader `allow` — e.g. a global
 * `allow Bash *` plus a session `ask Bash rm *`.
 */
export type RuleAction = 'allow' | 'deny' | 'ask';

export interface PatternRule {
  /** Wildcard pattern matched against the tool name. `"Bash"`, `"Read"`, `"*"`. */
  permission: string;
  /**
   * Wildcard pattern matched against the derived input pattern.
   *
   * For Bash, the derived pattern is `<arity-prefix> *` (e.g.
   * `"npm install *"`). For non-Bash tools, the derived pattern is
   * `"*"`. Rule authors may use narrower patterns like
   * `"Bash npm install *"` when they want more precision — `evaluate`
   * just runs wildcard matching either way.
   */
  pattern: string;
  action: RuleAction;
  /** Wall-clock when the rule was created. `0` for hand-written globals. */
  createdAtMs: number;
}

/**
 * Evaluate rules against a concrete tool invocation. Returns the
 * winning rule, or a synthetic `'ask'` rule when nothing matches so
 * callers always have a non-null `.action` to branch on.
 *
 * Rulesets are flattened in the order given — pass globals first, then
 * session rules, so session entries (later in the list) can override
 * globals via the `findLast` semantics.
 */
export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: PatternRule[][]
): PatternRule {
  const rules = rulesets.flat();
  // Walk the flattened list in reverse so later rulesets (e.g. session
  // rules passed AFTER globals) take precedence — same semantics as
  // opencode's `rules.findLast(...)`, rewritten as a loop because the
  // SDK targets ES2022 where `findLast` isn't in lib.
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (
      rule !== undefined &&
      wildcardMatch(permission, rule.permission) &&
      wildcardMatch(pattern, rule.pattern)
    ) {
      return rule;
    }
  }
  return { permission, pattern: '*', action: 'ask', createdAtMs: 0 };
}

/**
 * Derive a rule `{permission, pattern}` pair from a live tool call.
 * This is what we store when a user clicks "Allow All Similar".
 *
 *   Bash { command: "npm install foo" }    → { permission: "Bash", pattern: "npm install *" }
 *   Bash { command: "git status --short" } → { permission: "Bash", pattern: "git status *" }
 *   Bash { command: "python script.py" }   → { permission: "Bash", pattern: "python *" }
 *   Bash { command: "" or missing }        → { permission: "Bash", pattern: "*" }
 *   Read { file_path: "..." }              → { permission: "Read", pattern: "*" }
 *
 * Non-Bash tools always produce `"*"` because their inputs are too
 * structurally varied to derive a useful sub-pattern automatically;
 * users who want narrower non-Bash rules can edit `global-rules.json`.
 */
export function deriveRule(
  toolName: string,
  input: unknown,
): { permission: string; pattern: string } {
  if (toolName === 'Bash') {
    const command = (input as { command?: unknown } | null | undefined)?.command;
    if (typeof command === 'string' && command.trim().length > 0) {
      const tokens = tokenize(command);
      const head = arityPrefix(tokens);
      if (head.length > 0) {
        return { permission: 'Bash', pattern: head.join(' ') + ' *' };
      }
    }
    return { permission: 'Bash', pattern: '*' };
  }
  return { permission: toolName, pattern: '*' };
}

/**
 * Split a bash command into tokens, dropping flags. Flags are
 * intentionally excluded because `arity.prefix` expects a flag-free
 * token stream — that's how opencode's reference dictionary was
 * designed. This is a rough tokenizer (whitespace-split), not a real
 * shell parser; quoted strings or `$(...)` substitutions are treated
 * as opaque tokens. Good enough for arity lookup.
 */
function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PatternRuleStoreOptions {
  /**
   * Full override for the session-rules file path. If unset, derived
   * from `gatewayDirName` as `~/.config/<dir>/approval-rules.json`.
   */
  sessionRulesPath?: string;
  /**
   * Full override for the global-rules file path. If unset, derived
   * from `gatewayDirName` as `~/.config/<dir>/global-rules.json`.
   */
  globalRulesPath?: string;
  /** Gateway directory name under `~/.config/`. Required if paths aren't set. */
  gatewayDirName?: string;
}

interface PersistedSessionShape {
  version: 1;
  /** Shepaw sessionId → rule list. Rules are appended in creation order. */
  bySession: Record<string, PatternRule[]>;
}

interface PersistedGlobalShape {
  version: 1;
  rules: PatternRule[];
}

/**
 * In-memory + on-disk store for pattern rules. Mirrors the shape of
 * `PendingMarkerStore` — 200ms-debounced persistence, tolerant load,
 * `flush()` for tests and graceful shutdown.
 */
export class PatternRuleStore {
  private readonly sessionPath: string;
  private readonly globalPath: string;
  private readonly bySession = new Map<string, PatternRule[]>();
  private globalRules: PatternRule[] = [];
  private writeTimer: NodeJS.Timeout | undefined;

  constructor(opts: PatternRuleStoreOptions = {}) {
    if (opts.sessionRulesPath !== undefined) {
      this.sessionPath = opts.sessionRulesPath;
    } else if (opts.gatewayDirName !== undefined) {
      const cfg: GatewayStorageConfig = { gatewayDirName: opts.gatewayDirName };
      this.sessionPath = approvalRulesPath(cfg);
    } else {
      throw new Error(
        'PatternRuleStore requires either `sessionRulesPath` or `gatewayDirName` in its options.',
      );
    }
    if (opts.globalRulesPath !== undefined) {
      this.globalPath = opts.globalRulesPath;
    } else if (opts.gatewayDirName !== undefined) {
      const cfg: GatewayStorageConfig = { gatewayDirName: opts.gatewayDirName };
      this.globalPath = globalApprovalRulesPath(cfg);
    } else {
      throw new Error(
        'PatternRuleStore requires either `globalRulesPath` or `gatewayDirName` in its options.',
      );
    }
  }

  /**
   * Load both session and global rule files. Missing files are normal
   * on first boot — we log and continue. Schema failures are logged
   * and the offending file is ignored (rules for that scope default to
   * empty).
   */
  async load(): Promise<void> {
    await Promise.all([this.loadSession(), this.loadGlobal()]);
  }

  /**
   * Find the rule that applies to a concrete tool call. Internally
   * calls `deriveRule` to turn the live call into a permission+pattern
   * pair, then `evaluate`s (global rules first, session rules second
   * so session wins on conflict).
   */
  findMatch(sessionId: string, toolName: string, input: unknown): PatternRule {
    const { permission, pattern } = deriveRule(toolName, input);
    const sessionRules = this.bySession.get(sessionId) ?? [];
    return evaluate(permission, pattern, this.globalRules, sessionRules);
  }

  /** Append a rule to a session's list. Persists after 200ms debounce. */
  addSession(sessionId: string, rule: PatternRule): void {
    const list = this.bySession.get(sessionId) ?? [];
    list.push(rule);
    this.bySession.set(sessionId, list);
    this.schedulePersist();
    log.gateway(
      'PatternRuleStore added session rule: %s %s=%s (session=%s, total=%d)',
      rule.permission,
      rule.pattern,
      rule.action,
      sessionId,
      list.length,
    );
  }

  /** Drop every rule for a session. Persists after 200ms debounce. */
  clearSession(sessionId: string): void {
    if (this.bySession.delete(sessionId)) {
      this.schedulePersist();
    }
  }

  /** Read-only snapshot of a session's rule list (for debugging/tests). */
  getSessionRules(sessionId: string): readonly PatternRule[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** Read-only snapshot of the loaded global rules (for debugging/tests). */
  getGlobalRules(): readonly PatternRule[] {
    return this.globalRules;
  }

  /** Force an immediate write of session rules, bypassing the debounce. */
  async flush(): Promise<void> {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.persistSessionNow();
  }

  private async loadSession(): Promise<void> {
    try {
      const raw = await readFile(this.sessionPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedSessionShape;
      if (data.version === 1 && data.bySession && typeof data.bySession === 'object') {
        for (const [sessionId, rules] of Object.entries(data.bySession)) {
          if (Array.isArray(rules)) {
            const valid = rules.filter(isValidRule);
            if (valid.length > 0) this.bySession.set(sessionId, valid);
          }
        }
        log.gateway(
          'PatternRuleStore loaded %d session(s) from %s',
          this.bySession.size,
          this.sessionPath,
        );
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.gateway(
          'PatternRuleStore: no session rules file at %s (fresh start)',
          this.sessionPath,
        );
      } else {
        log.gateway('PatternRuleStore session load failed: %s', e.message);
      }
    }
  }

  private async loadGlobal(): Promise<void> {
    try {
      const raw = await readFile(this.globalPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedGlobalShape;
      if (data.version === 1 && Array.isArray(data.rules)) {
        this.globalRules = data.rules.filter(isValidRule);
        log.gateway(
          'PatternRuleStore loaded %d global rule(s) from %s',
          this.globalRules.length,
          this.globalPath,
        );
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.gateway(
          'PatternRuleStore: no global rules file at %s (fresh start)',
          this.globalPath,
        );
      } else {
        log.gateway('PatternRuleStore global load failed: %s', e.message);
      }
    }
  }

  private schedulePersist(): void {
    if (this.writeTimer !== undefined) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.persistSessionNow().catch((err) =>
        log.gateway('PatternRuleStore persist failed: %s', String(err)),
      );
    }, 200);
  }

  private async persistSessionNow(): Promise<void> {
    await mkdir(dirname(this.sessionPath), { recursive: true });
    const data: PersistedSessionShape = {
      version: 1,
      bySession: Object.fromEntries(this.bySession),
    };
    await writeFile(this.sessionPath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

function isValidRule(obj: unknown): obj is PatternRule {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Partial<PatternRule>;
  return (
    typeof r.permission === 'string' &&
    typeof r.pattern === 'string' &&
    (r.action === 'allow' || r.action === 'deny' || r.action === 'ask') &&
    typeof r.createdAtMs === 'number'
  );
}
