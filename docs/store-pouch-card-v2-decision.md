# 储物袋作用域卡（Scope Card）v2 决策记录

- 日期：2026-09-28
- 影响面：`implementations/acp-proxy-ts/src/store-pouch-card.ts`（Hub ACP 会话注入的稳定段）
- 触发：对 v1 卡面的逐条复核——卡上写的使用规则与 `shepaw store` 的真实行为不一致

## 1. 结论先行

v1 卡面有 5 处「教了但做不到 / 教错了」的规则，会直接导致 Agent 编造 URI、
写错分区、或以为自己能写 `files`。这一版只改**卡面文案**（Agent 读到的说明书），
不动协议、不动 App 侧 `ScopeCard`（仍 `schema_version=1`，避免两套 schema 打架）。

## 2. v1 的具体问题与决策

| # | v1 说法 | 真实行为 | 决策 |
|---|---|---|---|
| 1 | 「未指定分区时：长期文件 → `files`」 | `store write` 只处理 `--space public` / `--space workspaces`；**其他一切（含 `--space files`）静默落到 `runtime/…/artifacts/<task>/`** | 卡面改为明写三个真实落点，并点出 `--space files` 会静默落到 runtime |
| 2 | 只给了 read / list | CLI 还有 `search`（按路径与正文检索）、`--depth 0` 递归列、`--file` / `--content-base64` 写二进制 | 全部补进卡面；「找不到就 search，不要猜」取代空泛的「不要编造」 |
| 3 | 「`public` 公开引用」「`files` 沉淀」含糊并列 | App 侧 `public` 已是保留分区、与 `files` 同权（`StoreSpace.hiddenUserBrowserSpaces`）；`files` 在本 CLI 根本不可写 | 按「写 / 只读 / 私有勿写」三类重排，`cognition`、`backups` 明确标私有勿写 |
| 4 | 工作区挂载给的是含 OS 绝对路径的 URI，且说「相对路径如 `docs/good.md` 即该目录下文件」 | 挂载确实这么拼；但 Agent 一旦把绝对路径当可移植地址就会拼错 | 短期：卡面只教相对路径用法 + 明令不拼绝对路径、不用 `..`。**根因（绝对路径进 URI）不在这版解决，见 §4** |
| 5 | URI 不带版本 | 协议已支持 `@v<n>` / `@<hash16+>` / `?ref=` | 卡面补一句「可加 `@v<n>` / `@<hash>` 固定版本」 |

附带修正：`cognition` 是 Agent 私有认知（Soul / 结构化记忆权威），device/ACP 卡
本身没有 cognition URI，卡面明确「不要 store write 写 cognition，走 context CLI」，
避免 Agent 拿一个自己没有的分区去写。

## 3. v2 卡面（稳定段，实测渲染）

```
## 当前储物袋作用域

- schema: v1 · mode: `acp` · owner: device
- device: `<device>`
- URI：`store://<space>/<device_id>/<path>`（可加 `@v<n>` / `@<hash>` 固定到某一版本）
- 工作区已挂载：`store://workspaces/<device>/…`（相对路径如 `docs/good.md` = 挂载根下；
  不要拼 OS 绝对路径，不要用 `..`）
- 简历：`store://files/<device>/<agentId>/resume.md` — …

- 写只认三个落点：`runtime`（默认，`runtime/…/artifacts/<task>/`）· `public`（`--space public`）
  · `workspaces`（`--space workspaces --group <gid>`，仅成员）
- 只读 / 勿写：`files` 沉淀区只读（`--space files` 会静默落到 `runtime`）；
  `cognition`（Soul / 记忆权威，走 context CLI）与 `backups`（本端灾备）私有勿写
- 读: `shepaw store read --uri <uri-as-is>` · 列: `shepaw store list --uri <uri> --depth 1`
  （`--depth 0` 递归）
- 找: `shepaw store search --query <关键词> [--space files] [--uri <前缀>]` —
  找不到就 search，不要猜 URI
