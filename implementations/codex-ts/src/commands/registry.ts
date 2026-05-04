/**
 * Build a slash-command registry for the Codex agent.
 *
 * Only `/model` has a live provider (static list of known OpenAI models).
 * `/status` and `/mcp` are registered with no-op providers so the app still
 * renders a sensible response instead of "unknown command".
 *
 * `/permissions` is intentionally omitted — Codex's approval policy is set at
 * startup via `approvalPolicy` and cannot be changed mid-session by the app.
 */
import {
  SlashCommandRegistry,
  createMcpHandler,
  createModelHandler,
  createStatusHandler,
  type ModelInfoEntry,
} from 'shepaw-acp-sdk';

/** Structural shape of Codex agent cfg the registry mutates. */
export interface CodexCfg extends Record<string, unknown> {
  model?: string;
}

export interface BuildRegistryHooks {
  onModelApplied(id: string): void;
}

export function buildRegistry(hooks: BuildRegistryHooks): SlashCommandRegistry<CodexCfg> {
  const registry = new SlashCommandRegistry<CodexCfg>();

  registry.register(
    createModelHandler<CodexCfg>({
      applyModel: (cfg, id, models: ModelInfoEntry[]) => {
        const found = models.find((m) => m.id === id);
        if (!found) return undefined;
        cfg.model = id;
        hooks.onModelApplied(id);
        return found;
      },
    }),
  );

  registry.register(createStatusHandler<CodexCfg>());
  registry.register(createMcpHandler<CodexCfg>());

  return registry;
}
