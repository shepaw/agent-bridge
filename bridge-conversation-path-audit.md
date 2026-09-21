# agent-bridge 核心对话链路排查报告

日期：2026-09-21 · 仓库：`/Users/edenzou/workspace/shepaw/agent-bridge`
链路：App/客户端 → Hub(WS) → acp-proxy → ACP 子进程 → 回流渲染

> 说明：本文件落在已挂载的工作区（`store://workspaces/c1b74877debb2fd6/Users/edenzou/workspace/shepaw/agent-bridge/`），
> 因为**储物袋写入通道当前全线不可用**（见 S5，本次排查过程中实测复现）。修好 S5 后应回写 `files` 分区。

## 链路骨架（file:line）

1. 接入：`sdks/shepaw-acp-sdk-typescript/src/server.ts:1360 handleWebSocket` → Noise 握手 `:1495` → `:1712 onWsMessage` → `agent.chat` `:1654`
2. 派发：`server.ts:1436 handleChatDispatch` → 并发闸门 `activeTasks.size >= maxConcurrency` → per-session FIFO `chatQueues:395` → `runChatTask:1575`
3. 代理：`implementations/acp-proxy-ts/src/agent.ts:386 onChat` → `:478 runPromptTurn`
4. 上游：`acp-subprocess.ts:837 runPromptTurn` → `:895 runPromptTurnOnce` → `:1083 getOrCreateSession` → `session.prompt` + `drainUpdates:1546`
5. 回流：`task-context.ts:197 sendText` → `:492 sendRaw` → `:1954 tapTaskEvent`（写 taskReplay）→ `wsSend:543`
6. 权限回路：`acp-subprocess.ts:1644 handleRequestPermission` → `waitForResponse` → `server.ts:2118 handleSubmitResponse`
7. 断线续传：`server.ts:2006 handleTaskResume`（replay buffer + `known_length` 增量）

## 严重

### S1 一个上游进程异常 → 清空该机全部会话

【证据】`acp-subprocess.ts:1047-1054` `disposeSessions()` 无条件遍历全表 dispose 并 `sessions.clear()`；触发点包括 child exit、stop、`restartUpstreamAgent`。单个 `AcpSubprocess` 承载本机所有会话。
【影响】会话 A 的 restore 会打断会话 B 的在飞 `session.prompt`；表清空后悬空引用报 `Cannot read properties of undefined (reading 'agent')`。多会话同时报错/卡死。
【建议】按 `shepawSessionId` 精确失效，不触碰他人 in-flight turn；同步清理 `turnsByUpstreamSession`。

### S2 权限确认「点了没反应」且永不补发

【证据】`server.ts:2073` `if (pending.delivered) continue`；`delivered` 依据是 `server.ts:1542` 的**本地 socket 写回调**，不是 App 层 ack。`task-context.ts:279-285` sealed（信箱）模式根本不发卡片却照样返回 cid；waiter 侧 `task-context.ts:481` `timeoutMs === 0` 表示无限等待。
【影响】half-open 隧道下 socket 照收 → `delivered=true` → 重连跳过补发 → turn 永久挂起；信箱模式下必然挂起。
【建议】重连时对所有「未收到 submitResponse」的卡无条件补发；sealed 模式返回 `undefined`；给 waiter 一个上限。

### S3 cancelTask 跨任务误杀审核 waiter

【证据】`server.ts:2096-2101` 遍历**全局** `pendingResponses` / `pendingHubRequests` 一律 reject，未按 taskId 过滤。
【影响】取消会话 A 会把 B 的 waiter 打成 `TaskCancelledError` → B 的工具调用被拒。
【建议】waiter 按 taskId 索引，只 reject 本任务。

### S4 工具侧任意文件读写 + 引擎版本不锁定

【证据】`acp-subprocess.ts:1757-1770` `readFile(params.path)` / `writeFile(params.path)` 无根目录白名单（工具调用必经路径）；`engines.ts:74,81,88,104,111,118,155` 七处 `@latest`。
【影响】上游包任意发版即静默换实现；可读写宿主任意文件。
【建议】路径限制在 cwd + additionalDirectories；版本锁定。

