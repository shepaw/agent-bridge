/**
 * Per-gateway on-disk storage paths.
 *
 * Each bridge implementation (claude-code-ts, codebuddy-code, …) picks its own
 * gateway directory name under `~/.config/` so their session maps, pending
 * approvals, and approval rules stay isolated from each other. The SDK
 * exposes this tiny helper so every persistence module can resolve paths
 * the same way without each implementation re-hardcoding `homedir()` joins.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GatewayStorageConfig {
  /**
   * Directory name under `~/.config/`. Examples:
   *   - `shepaw-cc-gateway` for Claude Code
   *   - `shepaw-cb-gateway` for CodeBuddy Code
   */
  gatewayDirName: string;
}

/** Absolute path to `~/.config/<gatewayDirName>`. */
export function gatewayDir(cfg: GatewayStorageConfig): string {
  return join(homedir(), '.config', cfg.gatewayDirName);
}

/** Absolute path for the Shepaw↔agent session mapping file. */
export function sessionsPath(cfg: GatewayStorageConfig): string {
  return join(gatewayDir(cfg), 'sessions.json');
}

/** Absolute path for the pending-approvals persistence file. */
export function pendingApprovalsPath(cfg: GatewayStorageConfig): string {
  return join(gatewayDir(cfg), 'pending-approvals.json');
}

/**
 * Absolute path for the pattern-based approval rules file (session-scoped).
 * Used by the "Allow All Similar" feature to remember decisions that apply
 * to a whole class of tool calls (e.g. "all `npm` invocations") for a given
 * Shepaw session. Written by the gateway as users tap "Allow All Similar".
 */
export function approvalRulesPath(cfg: GatewayStorageConfig): string {
  return join(gatewayDir(cfg), 'approval-rules.json');
}

/**
 * Absolute path for the global pattern-based approval rules file.
 *
 * Unlike `approvalRulesPath` (which the gateway writes), this file is a
 * read-only policy file hand-edited by the user — e.g. "always allow
 * `Read *`" or "always deny `Bash rm -rf *`". Loaded once per process
 * start and shared across every session. Session-level rules take
 * precedence at evaluation time.
 */
export function globalApprovalRulesPath(cfg: GatewayStorageConfig): string {
  return join(gatewayDir(cfg), 'global-rules.json');
}
