# CLI 执行身份解析优化（决策记录）

- 状态：提案，待确认后动手
- 日期：2026-09-26
- 范围：`agent-bridge/implementations/acp-proxy-ts`（PATH shim）+ App 侧 `hub_cli_execute` 对偶实现
- 动机：agent 在宿主会话里跑 `shepaw slip …` 必须手工补 `SHEPAW_STORE_AGENT_ID`，否则 `unknown agent`

## 1. 现状（带证据）

一次真实调用必须这样写，否则拿不到身份：

    SHEPAW_STORE_AGENT_ID=a87d12ed-e326-47b0-94d0-bcfc4145b9c0 \
      ~/.local/bin/shepaw slip list --status all

该 id 只能从 App 数据库反查得到：

    sqlite3 ~/Library/Application Support/ShePaw/shepaw.db "select id,name,protocol from agents;"

链路与关键代码：

| 环节 | 位置 | 行为 |
| --- | --- | --- |
| 剥身份 flag | `src/shepaw-cli-forward.ts:57` `IGNORED_IDENTITY_FLAGS` | `agent_id/agent/owner/owner_id/channel_id/channel` 一律丢弃 |
| 过滤发生在解析前 | `src/shepaw-cli-forward.ts:66-72` | 传给 `resolveStoreWriteScope` 的 flags 已无身份项 |
| 解析身份 | `src/store-write-context.ts:66-70` | `flags → env SHEPAW_STORE_AGENT_ID → /tmp/shepaw-acp-proxy-<uid>/store-context.json` |
| 上下文文件写入方 | `src/agent.ts:321`、`:405` | 只有 ACP gateway 每轮 `onChat` 写，非 gateway 子进程没有 |
| 失败报错 | `src/shepaw-cli-forward.ts:74-80` | 提示 `(--agent_id or SHEPAW_STORE_AGENT_ID / store-context.json)` |
| hub 探测 | `src/shepaw-cli-forward.ts:26-50` `resolveHubDeviceId` | 已经在打 `/api/v1/health`，但只取 device，不取身份 |
| App 侧对偶 | `shepaw/lib/services/hub_cli_execute.dart:22` `ignoredIdentityFlags` | 集合为 `{agent_id, owner, channel_id, channel}`，与 TS 侧**已漂移** |

本机实测环境：

- `SHEPAW_HUB_STORE_URL=http://127.0.0.1:18794` 已注入
- `SHEPAW_STORE_AGENT_ID` **未**注入
- `store-context.json` **存在**（macOS 的真实 tmpdir 是 `/var/folders/.../T/`，不是 `/tmp`），内容为
  `{"agent_id":"acp_agent_e20112db","owner":"acp_agent_e20112db","channel":"dm_a87d12ed-..._user_...","updated_at":"2026-09-26T13:55:28Z"}`
- 但 `acp_agent_e20112db` 在 App 的 agents 表里查不到（`select id,name,protocol from agents where id like '%e20112db%'` 返回空）→ App 侧 `_db.getRemoteAgentById` 返回 null → `unknown agent`（`hub_cli_execute.dart:164-169`）

## 2. 问题

1. **三条通道没有一条在本机可用**：flag 被剥、env 没注入、context 文件虽然被写入但装了一个 App 不认识的 id（`acp_agent_e20112db`，ACP 会话级 id，不是 Hub engine 行）→ 必然 `unknown agent`。agent 只能绕过这三条去 sqlite 猜——猜错还会撞上 `she-builtin-agent-001`（`agent is not a Hub engine`）。
2. **报错误导**：推荐了一个必被丢弃的 `--agent_id`，且丢弃是静默的，排查成本高。
3. **宿主接入即复现**：谁注入 `SHEPAW_HUB_STORE_URL` 却不注入身份，接一个宿主（CodeBuddy / Claude / Cursor）重现一次。
4. **两份身份集合已漂移**：TS 有 `agent`、`owner_id`，Dart 没有；将来加新身份 flag 时两边继续分叉。

## 3. 目标 / 非目标

**目标**

- agent 零配置拿到正确的 executor 身份。
- 身份仍不可被调用方伪造（保留现有安全约束）。
- 失败时报错可执行（说清去哪儿修），而不是指向一个无效 flag。

**非目标**

- 不改 App 侧鉴权模型（仍按 `agent_id` 鉴权）。
- 不给 agent「任选身份」的能力。
- 不改 `store://` 写入分区规则（那是 `scope_card.dart` 的约定）。

## 4. 方案与取舍

### A. 修错误提示 + 显式 warn（止血，先做）

- 报错文案去掉 `--agent_id`，改为：`SHEPAW_STORE_AGENT_ID` / `store-context.json` / 由 App 声明（见 B1）三条真实来源。
- 身份 flag 被丢弃时输出 warn：`ignoring --agent_id: executor identity is resolved from env / store-context.json`，不再静默。
- 风险：几乎为零。

### B1. App 声明本机 executor 身份 + shim 缓存（治本，推荐）

