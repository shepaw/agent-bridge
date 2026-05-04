/**
 * Build a slash-command registry for the OpenCode agent.
 *
 * `/model`, `/status`, and `/mcp` are registered via the SDK's factory
 * helpers. `/permissions` is omitted — OpenCode manages permissions through
 * its own `permission.updated` event + REST API, not via a registry entry.
 */
import {
  SlashCommandRegistry,
  createMcpHandler,
  createModelHandler,
  createStatusHandler,
  type ModelInfoEntry,
} from 'shepaw-acp-sdk';

/** Shape of the cfg object the registry mutates. */
export interface OpenCodeCfg extends Record<string, unknown> {
  model?: string;
}

export interface BuildRegistryHooks {
  onModelApplied(key: string): void;
}

export function buildRegistry(hooks: BuildRegistryHooks): SlashCommandRegistry<OpenCodeCfg> {
  const registry = new SlashCommandRegistry<OpenCodeCfg>();

  registry.register(
    createModelHandler<OpenCodeCfg>({
      applyModel: (cfg, key, models: ModelInfoEntry[]) => {
        const found = models.find((m) => m.id === key);
        if (!found) return undefined;
        cfg.model = key;
        hooks.onModelApplied(key);
        return found;
      },
    }),
  );

  registry.register(createStatusHandler<OpenCodeCfg>());
  registry.register(createMcpHandler<OpenCodeCfg>());

  return registry;
}
