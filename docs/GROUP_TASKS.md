# 群任务适配（Group Task Adaptation）

外接 agent（经 `shepaw-acp-proxy` 接入的 Claude Code / Codex / CodeBuddy 等）在
Shepaw 群聊中参与任务编排时的上下文与存储语义约定。

## 链路

```
Shepaw app（群编排 GroupAgentExecutor）
  └─ agent.chat ──▶ SDK ACPAgentServer
       params.group_context（群身份）      ──▶ AcpProxyAgent.onChat
            ├─ store 写上下文归属群（runtime/<group>/<group>/artifacts/…）
            └─ 每会话首次注入「## 群任务上下文」块（与储物袋作用域卡同块）
                 └─▶ 上游 agent（Claude Code 等）
```

`group_context` 由 Shepaw app 在每一次群成员 turn 附带（`GroupChatContext`，
见 `sdks/shepaw-acp-sdk-typescript/src/types.ts`）；非群单聊不带该字段。

## GroupChatContext 字段

| 字段 | 说明 |
|---|---|
| `group_id` | 群 channel id（`group_<uuid>`；也是群家族根） |
| `group_name` / `group_description` | 群名 / 描述 |
| `member_count` / `members` | 成员数 / 成员表（id、name、type、bio、capabilities、status） |
| `is_first_message` / `message_version` | 首条消息标记 / 消息版本 |
| `orchestration_tools` | **仅 admin**：`group_dispatch` / `group_finish` 工具定义 |
| `workspace_uri` | 群工作空间共享面 `store://workspaces/<device>/group_<gid>/shared` |

## Proxy 行为（acp-proxy-ts）

1. **store 写归属群**：群 turn 时 `writeStoreWriteContext` 的 owner/channel 设为
   `group_id`——`shepaw store write` 产物落 `runtime/<group>/<group>/artifacts/…`，
   全群可见，而不是成员个人 runtime。
2. **群任务上下文注入**：每会话首次（与储物袋作用域卡同块）注入
   `buildGroupTaskContextBlock` 渲染的文本块——群名、成员表（含离线标记）、
   群共享空间 URI、admin 编排提示。上游 agent 由此知道自己在群任务里。

## 外接 agent 的约定

- 群共享空间 `store://workspaces/<device>/group_<gid>/shared` 存放
  `shared/memory/latest.md`（上一任务蒸馏总结）、`shared/orchestration/`
  （编排轮次快照）。用 `shepaw store list --uri <uri> --depth 1` 与
  `shepaw store read --uri <uri>` 查看。
- `shepaw store write --space workspaces --group <gid>` 只写自己的成员目录
  `members/<agentId>/`；其他成员目录不可写。
- 管理员角色（`orchestration_tools` 存在）时可用 `group_dispatch` /
  `group_finish` 编排——**当前为纯 prompt 约定**，工具定义未转发为上游
  可执行工具；按群卡提示的 JSON 结构输出即可（宿主侧解析）。

## 边界（未实现）

- `group_dispatch` / `group_finish` / `group_mention` 的**可执行工具转发**
  （MCP 翻译）未实现——上游 agent 以文本约定参与。
- mailbox（信箱）路径仅携带 `group_id`，无成员/workspace 上下文。
- `SHEPAW_SCOPE_CARD` 仍是进程级 env；群卡信息由 `group_context` 按 turn
  携带，不经 env。