### S5 储物袋写入全线失败 ★ 本次实测复现

【证据】调用方 `store-tools.ts:302` 的 `write.chunk` 只传 `upload_id/offset/data`，未传 `space`；服务端 `agent-hub/core/src/peer/peer-store-protocol.ts:186` `if (!space) throw 'space required'`。`write.begin` 传了 space 能过，chunk 立即 bad_op。链路：`peer-store-http.ts:118` `/api/v1/store` → `executeLocalStoreOp` → 协议校验。
【实测】本次尝试经 peer MCP 写 `store://runtime/...` 返回 `{"ok":false,"code":"bad_op","error":"space required"}`；改用本机 CLI `shepaw store write --space runtime` 同样返回 `space required`。
【影响】`write.begin` 已占用 upload 但永远 commit 不到 —— agent 侧、CLI 侧落产物/存档**全部失败**。
【建议】`write.chunk` 补传 `space`（与同文件 `:342` 的 `commit` 一致），补一条针对完整 write 流程的回归测试。

## 中等

- **M1 resume 增量编码风险**：`server.ts:2022-2023` `entry.accumulated.slice(base)`，`known_length` 若落在代理对中间会产生孤立代理项 → CJK/emoji 断流乱码。需按 code unit 对齐并校验 surrogate 边界。
- **M2 重放缓冲纯内存**：`taskReplay:395`，TTL 25min `:407`、超 4M `:410` 直接返回 `status:'lost'`。进程重启/超时后卡片与 delta 全丢；关键卡片应持久化。
- **M3 历史回放的启发式不可靠**：`history-created-at.ts:65-78` tie-break 只在单批数组内生效，分页各段独立归一仍会撞分钟精度 tie，客户端可能把回复排到提问前；`session-lifecycle.ts:106-109` 用 idle 400ms / warmup / max 15s 启发式丢弃回放 update，慢引擎会漏 → 把上一轮答案当本轮回复流给用户（该文件注释自述此坑）。
- **M4 chatQueues 无界**：`server.ts:395` 按 sessionId 常驻，仅 `close()` 清理 → 长跑进程缓慢泄漏。
- **M5 进程树清理缺失**：spawn 未 detached，stop/restart 仅 SIGTERM `npx`，孙进程可成孤儿；历史回放存在忙轮询。

## 轻微

- ws `close` 回调未使用 `(code, reason)`，bridge 无法区分主动断/掉线/1006。
- `server.ts:2118` 起遍历**全部** taskReplay 删除 componentId，存在跨任务误删。

## 附带确认

工作区未提交改动（`agent-hub/cli/src/cli.ts`、`analyze.ts`、`core/src/session-analytics/`、`core/test/session-analytics.test.ts`）是**离线** token/tool 统计，`core/src/index.ts` 仅做导出，不触碰对话链路。

## 建议修复顺序

S5（一行改动、收益最大，且当前正在挡住所有存档）→ S2 → S3 → S1 → M1/M2 → M3/M4/M5

---

## 修复记录（2026-09-21 已实施）

