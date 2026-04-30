/**
 * Shepaw CodeBuddy Code Gateway — public API.
 */

export { CodeBuddyCodeAgent } from './agent.js';
export type { CodeBuddyCodeAgentOptions } from './agent.js';

// Re-exported from shepaw-acp-sdk so existing downstream consumers don't
// have to change their import paths after the SDK migration.
export {
  makeCanUseTool,
  type MakeCanUseToolOptions,
  PendingConfirmations,
  type PendingConfirmation,
  type PermissionDecision,
  ApprovalCache,
  type ApprovalCacheOptions,
  summarizeToolInput,
  SessionStore,
  type SessionStoreOptions,
} from 'shepaw-acp-sdk';

export { log, wrapForDebug } from './debug.js';
