/**
 * Shepaw Claude Code Gateway — public API.
 */

export { ClaudeCodeAgent } from './agent.js';
export type { ClaudeCodeAgentOptions } from './agent.js';
export { makeCanUseTool, type MakeCanUseToolOptions } from './permission.js';
export {
  PendingConfirmations,
  type PendingConfirmation,
  type PermissionDecision,
} from './pending-confirmations.js';
export { ApprovalCache, type ApprovalCacheOptions } from './approval-cache.js';
export { summarizeToolInput } from './tool-summary.js';
export { SessionStore, type SessionStoreOptions } from './session-store.js';
export { log, wrapForDebug } from './debug.js';
