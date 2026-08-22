/**
 * Stdio MCP server that exposes store_* tools against the hub peer store HTTP API.
 *
 * Also carries the group-orchestration tools (`group_dispatch` /
 * `group_finish` / `group_mention`) — everything lives in the pouch
 * (储物袋), so everything speaks the store protocol. Group tools persist
 * their calls as inbox files under the hub's workspaces tree for the app's
 * orchestration loop to read back.
 *
 * Run: node dist/peer-store-mcp.js
 * Env: SHEPAW_HUB_STORE_URL (or SHEPAW_PEER_STORE=1 → http://127.0.0.1:18792)
 *      SHEPAW_HUB_STORE_DEVICE — hub fingerprint (fetched from /api/v1/health if unset)
 *      SHEPAW_HUB_STORE_TOKEN — optional Bearer (hub currently ignores)
 *      GROUP_ID / GROUP_SESSION_ID / GROUP_WORKSPACE_ROOT / GROUP_MEMBER_NAMES
 *        — group-turn context; when present, the group tools are enabled.
 */

import { createInterface } from 'node:readline';
import {
  executeStoreTool,
  storeToolDefs,
  type StoreToolResult,
  StoreToolsClient,
} from './store-tools.js';
import { resolveHubStoreBase } from './hub-store-env.js';
import {
  buildInboxWrite,
  GROUP_TOOL_NAMES,
  groupToolDefs,
  readGroupStoreMcpEnv,
  writeGroupInbox,
} from './group-store-tools.js';

type JsonRpcReq = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

function reply(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  );
}

async function resolveDevice(
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const explicit = (env.SHEPAW_HUB_STORE_DEVICE ?? env.NEXUSPOUCH_DEVICE ?? '').trim();
  if (explicit) return explicit;
  try {
    const res = await fetch(`${base}/api/v1/health`);
    if (res.ok) {
      const body = (await res.json()) as { device?: string };
      if (body.device) return body.device;
    }
  } catch {
    /* fall through */
  }
  return '0000000000000000';
}

async function main(): Promise<void> {
  const env = process.env;
  const base = resolveHubStoreBase(env);
  if (!base) {
    process.stderr.write(
      'peer-store-mcp: set SHEPAW_HUB_STORE_URL or SHEPAW_PEER_STORE=1\n',
    );
    process.exit(1);
  }
  const token = (env.SHEPAW_HUB_STORE_TOKEN ?? env.NEXUSPOUCH_ADMIN_TOKEN ?? 'local').trim();
  const device = await resolveDevice(base, env);
  const client = new StoreToolsClient(base, token, device);

  // Group-orchestration tools are enabled for group-task turns (env set by
  // the per-session MCP injection).
  const groupEnv = readGroupStoreMcpEnv(env);
  const tools = [
    ...storeToolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...(groupEnv !== null ? groupToolDefs(groupEnv.memberNames) : []),
  ];

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: JsonRpcReq;
    try {
      msg = JSON.parse(trimmed) as JsonRpcReq;
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    try {
      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'shepaw-peer-store', version: '0.1.0' },
          });
          break;
        case 'notifications/initialized':
        case 'initialized':
          break;
        case 'tools/list':
          reply(id, { tools });
          break;
        case 'tools/call': {
          const name = String(params?.name ?? '');
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          // Group-orchestration tools persist to the inbox via the store
          // protocol; everything else dispatches to the store tools.
          let out: StoreToolResult;
          if (groupEnv !== null && GROUP_TOOL_NAMES.has(name)) {
            const planned = buildInboxWrite(name, args);
            if ('error' in planned) {
              reply(id, {
                content: [{ type: 'text', text: planned.error }],
                isError: true,
              });
              break;
            }
            out = await writeGroupInbox(
              client,
              groupEnv,
              planned.file,
              planned.payload,
            );
          } else {
            out = await executeStoreTool(name, args, client);
          }
          reply(id, {
            content: [{ type: 'text', text: JSON.stringify(out) }],
            isError: !out.ok,
          });
          break;
        }
        case 'ping':
          reply(id, {});
          break;
        default:
          if (id !== undefined) {
            replyError(id, -32601, `Method not found: ${method}`);
          }
      }
    } catch (e) {
      replyError(id, -32000, e instanceof Error ? e.message : String(e));
    }
  }
}

void main();
