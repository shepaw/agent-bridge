/**
 * `/mcp` handler — list MCP servers and their connection status.
 *
 * Purely informational: no form, no cfg mutation. When the `mcp` provider
 * is absent we render a one-line "not supported" message rather than
 * throwing, so the slash command completes cleanly on agents without MCP
 * support.
 */
import type { SlashCommandDeps, SlashCommandHandler } from '../types.js';

export function createMcpHandler<
  C extends Record<string, unknown> = Record<string, unknown>,
>(): SlashCommandHandler<C> {
  return {
    name: 'mcp',
    description: 'List MCP servers and their connection status',
    async handle(ctx, _args, _raw, _kwargs, deps: SlashCommandDeps<C>) {
      if (deps.providers.mcp === undefined) {
        await ctx.sendText('MCP listing is not supported by this agent.');
        return true;
      }
      let servers;
      try {
        servers = await deps.providers.mcp.servers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.sendText(`Failed to fetch MCP servers: ${msg}`);
        return true;
      }
      const lines: string[] = ['**MCP servers**', ''];
      if (servers.length === 0) {
        lines.push('_none configured_');
      } else {
        for (const s of servers) lines.push(`- ${s.name}: ${s.status}`);
      }
      await ctx.sendText(lines.join('\n'));
      return true;
    },
  };
}