- App 在 `/api/v1/health`（或新增 `/api/v1/self`）返回**本机 shepaw 实例的 agent id**，与现有 `device` 字段并列。
- shim 在 `resolveHubDeviceId` 的既有探测里顺带取回，缓存进 `store-context.json`（已存在该机制，0600，仅本机 uid 目录）。
- 好处：身份由持有者（App）声明，agent 不用猜；网关写 context 与 shim 写 context 走同一份文件，语义统一。
- 代价：App 侧要改一行响应；缓存需要处理失效（见开放问题）。
- **已确认为必需**：本机 context 文件里的 id 就是错的，靠「文件存在」无法判断身份是否正确，只能由 App 给出权威答案。

### B2. shim 自己 list agents 筛选（备选，不推荐）

- 用 hub API 列 agents，按 `protocol=peer && 能跑 Hub CLI` 挑一个。
- 拒绝原因：选择逻辑散落到每个 shim，App 将来改「哪一行是本机实例」的规则时全部失效；等于把今天的 sqlite 猜测固化进代码。

### C. 宿主注入对齐

- 规定「注入 `SHEPAW_HUB_STORE_URL` 的一方同时注入 `SHEPAW_STORE_AGENT_ID` / `SHEPAW_STORE_CHANNEL`」，写入接入文档。
- B1 落地后这是冗余保障，但能覆盖「App 未升级」的过渡期。
- 代价：每个宿主接入点都要改，属于外部改动面。

### D. 抽 `identity.ts` 作为单一事实来源

- 一份 `IDENTITY_FLAGS` 集合 + `resolveExecutorIdentity()`，TS 侧 `shepaw-cli-forward.ts` 与 `store-write-context.ts` 都用它。
- Dart 侧 `hub_cli_execute.dart:22` 对齐同一集合，加测试锁住一致性。
- 目的：防「注释说支持、实现剥掉」和两边漂移复发。

### E. `--as-agent` 白名单（可选，暂不做）

- 允许显式指定，但仅接受本机可见 agents 白名单内的 id。
- 收益是「可见可控」，但 B1 之后收益很小，留作后续。

### F. App 侧缺省身份回落（暂不做）

- `cli/execute` 不带 `agent_id` 时用 App 自己的本机 agent。
- 从根上消掉「找 id」，但放宽了 App 侧鉴权入口，需要单独评估，本轮不做。

## 5. 实施拆分（每轮单独 commit）

1. **A**：报错文案 + 身份 flag warn（纯 shim 改动 + 单测）。
2. **B1**：App health 返回本机 executor agent id；shim 取回并缓存到 `store-context.json`；缓存命中/失效路径加单测。
3. **C**：宿主 env 契约补齐 + 文档（含本文件更新为「已落地」）。
4. **D**：`identity.ts` 抽取 + TS/Dart 集合一致性测试。

## 6. 验收

- 新开一个宿主会话，**不设任何 env**，`shepaw slip list --status all` 直接成功。
- 传 `--agent_id` 时有明确 warn 且被忽略（不影响结果）。
- `/tmp/shepaw-acp-proxy-<uid>/store-context.json` 权限 0600，仅本机 uid 可读写。
- TS 与 Dart 的身份 flag 集合一致，有测试锁住。
- 现有 `test/shepaw-cli-forward.test.ts`、`test/store-tools-forward.test.ts` 全绿。

## 7. 回滚

四步彼此独立：每一步单独 revert 都能回到可用状态（最坏情况退回「手工设 env」，即今天的行为）。B1 的缓存删除即失效，不影响 App。

## 8. 开放问题

1. `/api/v1/health` 直接加字段，还是新增 `/api/v1/self`？取决于 App 侧改动面，需确认。
2. 本机存在多个 peer agent（shepaw / nexuspouch / agent-bridge-*）时选哪个——**由 App 声明，shim 不猜**。
3. 缓存失效：App 重启/重装/重建 agent 后 id 变化 → `unknown agent` 时清缓存并重新探测一次，仅重试一次避免循环。**已确认必需**：本机 context 文件里的 id 就是过期/错误的典型场景，没有这条回退，B1 只能靠清文件才生效。

## 9. 步骤 A 已落地（2026-09-26）

- `src/shepaw-cli-forward.ts`：`buildCliExecutePayload` 返回 `CliExecuteBuild`，携带 `warnings`；错误文案改为列出真实来源（`SHEPAW_STORE_AGENT_ID` / ACP gateway 写入的 context 路径），不再推荐 `--agent_id`。
- `src/shepaw-cli.ts`：`runForwardedCli` 把 warnings 打到 stderr（成功路径）并附在失败 envelope 里。
- 单测：`test/shepaw-cli-forward.test.ts` 新增「丢弃身份 flag 时告警」「报错指向真实来源」两条；全量 `npx vitest run` 381 通过。
- 实测：`shepaw slip list --agent_id forged` 现在输出 `warning: ignoring --agent_id: …` 而不是静默丢弃。
