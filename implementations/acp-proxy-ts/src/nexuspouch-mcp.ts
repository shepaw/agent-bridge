/**
 * Build ACP `McpServer` stdio entries for the local Nexuspouch MCP server.
 *
 * Enabled when `NEXUSPOUCH_ROOT` (or `NEXUSPOUCH_MCP_ROOT`) is set.
 * Disable with `NEXUSPOUCH_MCP=0|false|off`.
 *
 * Env:
 * - NEXUSPOUCH_ROOT / NEXUSPOUCH_MCP_ROOT — store root for `nexuspouch mcp`
 * - NEXUSPOUCH_BIN — binary path (default `nexuspouch`)
 * - NEXUSPOUCH_ADMIN_TOKEN / NEXUSPOUCH_TOKEN — optional admin/scoped token
 */

import type * as acp from '@agentclientprotocol/sdk';

export function resolveNexuspouchMcpServers(
  env: NodeJS.ProcessEnv = process.env,
): acp.McpServer[] {
  const flag = (env.NEXUSPOUCH_MCP ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return [];

  const root = (env.NEXUSPOUCH_MCP_ROOT ?? env.NEXUSPOUCH_ROOT ?? '').trim();
  if (!root) return [];

  const bin = (env.NEXUSPOUCH_BIN ?? 'nexuspouch').trim() || 'nexuspouch';
  const token = (env.NEXUSPOUCH_ADMIN_TOKEN ?? env.NEXUSPOUCH_TOKEN ?? '').trim();

  const args = ['mcp', '--root', root];
  if (token) {
    args.push('--admin-token', token);
  }

  const serverEnv: Array<{ name: string; value: string }> = [];
  if (token) {
    serverEnv.push({ name: 'NEXUSPOUCH_ADMIN_TOKEN', value: token });
  }

  return [
    {
      name: 'nexuspouch',
      command: bin,
      args,
      env: serverEnv,
    },
  ];
}
