/**
 * Group-task context rendering for the ACP proxy gateway.
 *
 * The Shepaw app attaches `group_context` to every `agent.chat` turn that is
 * a group-task delegation (see `GroupAgentExecutor.processGroupAgent`). The
 * upstream coding agent (Claude Code / Codex / …) has no idea it is working
 * inside a group chat — without this block it sees a bare task text with no
 * group identity. This module renders that context into a prompt block and
 * decides how `shepaw store write` should be scoped for the turn.
 */

import type { GroupChatContext } from 'shepaw-acp-sdk';

/** Whether the given kwargs carry a group-task delegation. */
export function isGroupTurn(gc: unknown): gc is GroupChatContext {
  return (
    typeof gc === 'object' &&
    gc !== null &&
    typeof (gc as GroupChatContext).group_id === 'string' &&
    (gc as GroupChatContext).group_id!.length > 0
  );
}

/**
 * Render the group-task context block injected into the upstream prompt.
 *
 * Mirrors the app-side Scope Card discipline: the block is compact, lists the
 * roster once (per session, not per turn), surfaces the shared workspace URI
 * for `store` reads, and marks admin turns with the orchestration tools.
 *
 * Returns null when `gc` is not a group turn.
 */
export function buildGroupTaskContextBlock(gc: GroupChatContext): string | null {
  if (!gc.group_id) return null;
  const lines: string[] = ['## 群任务上下文'];
  const name = gc.group_name?.trim();
  lines.push(
    name && name.length > 0
      ? `群：${name}（${gc.group_id}）`
      : `群 ID：${gc.group_id}`,
  );
  const desc = gc.group_description?.trim();
  if (desc && desc.length > 0) lines.push(`群描述：${desc}`);
  const members = gc.members ?? [];
  if (members.length > 0) {
    const count = gc.member_count ?? members.length;
    lines.push(`成员（${count}）：`);
    for (const m of members) {
      const online = m.status !== 'offline';
      const bio = m.bio?.trim();
      lines.push(
        `- ${m.name}${online ? '' : ' [离线]'}${bio && bio.length > 0 ? `：${bio}` : ''}`,
      );
    }
  }
  const ws = gc.workspace_uri?.trim();
  if (ws && ws.length > 0) {
    lines.push(
      `群共享空间：${ws}（群记忆 shared/memory/latest.md、编排状态 ` +
        `shared/orchestration/，用 store list/read 查看；` +
        `store write --space workspaces --group 只写你自己的成员目录）`,
    );
  }
  if (gc.orchestration_tools !== undefined) {
    lines.push('你是本群管理员：可用 group_dispatch / group_finish 编排群任务。');
  }
  return lines.join('\n');
}

/**
 * Store write scope for a group turn: artifacts land in the group runtime
 * (`runtime/<group>/<group>/artifacts/…`) so the whole group sees them,
 * instead of the member's personal runtime.
 */
export function groupStoreWriteScope(
  gc: GroupChatContext,
  agentId: string,
): { owner: string; channel: string; agentId: string } {
  return {
    owner: gc.group_id,
    channel: gc.group_id,
    agentId,
  };
}
