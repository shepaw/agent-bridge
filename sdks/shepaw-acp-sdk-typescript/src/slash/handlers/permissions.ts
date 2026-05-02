/**
 * `/permissions` handler — radio picker for the permission mode.
 *
 * Mirrors the model picker flow: fetch available modes from
 * `deps.providers.permissions.modes()`, show a `radio_group` form,
 * register a background form handler, return immediately. No blocking
 * `waitForResponse` — see `model.ts` for rationale.
 *
 * Aliased as `/mode` (Claude Code convention).
 */
import { randomUUID } from 'node:crypto';

import type {
  PermissionModeInfo,
  SlashCommandDeps,
  SlashCommandHandler,
} from '../types.js';

export interface CreatePermissionsHandlerOptions<C> {
  /**
   * Apply a permission-mode selection to the agent's cfg.
   * Mutates `cfg` in-place; returns the matching `PermissionModeInfo`
   * for confirmation text, or `undefined` if the id is unknown.
   */
  applyMode(
    cfg: C,
    id: string,
    modes: PermissionModeInfo[],
  ): PermissionModeInfo | undefined;
}

export function createPermissionsHandler<C extends Record<string, unknown>>(
  opts: CreatePermissionsHandlerOptions<C>,
): SlashCommandHandler<C> {
  return {
    name: 'permissions',
    aliases: ['mode'],
    description: 'Switch the permission mode for this session',
    argumentHint: '[mode-id|list]',
    async handle(ctx, args, _raw, _kwargs, deps: SlashCommandDeps<C>) {
      if (deps.providers.permissions === undefined) {
        await ctx.sendText('Permission mode switching is not supported by this agent.');
        return true;
      }

      const first = args[0];

      // ── Direct switch: "/permissions <id>" ───────────────────────
      if (first !== undefined && first !== 'list' && first !== '') {
        let modes: PermissionModeInfo[];
        try {
          modes = await deps.providers.permissions.modes();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendText(`Failed to fetch permission modes: ${msg}`);
          return true;
        }
        const chosen = opts.applyMode(deps.cfg, first, modes);
        if (chosen === undefined) {
          await ctx.sendText(
            `Unknown permission mode: \`${first}\`. Use \`/permissions list\` to see available modes.`,
          );
          return true;
        }
        const desc = chosen.description ? `\n\n${chosen.description}` : '';
        await ctx.sendText(`✓ Permission mode set to **${chosen.name}**${desc}`);
        return true;
      }

      // ── Picker: "/permissions" or "/permissions list" ────────────
      let modes: PermissionModeInfo[];
      try {
        modes = await deps.providers.permissions.modes();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.sendText(`Failed to fetch permission modes: ${msg}`);
        return true;
      }
      if (modes.length === 0) {
        await ctx.sendText('No permission modes available.');
        return true;
      }

      const currentMode =
        typeof deps.cfg.permissionMode === 'string' ? deps.cfg.permissionMode : undefined;

      const formId = `form_permissions_${randomUUID().slice(0, 8)}`;
      await ctx.sendForm({
        title: 'Select a permission mode',
        description: currentMode
          ? `Current: ${currentMode}`
          : 'Pick a permission mode for this session',
        fields: [
          {
            name: 'choice',
            label: 'Permission mode',
            type: 'radio_group',
            required: true,
            default: currentMode,
            options: modes.map((m) => ({
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
          opts.applyMode(deps.cfg, choice, modes);
        }
      });

      return true;
    },
  };
}
