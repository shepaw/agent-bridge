/**
 * Group-orchestration tools attached to the shared store MCP server.
 *
 * The Shepaw app's orchestration loop cannot see tool calls made inside the
 * upstream agent (ACP `tool_call` events carry no arguments), so group tool
 * invocations are persisted as **inbox files** under the hub's own workspaces
 * tree via the same store protocol as every other store tool:
 *
 *   store://workspaces/<hubDevice>/group_<gid>/shared/orchestration/<sessionId>/
 *     inbox/{dispatch,finish,mentions}.json   — each `{issued_at, ...}`
 *
 * The app reads them back via cross-device reads (workspaces is a shared
 * space) and merges them into `resolveAdminDecision` / the mention cascade.
 * `issued_at` lets the app consume only files written after the current
 * orchestration round started.
 *
 * These tools live on the peer-store MCP server (not a separate server):
 * everything is stored in the pouch (储物袋), so everything speaks the store
 * protocol.
 */

import type { StoreToolResult, StoreToolsClient } from './store-tools.js';

/** Group-turn env context injected into the store MCP process. */
export interface GroupStoreMcpEnv {
  groupId: string;
  sessionId: string;
  workspaceRoot: string;
  memberNames: string[];
}

export function readGroupStoreMcpEnv(
  env: NodeJS.ProcessEnv,
): GroupStoreMcpEnv | null {
  const groupId = (env.GROUP_ID ?? '').trim();
  const sessionId = (env.GROUP_SESSION_ID ?? '').trim();
  const workspaceRoot = (env.GROUP_WORKSPACE_ROOT ?? '').trim();
  if (!groupId || !sessionId || !workspaceRoot) return null;
  return {
    groupId,
    sessionId,
    workspaceRoot,
    memberNames: (env.GROUP_MEMBER_NAMES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

/** JSON Schema for `group_dispatch` (mirrors app GroupOrchestrationTools). */
function dispatchSchema(memberNames: string[]): Record<string, unknown> {
  const agentItems: Record<string, unknown> = {
    type: 'string',
    description: 'Registered group member display name',
  };
  if (memberNames.length > 0) agentItems.enum = memberNames;
  return {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['concurrent', 'sequential'],
        description:
          'concurrent = run steps in parallel; sequential = by step order',
      },
      steps: {
        type: 'array',
        description: 'Dispatch steps',
        items: {
          type: 'object',
          properties: {
            step: {
              type: 'integer',
              description:
                'Step number (1-based). Optional; defaults to order.',
            },
            agents: {
              type: 'array',
              items: agentItems,
              minItems: 1,
              description: 'Member registered names to assign',
            },
            task: {
              type: 'string',
              description:
                'Full task brief: background, goal, acceptance criteria. Members may not see the user message.',
            },
          },
          required: ['agents', 'task'],
        },
      },
    },
    required: ['steps'],
  };
}

/** JSON Schema for `group_finish`. */
function finishSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['done', 'continue', 'pause'],
        description:
          'done = end orchestration; continue = admin keeps working alone; pause = wait for user (e.g. pending needs input)',
      },
    },
    required: ['action'],
  };
}

/** JSON Schema for `group_mention`. */
function mentionSchema(memberNames: string[]): Record<string, unknown> {
  const nameItems: Record<string, unknown> = {
    type: 'string',
    description: 'Registered group member display name, or "all" for every member',
  };
  if (memberNames.length > 0) nameItems.enum = [...memberNames, 'all'];
  return {
    type: 'object',
    properties: {
      mentions: {
        type: 'array',
        description: 'Members to mention/activate',
        items: {
          type: 'object',
          properties: {
            name: nameItems,
            notify: {
              type: 'boolean',
              description:
                'true = activate the member (default); false = cc only (display, no activation)',
            },
            reason: {
              type: 'string',
              description:
                'Optional brief reason the member is being asked for help',
            },
          },
          required: ['name'],
        },
      },
    },
    required: ['mentions'],
  };
}

export interface GroupToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Names of the group-orchestration tools carried by the store MCP. */
export const GROUP_TOOL_NAMES = new Set([
  'group_dispatch',
  'group_finish',
  'group_mention',
]);

/**
 * Group tool definitions for the store MCP `tools/list` response. Member-name
 * enums are filled from the group env when available.
 */
export function groupToolDefs(
  memberNames: string[] = [],
): GroupToolDef[] {
  return [
    {
      name: 'group_dispatch',
      description:
        'Delegate work to group members (admin only). Call this whenever you decide to assign tasks. Do NOT put dispatch JSON in chat text — use this tool. Also reply to the user in natural language describing the plan.',
      inputSchema: dispatchSchema(memberNames),
    },
    {
      name: 'group_finish',
      description:
        'Signal orchestration control without dispatching members (admin only): done (user need satisfied), continue (you keep working alone), or pause (wait for user input). Call this instead of emitting {"done": true} JSON in chat text.',
      inputSchema: finishSchema(),
    },
    {
      name: 'group_mention',
      description:
        'Declare that you are mentioning/activating group members for assistance. Call this instead of writing @name in chat text — text @ is display-only and never parsed. Also reply to the user in natural language.',
      inputSchema: mentionSchema(memberNames),
    },
  ];
}

/**
 * Validate one group tool call and produce the inbox file write.
 *
 * Pure (no I/O) so tests can exercise validation and payload shape without
 * spawning the server. Returns `{ file, payload }` or `{ error }`.
 */
export function buildInboxWrite(
  name: string,
  args: Record<string, unknown>,
): { file: string; payload: Record<string, unknown> } | { error: string } {
  switch (name) {
    case 'group_dispatch': {
      const steps = args.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        return { error: 'group_dispatch.steps must be a non-empty array' };
      }
      return {
        file: 'dispatch.json',
        payload: {
          kind: 'dispatch',
          mode: String(args.mode ?? 'concurrent'),
          steps,
        },
      };
    }
    case 'group_finish': {
      const action = String(args.action ?? '');
      if (!['done', 'continue', 'pause'].includes(action)) {
        return {
          error: 'group_finish.action must be done|continue|pause',
        };
      }
      return { file: 'finish.json', payload: { kind: 'finish', action } };
    }
    case 'group_mention': {
      const mentions = args.mentions;
      if (!Array.isArray(mentions) || mentions.length === 0) {
        return {
          error: 'group_mention.mentions must be a non-empty array',
        };
      }
      return {
        file: 'mentions.json',
        payload: { kind: 'mention', mentions },
      };
    }
    default:
      return { error: `unknown group tool: ${name}` };
  }
}

/** Inbox rel path under the workspace root (group-mcp env aware). */
export function inboxRelPath(
  envCtx: GroupStoreMcpEnv,
  file: string,
): string {
  return (
    `${envCtx.workspaceRoot}/shared/orchestration/` +
    `${envCtx.sessionId}/inbox/${file}`
  );
}

/**
 * Persist one group tool call to the orchestration inbox via the store
 * protocol (space=workspaces, nested filename passthrough).
 */
export async function writeGroupInbox(
  client: StoreToolsClient,
  envCtx: GroupStoreMcpEnv,
  file: string,
  payload: Record<string, unknown>,
): Promise<StoreToolResult> {
  const body = {
    issued_at: new Date().toISOString(),
    ...payload,
  };
  return client.write({
    space: 'workspaces',
    filename: inboxRelPath(envCtx, file),
    content: JSON.stringify(body),
  });
}
