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
 * Absolute path for the pattern-based approval rules file.
 * Used by the "Allow All Similar" feature to remember decisions that apply
 * to a whole class of tool calls (e.g. "all `npm` invocations").
 */
export function approvalRulesPath(cfg: GatewayStorageConfig): string {
  return join(gatewayDir(cfg), 'approval-rules.json');
}
