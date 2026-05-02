/**
 * `/model` handler — interactive radio picker for the LLM model.
 *
 * Flow:
 *   `/model <id>`      direct switch, confirmed via `sendText` while the task
 *                      is still live.
 *   `/model` / `list`  fetches models via `deps.providers.models.list()`,
 *                      renders a radio-group form, registers a background
 *                      form handler, returns immediately.
 *
 * Silent submit: we use `registerFormHandler` (fire-and-forget) instead of
 * `ctx.waitForResponse` — awaiting a response pins the task as "still
 * streaming" in shepaw, which reparents the FormBubble on every metadata
 * update and wipes the user's radio selection mid-interaction.
 *
 * SDK-specific pieces injected via `deps.providers.models` (shape:
 * `{ list(): Promise<ModelInfoEntry[]> }`) and `opts.applyModel` (mutates
 * the agent's `cfg` to take effect on the next `onChat`).
 */
import { randomUUID } from 'node:crypto';

import type {
  ModelInfoEntry,
  SlashCommandDeps,
  SlashCommandHandler,
} from '../types.js';

export interface CreateModelHandlerOptions<C> {
  /**
   * Apply a model selection to the agent's cfg.
   *
   * Called from two paths:
   *   - "/model <id>" (live task) — return value is used to render the
   *     confirmation text. Return `undefined` if the id is unknown so the
   *     handler can surface "Unknown model" feedback.
   *   - form submit (background) — return value is ignored; the handler
   *     just mutates cfg and we rely on the form's own submitted-state.
   */
  applyModel(cfg: C, id: string, models: ModelInfoEntry[]): ModelInfoEntry | undefined;
}

export function createModelHandler<C extends Record<string, unknown>>(
  opts: CreateModelHandlerOptions<C>,
): SlashCommandHandler<C> {
  return {
    name: 'model',
    description: 'Switch the LLM model for this session',
    argumentHint: '[model-id|list]',
    async handle(ctx, args, _raw, _kwargs, deps: SlashCommandDeps<C>) {
      if (deps.providers.models === undefined) {
        await ctx.sendText('Model switching is not supported by this agent.');
        return true;
      }

      const first = args[0];

      // ── Direct switch: "/model <id>" ─────────────────────────────
      if (first !== undefined && first !== 'list' && first !== '') {
        let models: ModelInfoEntry[];
        try {
          models = await deps.providers.models.list();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendText(`Failed to fetch models: ${msg}`);
          return true;
        }
        const chosen = opts.applyModel(deps.cfg, first, models);
        if (chosen === undefined) {
          await ctx.sendText(
            `Unknown model: \`${first}\`. Use \`/model list\` to see available models.`,
          );
          return true;
        }
        const desc = chosen.description ? `\n\n${chosen.description}` : '';
        await ctx.sendText(`✓ Switched to **${chosen.name}**${desc}`);
        return true;
      }

      // ── Picker: "/model" or "/model list" ────────────────────────
      let models: ModelInfoEntry[];
      try {
        models = await deps.providers.models.list();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.sendText(`Failed to fetch models: ${msg}`);
        return true;
      }
      if (models.length === 0) {
        await ctx.sendText('No models available.');
        return true;
      }

      const currentModel =
        typeof deps.cfg.model === 'string' ? deps.cfg.model : undefined;

      const formId = `form_models_${randomUUID().slice(0, 8)}`;
      await ctx.sendForm({
        title: 'Select a model',
        description: currentModel
          ? `Current: ${currentModel}`
          : 'Pick a model to use for this session',
        fields: [
          {
            name: 'choice',
            label: 'Model',
            type: 'radio_group',
            required: true,
            default: currentModel,
            options: models.map((m) => ({
              label: m.name,
              value: m.id,
              description: m.description,
            })),
          },
        ],
        formId,
      });

      deps.registerFormHandler(formId, (responseData) => {
        const choice =
          typeof responseData.choice === 'string' ? responseData.choice : undefined;
        if (choice !== undefined && choice !== '') {
          opts.applyModel(deps.cfg, choice, models);
        }
      });

      return true;
    },
  };
}
