/**
 * Build a slash-command registry for the CodeBuddy agent.
 *
 * Wires the SDK-shared handler factories (`createModelHandler`,
 * `createStatusHandler`, `createMcpHandler`, `createPermissionsHandler`)
 * to the agent's own cfg mutation hooks. Keeps all the glue in one place
 * so the agent constructor stays slim.
 *
 * Note on scope: the registry knows *only* about /model, /status, /mcp,
 * /permissions for now. Frontmatter-scanned commands (like `/plan`) and
 * LLM-handled SDK commands (like `/compact`) are surfaced via the
 * `onCommandsList` merge in `agent.ts`, and fall through to `onChat` when
 * typed — exactly what we want.
 */
import {
  createMcpHandler,
  createModelHandler,
  createPermissionsHandler,
  createStatusHandler,
  SlashCommandRegistry,
  type ModelInfoEntry,
  type PermissionModeInfo,
} from 'shepaw-acp-sdk';

/**
 * Minimal shape of `CodeBuddyCodeAgent`'s cfg that the registry mutates.
 * Structural so the builder doesn't import the agent class (avoids a
 * circular import).
 */
export interface CodeBuddyCfg extends Record<string, unknown> {
  model?: string;
  permissionMode?: string;
}

export interface BuildRegistryHooks {
  /** Called when the user picks (or switches to) a model. */
  onModelApplied(id: string): void;
  /** Called when the user picks (or switches to) a permission mode. */
  onPermissionModeApplied(id: string): void;
}

export function buildRegistry(
  hooks: BuildRegistryHooks,
): SlashCommandRegistry<CodeBuddyCfg> {
  const registry = new SlashCommandRegistry<CodeBuddyCfg>();

  registry.register(
    createModelHandler<CodeBuddyCfg>({
      applyModel: (cfg, id, models: ModelInfoEntry[]) => {
        const found = models.find((m) => m.id === id);
        if (!found) return undefined;
        cfg.model = id;
        hooks.onModelApplied(id);
        return found;
      },
    }),
  );

  registry.register(createStatusHandler<CodeBuddyCfg>());
  registry.register(createMcpHandler<CodeBuddyCfg>());

  registry.register(
    createPermissionsHandler<CodeBuddyCfg>({
      applyMode: (cfg, id, modes: PermissionModeInfo[]) => {
        const found = modes.find((m) => m.id === id);
        if (!found) return undefined;
        cfg.permissionMode = id;
        hooks.onPermissionModeApplied(id);
        return found;
      },
    }),
  );

  return registry;
}
