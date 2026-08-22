/**
 * Build ACP McpServer entries for the hub peer-store MCP (stdio).
 *
 * Enabled when SHEPAW_HUB_STORE_URL is set, or SHEPAW_PEER_STORE=1|true|on.
 * Skipped when Nexuspouch MCP is already configured (avoid duplicate store_* tools),
 * unless SHEPAW_PEER_STORE_FORCE=1.
 * Disable with SHEPAW_PEER_STORE_MCP=0|false|off.
 *
 * The same server also carries the group-orchestration tools
 * (group_dispatch / group_finish / group_mention): for group-task turns the
 * group env (GROUP_ID / GROUP_SESSION_ID / GROUP_WORKSPACE_ROOT /
 * GROUP_MEMBER_NAMES) is appended per-session so the MCP process enables
 * those tools and persists calls into the orchestration inbox.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { GroupChatContext } from 'shepaw-acp-sdk';
import { resolveHubStoreBase } from './hub-store-env.js';

/** Per-session context needed to enable group tools on the store MCP. */
export interface GroupMcpSessionContext {
  shepawSessionId: string;
  groupContext: GroupChatContext;
}

function defaultMcpScriptPath(): string {
  // Dist layout: dist/peer-store-mcp.js next to this module when bundled, or
  // sibling when running from source via vitest (resolve relative to cwd package).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'peer-store-mcp.js');
  } catch {
    return join(process.cwd(), 'dist', 'peer-store-mcp.js');
  }
}

export function resolvePeerStoreMcpServers(
  sessionCtx: GroupMcpSessionContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
): acp.McpServer[] {
  const flag = (env.SHEPAW_PEER_STORE_MCP ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return [];

  const base = resolveHubStoreBase(env);
  if (!base) return [];

  const nexusRoot = (env.NEXUSPOUCH_MCP_ROOT ?? env.NEXUSPOUCH_ROOT ?? '').trim();
  const nexusOff = ['0', 'false', 'off'].includes(
    (env.NEXUSPOUCH_MCP ?? '').trim().toLowerCase(),
  );
  const force = ['1', 'true', 'on'].includes(
    (env.SHEPAW_PEER_STORE_FORCE ?? '').trim().toLowerCase(),
  );
  if (nexusRoot && !nexusOff && !force) {
    // Prefer Nexuspouch MCP when both are available.
    return [];
  }

  const command = (env.SHEPAW_PEER_STORE_MCP_BIN ?? process.execPath).trim();
  const script = (env.SHEPAW_PEER_STORE_MCP_SCRIPT ?? defaultMcpScriptPath()).trim();

  const serverEnv: Array<{ name: string; value: string }> = [
    { name: 'SHEPAW_HUB_STORE_URL', value: base },
  ];
  const device = (env.SHEPAW_HUB_STORE_DEVICE ?? '').trim();
  if (device) serverEnv.push({ name: 'SHEPAW_HUB_STORE_DEVICE', value: device });
  const token = (env.SHEPAW_HUB_STORE_TOKEN ?? '').trim();
  if (token) serverEnv.push({ name: 'SHEPAW_HUB_STORE_TOKEN', value: token });

  // Group-task turn: enable the group-orchestration tools on this server.
  const gc = sessionCtx?.groupContext;
  const groupId = gc?.group_id?.trim() ?? '';
  if (sessionCtx && gc && groupId) {
    serverEnv.push({ name: 'GROUP_ID', value: groupId });
    serverEnv.push({
      name: 'GROUP_SESSION_ID',
      value: sessionCtx.shepawSessionId,
    });
    serverEnv.push({ name: 'GROUP_WORKSPACE_ROOT', value: `group_${groupId}` });
    serverEnv.push({
      name: 'GROUP_MEMBER_NAMES',
      value: (gc.members ?? []).map((m) => m.name).join(','),
    });
  }

  return [
    {
      name: 'shepaw-peer-store',
      command,
      args: [script],
      env: serverEnv,
    },
  ];
}