| 项 | 状态 | 改动 |
|---|---|---|
| S5 储物袋写入 | ✅ 已修 + 端到端验证 | `store-tools.ts:302` `write.chunk` 补传 `space`；测试 mock 现按真实协议校验 space（缺即 bad_op），新增多 chunk 用例。重建 dist 后 `shepaw store write` 实测成功返回 URI |
| S2 权限卡永不补发 | ✅ 已修 | `server.ts` `handleTaskResume` 改为补发**所有**未决卡片（`delivered` 只证明 socket 写成功，不证明人看到）；`task-context.ts` 给 `timeoutMs: 0` 加 30 分钟硬上限 `WAIT_FOREVER_CAP_MS` |
| S3 cancel 跨任务误杀 | ✅ 已修 | 新增 `waiterOwner` / `waitersByTask` 双向索引 + `waiterRegistry` 注入；`handleCancelTask` 只 reject 本任务 waiter。新增 `test/cancel-scope.test.ts`（已验证：回退到旧全局 reject 时该测试失败） |
| S1 会话全表清空 | ✅ 已修（止血） | `disposeSessions()` 同步清理 `turnsByUpstreamSession`（消除悬空引用/undefined 读）并记录受影响会话。上游进程死亡时句柄本就全失效，无法保留；Shepaw→ACP 映射在类外，下轮自动 restore |
| S4 文件读写越界 | ✅ 已修 | 新增 `resolveWorkspacePath()`：`fs/readTextFile`、`fs/writeTextFile` 限制在 `cwd` + `--additional-directory` 内 |
| M1 续传编码 | ✅ 已修 | 抽出 `src/resume-delta.ts#resumeDeltaBase`，代理对中间回退一个 code unit；新增 `test/resume-delta.test.ts` |
| M3 回放丢弃过早起 | ✅ 已修 | `session-lifecycle.ts` 默认 `idleMs` 400 → 1000（长转录/cold start 的 chunk 间隔常 >400ms，提前结束会让上一轮答案流进本轮） |
| M4 队列泄漏 | ✅ 已修 | `chatQueues` 尾 promise 完成后，若无后续排队则删除该 session 条目 |
| M5 进程树 | ✅ 已修 | `spawn({ detached: true })` + 新增 `killUpstream()`：对进程组发 SIGTERM，5s 不退出升级 SIGKILL |
| 轻微：跨任务误删卡片 | ✅ 已修 | `handleSubmitResponse` 优先按 `task_id` 精准删（无 task_id 时才退回全局扫描） |
| 轻微：close 无 code/reason | ✅ 已修 | `ws.on('close')` 记录 `code` 与 `reason`（可区分 1006 掉线与主动关闭） |

### 未自动修复（需要你决策）

- **S4 引擎版本锁定**：`engines.ts` 7 处 `@latest`（claude-agent-acp ×3、codex-acp ×2、opencode-ai、zcode-acp-server）。固定版本号需要你指定目标版本并评估兼容性，否则可能直接打断现有实例；风险是上游任何发版都会静默换实现。
- **M2 重放缓冲持久化**：`taskReplay` 仍在内存（25min TTL / 4M 上限）。**已单独立项**，方案（先做 B：仅持久化未决卡片，再扩展到受限文本镜像）与验收标准见 `docs/m2-task-replay-persistence.md` / `store://files/c1b74877debb2fd6/general/m2-task-replay-persistence.md`。
- **M3 时间戳跨批 tie**：复查后 `ensureHistoryCreatedAt` 的调用点都是整批调用，函数末尾也已无条件做 tie-break，未发现实际分页路径 → 该项从"缺陷"降级为"无需改动"。
- **S2 sealed 模式**：复查后信箱模式下 `waitForResponse` 会直接抛 `interactive wait is unavailable`（不是无限挂起），因此只保留 timeout 硬上限，未改 `sendActionConfirmation` 的返回契约。

### 验证状态

- SDK：28 个测试文件 / 255 用例全绿；acp-proxy：50 个文件 / 363 用例全绿（含新增的 store-tools 多 chunk、cancel-scope、resume-delta 用例）。
- `agent-hub/core` 的 `peer-connection-resume-branch.test.ts` 曾有 2 个用例失败，**已修复**（293/293 全绿）：根因是 `vi.mock(..., async (importOriginal) => ({ ...(await importOriginal()), … }))` 的展开形式没把 mock 注入到 `peer-connection.ts`，实现侧仍用真实 `polishInstanceResume` 去连活体 ACP client，报 `client.chat is not a function`。改为纯工厂后注入生效。
- 储物袋写入：CLI 与本仓库 `dist` 均已修复，实测成功。**宿主注入的 MCP 服务进程（`dist/peer-store-mcp.js`）是修复前启动的旧代码，需重启该进程/会话才会生效** —— 直接以新 dist 起一个 MCP server 实测 `store_write` 返回 `ok:true`，可证明代码侧已无问题。
