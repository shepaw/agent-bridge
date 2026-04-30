/**
 * Shepaw ACP SDK — build ACP agents for the Shepaw app (TypeScript).
 *
 * Wire-compatible with the Python `shepaw_acp_sdk` package.
 *
 * Quick start:
 * ```ts
 * import { ACPAgentServer, TaskContext } from 'shepaw-acp-sdk';
 *
 * class EchoAgent extends ACPAgentServer {
 *   async onChat(ctx: TaskContext, message: string) {
 *     await ctx.sendText(`Echo: ${message}`);
 *   }
 * }
 *
 * await new EchoAgent({ name: 'Echo Agent', token: 'secret' }).run({ port: 8080 });
 * ```
 */

export * from './types.js';
export * from './jsonrpc.js';
export { ConversationManager } from './conversation.js';
export type { ConversationManagerOptions } from './conversation.js';
export { ACPDirectiveStreamParser } from './directive-parser.js';
export type { ACPDirectiveStreamParserOptions } from './directive-parser.js';
export { acpDirectiveToNotification } from './utils.js';
export { TaskContext, TimeoutError, createDeferred } from './task-context.js';
export type {
  Deferred,
  SendActionConfirmationOpts,
  SendSingleSelectOpts,
  SendMultiSelectOpts,
  SendFileUploadOpts,
  SendFormOpts,
  SendFileMessageOpts,
  SendMessageMetadataOpts,
  WaitForResponseOpts,
  HubRequestOpts,
  TaskContextInit,
} from './task-context.js';
export { ACPAgentServer, TaskCancelledError } from './server.js';
export type { ACPAgentServerOptions, RunOptions } from './server.js';
export {
  derivedAgentId,
  derivedFingerprint,
  loadOrCreateIdentity,
  resolveIdentityPath,
} from './identity.js';
export type { AgentIdentity, LoadOrCreateIdentityOptions } from './identity.js';
export {
  addPeer,
  derivedPeerFingerprint,
  isPeerAuthorized,
  loadOrCreatePeers,
  removePeerByFingerprint,
  resolvePeersPath,
} from './peers.js';
export type { AuthorizedPeer, AuthorizedPeers, LoadOrCreatePeersOptions } from './peers.js';
export {
  consumeEnrollmentToken,
  createEnrollmentToken,
  EnrollmentError,
  formatCodeForDisplay,
  loadOrCreateEnrollments,
  normalizeCode,
  resolveEnrollmentsPath,
  revokeEnrollmentToken,
} from './enrollments.js';
export type {
  ConsumeResult,
  CreateEnrollmentTokenOptions,
  EnrollmentToken,
  Enrollments,
  LoadOrCreateEnrollmentsOptions,
} from './enrollments.js';
export {
  decodeFrame,
  encodeFrame,
  EnvelopeError,
  MAX_FRAME_APP_TO_AGENT,
  MAX_FRAME_AGENT_TO_APP,
  MAX_PREHANDSHAKE_BYTES,
  PROTOCOL_VERSION,
  WS_CLOSE,
} from './envelope.js';
export type { Frame, FrameType } from './envelope.js';
export {
  CIPHER_STATE_LEN,
  MAC_LEN,
  NOISE_PROLOGUE,
  NoiseHandshakeError,
  NoiseSession,
  NoiseTransportError,
} from './noise.js';
export type { HandshakeResult } from './noise.js';
export { ChannelTunnelConfig, TunnelClient } from './tunnel.js';
export type {
  ChannelTunnelConfigInit,
  TunnelClientOptions,
} from './tunnel.js';

// ── Permissions / approval routing ──────────────────────────────────

export {
  type GatewayStorageConfig,
  gatewayDir,
  sessionsPath,
  pendingApprovalsPath,
  approvalRulesPath,
} from './storage-paths.js';
export {
  ApprovalCache,
  type ApprovalCacheOptions,
  type ApprovalDecision,
  type PendingApproval,
} from './permissions/approval-cache.js';
export {
  classifyApprovalMessage,
  ALLOW_TOKENS,
  DENY_TOKENS,
} from './permissions/approval-keywords.js';
export {
  PendingConfirmations,
  type PermissionDecision,
  type PendingConfirmation,
  type PendingConfirmationsOptions,
  type WaitParams,
} from './permissions/pending-confirmations.js';
export {
  PendingMarkerStore,
  type PendingMarker,
  type PendingMarkerOptions,
} from './permissions/pending-marker.js';
export {
  SessionStore,
  type SessionStoreOptions,
} from './permissions/session-store.js';
export { summarizeToolInput } from './permissions/tool-summary.js';
export {
  FormAnswerStage,
  type StagedFormAnswer,
  makeCanUseTool,
  type MakeCanUseToolOptions,
} from './permissions/permission-core.js';
