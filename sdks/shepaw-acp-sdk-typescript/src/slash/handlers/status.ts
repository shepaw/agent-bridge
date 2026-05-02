/**
 * `/status` handler — render a markdown summary of current agent state.
 *
 * Pulls from multiple providers (all optional):
 *   - `status`      account / any extra summary the SDK exposes
 *   - `mcp`         list of MCP servers
 *   - plus reads `cfg.model` / `cfg.permissionMode` directly
 *
 * No provider is required — missing ones are silently skipped so the same
 * handler works on any agent. Output is plain `ctx.sendText` (markdown).
 */
import type { SlashCommandDeps, SlashCommandHandler } from '../types.js';

export function createStatusHandler<
  C extends Record<string, unknown> = Record<string, unknown>,
>(): SlashCommandHandler<C> {
  return {
    name: 'status',
    description:
      'Show account, current model, permission mode, and MCP server summary',
    async handle(ctx, _args, _raw, _kwargs, deps: SlashCommandDeps<C>) {
      const lines: string[] = ['**Agent status**', ''];

      // Account / summary
      if (deps.providers.status !== undefined) {
        try {
          const s = await deps.providers.status.summary();
          if (s.account !== undefined && s.account !== '') {
            lines.push(`- **Account**: ${s.account}`);
          }
          // Prefer provider-reported values over cfg where present.
          if (s.model !== undefined && s.model !== '') {
            lines.push(`- **Model**: \`${s.model}\``);
          } else if (typeof deps.cfg.model === 'string' && deps.cfg.model !== '') {
            lines.push(`- **Model**: \`${deps.cfg.model}\``);
          }
          if (s.permissionMode !== undefined && s.permissionMode !== '') {
            lines.push(`- **Permission mode**: \`${s.permissionMode}\``);
          } else if (
            typeof deps.cfg.permissionMode === 'string' &&
            deps.cfg.permissionMode !== ''
          ) {
            lines.push(`- **Permission mode**: \`${deps.cfg.permissionMode}\``);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push(`- _Status provider error: ${msg}_`);
        }
      } else {
        // No provider — fall back to cfg so `/status` is still useful.
        if (typeof deps.cfg.model === 'string' && deps.cfg.model !== '') {
          lines.push(`- **Model**: \`${deps.cfg.model}\``);
        }
        if (
          typeof deps.cfg.permissionMode === 'string' &&
          deps.cfg.permissionMode !== ''
        ) {
          lines.push(`- **Permission mode**: \`${deps.cfg.permissionMode}\``);
        }
      }

      // MCP servers
      if (deps.providers.mcp !== undefined) {
        try {
          const servers = await deps.providers.mcp.servers();
          lines.push('', '**MCP servers**');
          if (servers.length === 0) {
            lines.push('- _none configured_');
          } else {
            for (const s of servers) lines.push(`- ${s.name}: ${s.status}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push('', `_MCP provider error: ${msg}_`);
        }
      }

      await ctx.sendText(lines.join('\n'));
      return true;
    },
  };
}
