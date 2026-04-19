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
export { ChannelTunnelConfig, TunnelClient } from './tunnel.js';
export type {
  ChannelTunnelConfigInit,
  TunnelClientOptions,
} from './tunnel.js';