- 写产物: `shepaw store write --filename <名> --content "..."`（本地文件用 `--file <path>`，
  二进制用 `--content-base64`；可选 `--task` / `--desc`）；**不要**传 `agent_id` / `owner`，
  **以返回的 `store://` 为准**，不要自己拼落点
- （shepaw PATH / shim 每行沿用 v1）
- 禁止: 编造 `store://`；用 OS 路径代替储物袋；回写 runtime 镜像当权威；
  用 `store write` 写 `files` / `cognition`
```

实现约束（改文案时必须同时满足）：
- 卡体每行以 `- ` 开头（嵌套缩进会被 transcript 剥离逻辑当成用户正文漏出）；
- 最后一行由 `SCOPE_CARD_LAST_BULLET` 导出，`internal-prompt-strip.ts` 用它剥离粘连的用户文本，
  两边不能各写一份。

## 4. 不在本版解决，记录为后续项

1. **`--space files` 静默落到 runtime** —— 这是 CLI 的坑不是卡面的坑。应让
   `store write` 对 `files` 这类未支持 space 直接报 `bad_op`，而不是兜底写 runtime。
   改 App 侧 `StoreWriteCommand`，需连带改 App 单测。
2. **OS 绝对路径进 workspaces URI** —— 换机即失效、带用户名、不防 `..`。正解是
   挂载别名（`store://workspaces/<device>/by-alias/<alias>/…`），属协议改动，
   要同时动 Rust / Dart / TS 三端与 fixtures。
3. **简历挂在 `files/<device>/<agentId>/`** —— `agentId = acp_agent_<sha256(pub)[0:4]>`
   （`sdks/shepaw-acp-sdk-typescript/src/identity.ts`），跨重启稳定但换身份即丢，
   且没有发现机制。需要一条「按 agent 找 resume.md」的检索路径或固定别名。
4. **URI 无 etag** —— 现在只有主动加 `@ref` 才能固定版本，跨端引用默认仍是浮动的。

## 5. 追加决策（2026-09-28，用户裁定）

- **10 记忆**：文件系统记忆是权威；`cognition` 只是补充与加强，**不同步**，
  依赖 agent 主动写。→ 卡面已改为「Soul + 记忆补充：不同步，靠 agent 主动写；
  日常记忆优先写文件系统记忆」，不再称 cognition 为「记忆权威」。
- **12 工作区**：是**软链接**挂载，改磁盘即改袋（同一份）。→ 卡面已改。
  ⚠️ 该语义只在 **Hub 托管袋**成立：`agent-hub/core/src/peer/agent-store-mapping.ts`
  的 `ensureWorkspaceRootSymlink` 建的链接；App 侧相反——`local_store.dart:244-255`
  明确禁止 store 树内 symlink，且 `folder_binding_service.dart` 的目录绑定是
  **copy 摄取 + watcher 对账**（单向，外部 → `files/`）。两侧对「工作区文件是不是
  同一份」的语义不一致，仍是待办（见 §4-2）。
- **11 public**（2026-09-28）：用途未定。分区和 `--space public` 仍可用，卡面与系统技能改为「不要写入」，不再当成推荐落点。
- **13 简历**（2026-09-28）：不迁 `cognition`。跨端读取走现有 `store read`：属主在线时在属主本机读 `files/<device>/<agentId>/resume.md`，属主离线才回退 master 镜像。不另开简历 RPC。
5. **工作区挂载 vs 摄取** —— 已定「两档保证」：挂载视图（`workspaces`，权威在用户磁盘，
   不版本/不镜像/不跨设备）＋ 摄取产物（`files`/`public`/`runtime`，享受全部能力）。
   实现方式选**挂载注册表**而非放宽 symlink（App 侧 LocalStore 明确禁 symlink，
   且 Hub 建的软链接 App 读到就报 `bad_path`）。详见 App 仓库
   `docs/workspace_mount_decision.md`（方案已定、未实现）。

