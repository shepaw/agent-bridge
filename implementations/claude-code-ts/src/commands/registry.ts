/**
 * Build a slash-command registry for the Claude agent.
 *
 * Mirror of `../../codebuddy-code/src/commands/registry.ts` — same
 * handlers, different applyModel / applyMode hooks. Only /model has a
 * working provider in this iteration: Claude exposes `getAvailableModes`
 * only via its future CLI extensions, and `mcpServerStatus`/`accountInfo`
 * require a live `Query`, which we don't spin up out-of-band.
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

/** Structural shape of Claude agent cfg the registry mutates. */
export interface ClaudeCfg extends Record<string, unknown> {
  model?: string;
  permissionMode?: string;
}

export interface BuildRegistryHooks {
  onModelApplied(id: string): void;
  onPermissionModeApplied(id: string): void;
}

export function buildRegistry(
  hooks: BuildRegistryHooks,
): SlashCommandRegistry<ClaudeCfg> {
  const registry = new SlashCommandRegistry<ClaudeCfg>();

  registry.register(
    createModelHandler<ClaudeCfg>({
      applyModel: (cfg, id, models: ModelInfoEntry[]) => {
        const found = models.find((m) => m.id === id);
        if (!found) return undefined;
        cfg.model = id;
        hooks.onModelApplied(id);
        return found;
      },
    }),
  );

  registry.register(createStatusHandler<ClaudeCfg>());
  registry.register(createMcpHandler<ClaudeCfg>());

  registry.register(
    createPermissionsHandler<ClaudeCfg>({
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
