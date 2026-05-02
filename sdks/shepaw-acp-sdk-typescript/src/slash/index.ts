/**
 * Barrel re-exports for the slash-command subsystem. Importing from
 * `shepaw-acp-sdk` (root) also works — see `../index.ts`. This barrel is
 * mainly for agent implementations that want a tight `slash/` import.
 */
export { SlashCommandRegistry } from './registry.js';
export type {
  McpProvider,
  McpServerInfo,
  ModelInfoEntry,
  ModelsProvider,
  PermissionModeInfo,
  PermissionsProvider,
  SlashCommandDeps,
  SlashCommandHandler,
  SlashProviders,
  StatusProvider,
  StatusSummary,
} from './types.js';
export { createModelHandler } from './handlers/model.js';
export type { CreateModelHandlerOptions } from './handlers/model.js';
export { createStatusHandler } from './handlers/status.js';
export { createMcpHandler } from './handlers/mcp.js';
export { createPermissionsHandler } from './handlers/permissions.js';
export type { CreatePermissionsHandlerOptions } from './handlers/permissions.js';
