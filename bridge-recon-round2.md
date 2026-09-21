# agent-bridge 摸底（recon）· 第 2 轮
- 时间：2026-09-20
- 分支：`cursor/exclude-acp-managed-cli-sync` @ `eac5ebf`（clean）
- 机器：本机 Hub device `c1b74877debb2fd6`，instance `agent-bridge-claude`
- 交付方式：`shepaw store write` 实证不可用（见 Q4），按宿主约束直写 repo 挂载目录

---

## Q1 — R1「一个会话的上游挂掉会连带清掉其它会话」→【已证实】

### 静态链（三段闭合）
| 证据 | 位置 |
|---|---|
| 会话表是**单个** Map，按 shepawSessionId 键 | `implementations/acp-proxy-ts/src/acp-subprocess.ts:236` `private readonly sessions = new Map<string, acp.ActiveSession>()` |
| 一个 `AcpProxyAgent` 只建**一个** `AcpSubprocess`（构造期一次） | `implementations/acp-proxy-ts/src/agent.ts:219` `private readonly subprocess: AcpSubprocess` / `agent.ts:273-283` `this.subprocess = opts.subprocess ?? new AcpSubprocess({…})` |
| `disposeSessions()` **无差别清空全部**会话 + config + modes | `acp-subprocess.ts:1048-1054` |
| 全部 6 个触发点 | `:470`（start 抢跑死 child）、`:562`（child `error`）、**`:604`（child `exit`）**、`:706`（`stop()`）、`:1442`（`restartUpstreamAgent()`） |

一个 gateway 进程 = 一个上游 child = 该机**所有** shepaw 会话共用。child 一退 → `disposeSessions()` 清掉全表。

### 日志证据（真实，非构造）
日志：`~/.config/shepaw-hub/instances/agent-bridge-claude/logs/agent.log`

1. **一个 child 同时挂着多个 upstream 会话** —— 死掉 child 的 stderr 尾巴里直接出现两个 sessionId：
   - `agent.log:53406` `getOrCreateSession failed: ACP agent exited (0) stderr: [session/query] sessionId=62d051f9-2780-4aa2-b4a6-604bed6f16e7 … [session/query] sessionId=2773f19b-7224-460f-b659-ef8a17e56173 resume=2773f19b-…`
   - `agent.log:53596` 同型：`2313e4ba-2a15-4e63-986f-a35d9a693a05` + `0ef78730-cd35-4472-849c-448d13c93345`
2. **被连带的是另一个已存在的会话** —— `53596` 的下一行即证：
   `agent.log:53597` `[acp-proxy] bound upstream 0ef78730-cd35-4472-849c-448d13c93345 unverified; forking new session for shepaw=0ef78730-cd35-4472-849c-448d13c93345 rehydrate=true`
   `0ef78730` 不是本次新建的会话（本次新建的是 `…user_1788153707110 → upstream=2313e4ba`），它是**先前就在同一 child 上**的会话，此刻一并失去绑定。
3. **自伤式连带（同步可观测）** —— `agent.log:53589`：
   `[acp-proxy] session.prompt failed: ACP connection closed … at _AcpSubprocess.restartUpstreamAgent (cli.js:3341) → tryRestoreSession → getOrCreateSession → runPromptTurnOnce → runPromptTurn → onChat`
   即：**会话 A 的 restore 路径自己调用 `restartUpstreamAgent()`**（`acp-subprocess.ts:1442` `disposeSessions()` + `:1449-1450` `connection.close()` + `SIGTERM`），把**同一连接上所有在飞的 `session.prompt`** 一起打断。这是 R1 的连带效应当场发生，不需要外部 kill。
4. 规模佐证：启动 banner `[acp-proxy] SessionStore ready: 40 established binding(s), 2 orphaned` —— 那**一个** child 上挂着 40 条 shepaw→upstream 绑定。
5. 紧随的二级崩溃：`agent.log:53412` / `:53602` `getOrCreateSession failed: Cannot read properties of undefined (reading 'agent') TypeError…`（`startOnce`），即表被 clear 之后调用方仍拿着悬空引用。

### 结论
**【已证实】**。机制（单 child + 单 Map + 无条件 clear）与现象（两个会话 id 同死于一个 child、跨会话 `session.prompt` 被 `restartUpstreamAgent` 打断）都有实证。

精度补充：`disposeSessions()` 只丢**本地映射**，不在上游删会话；下一次 prompt 会 rehydrate（日志 `rehydrated 4 history turn(s) into new session`）。所以损害形态是「**所有会话的在飞 turn 同时死掉 + 映射丢失**」，不是永久删除。用户侧表现为「多个对话同时报错/卡住」。

---

## Q2 — R9 + R10 权限确认卡片链路 →【已证实】（构造级闭合）

### R9：信箱/离线模式不发卡片、只降级一行文本、却立刻返回 confirmationId
- 判定器：`sdks/shepaw-acp-sdk-typescript/src/task-context.ts:273-274`
  `isSealedTransport` = `mailboxStream !== undefined || offlineSink !== undefined`
- 主逻辑：`task-context.ts:276-284`
  - `:278` `if (this.isSealedTransport) {`
  - `:280-282` `await this.sendText('[需要确认] …（信箱模式无法展示交互卡片，请在下次在线会话中处理）')`
  - `:283` `return cid;`  ← **未走 `sendRaw` / 未走 transport**
- 后果放大：`tapTaskEvent`（`server.ts:1978-1985`，`case 'ui.actionConfirmation'` 在 `:1978-1985`，`pendingConfirmations.set` 在 `:1981`）**只能**通过每任务 `transport` 触达（`server.ts:1530-1546`）。sealed 路径绕过 transport ⇒ **既没有卡片帧，也不在 `pendingConfirmations` 里留任何条目** ⇒ 重连时**无物可补发**。cid 返回给了调用方，但两头都是空头承诺。
- 调用方：`implementations/acp-proxy-ts/src/acp-subprocess.ts:1697-1706`（`sendActionConfirmation`）+ `:1701-1704` `turn.taskCtx.waitForResponse(confirmationId, { timeoutMs: 0 })`。
  注释在 `:1691-1696` 自述「No reply deadline」。
- `timeoutMs: 0` 语义：`task-context.ts:479-483` → `if (timeoutMs === 0 || timeoutMs === Infinity) { … }` **永久等待**（仅 task teardown 才 reject）。

→ R9 **成立**：sealed 模式 = 没卡片 + 返回 cid + 无限期等一个不会来的回复。

### R10：去重以「网关 `wsSend` 成功」为准 → 发送成功但 App 未显示时重连不再补发
- 落账：`server.ts:1981` `entry.pendingConfirmations.set(cid, { params, delivered: false })`
- 标记投递：`server.ts:1539-1543`
  ```ts
  await wsSend(route, message);
  if (tapped.confirmationId !== undefined) {
    const pc = replayEntry.pendingConfirmations.get(tapped.confirmationId);
    if (pc !== undefined) pc.delivered = true;
  }
  ```
- **关键：`wsSend` 的「成功」是什么** —— `task-context.ts:568-576`
  ```ts
  await new Promise<void>((resolve, reject) => {
    ws.send(payload, (err) => { if (err) reject(err); else resolve(); });
  });
  ```
  即 Node `ws` 的**本地写回调**（字节已交给本地 socket），**不是** App 层 ack。
- 补发判定：`server.ts:2072-2074`
  ```ts
  for (const pending of entry.pendingConfirmations.values()) {
    if (pending.delivered) continue;       // ← 永不补发
    await wsSend(ws, jsonrpcNotification('ui.actionConfirmation', pending.params));
    pending.delivered = true;
  }
  ```

→ R10 **成立，且比报告写的更宽**：不是「`wsSend` 成功」，而是「**本地 socket 写成功**」。在 channel 实测的 half-open 隧道下（socket 未 FIN），内核照单收下 → 回调触发 → `delivered=true` → 而 App 永远没渲染。重连 `agent.taskResume` 时 `continue` 跳过，**卡片永久消失**。

再加一层：卡片去重状态**只在内存的 `taskReplay` entry 里**；entry 被逐出/过期后 resume 返回 `status:'lost'`（`server.ts:2019-2027`），卡片连"存在过"都查不到。

### bridge 侧对「没送到」完全无感
`server.ts:1128` `ws.on('close', () => { … })` —— **不接任何参数**，close code/reason 被丢弃；全文件唯一的 `ws.close(code, reason)` 在 `server.ts:1050`（发送侧）。所以 bridge 无法区分「App 收到了」与「App 根本没显示」。

---

## Q3 — R2 / R3【部分证实 + 一处纠正 + 一处新发现】

### R2：acp-proxy 侧无 SIGKILL、无进程组 tree-kill —— 【已证实】
- `implementations/acp-proxy-ts/src/acp-subprocess.ts` 全文仅 2 处 kill，都是 `SIGTERM`：
  - `:711`（`async stop()` 内）
  - `:1450`（`restartUpstreamAgent()` 内）
- 全文无 `SIGKILL`、无 `detached`、无 `process.kill(-pid)`、无 `tree-kill` 依赖。
- 唯一 `SIGKILL` 字样在 `:151`，属于 `isSignalTermination()` 的**判定**（读信号名），不是发送。
- 行号漂移：任务给的 `acp-subprocess.ts:1417-1421` 现已不在 kill 代码上（该处是 `session/load` 的日志），实际落点为 `:1441-1451`。

### R3：repo-wide「全仓无 SIGKILL」——【纠正：不成立】
- `agent-hub/core/src/spawn.ts:537` `process.kill(pid, 'SIGKILL')` —— SIGTERM 后轮询 5s（`spawn.ts:520-537`）再升级，注释 `spawn.ts:22` 明确写了这条策略。
- `agent-hub/core/src/peer-process.ts:158`、`agent-hub/core/src/gateway-process.ts:154`、`agent-hub/cli/src/cli.ts:660` / `:1361`。
- **但这些打的是 Hub 自己托管的进程**（gateway / tunnel router / peer service），**不是 ACP child**。R2 的结论（ACP child 只吃 SIGTERM）依然成立，只是不能推广成「全仓无 SIGKILL」。

### 新发现（反方向风险）：没有 tree-kill ⇒ `npx` 的孙进程可能变孤儿
- ACP child 是 shell 包的 `npx`：日志 banner 实证 `spawn: npx -y @agentclientprotocol/claude-agent-acp@latest`。
- spawn 点 `acp-subprocess.ts:552-556`：`spawn(command, args, { cwd, stdio: ['pipe','pipe','pipe'], env })` —— **没有 `detached`**，所以 child 在 gateway 的进程组里。
- `SIGTERM` 只送给 `npx` 本身；真正的 agent 是 `npx` 的**子进程**。无进程组 kill ⇒ SIGTERM 后孙进程可能存活成孤儿。
- 交叉：hub 侧 `spawn.ts:369` / `:724` 的 `detached: true`（注释 `spawn.ts:365-372`：为了让 child 在 hub CLI 退出后存活，Unix 下走 setsid 自成进程组）是给 gateway / dsh 用的 —— 这意味着这些托管进程各自成组，`kill(pid)` 更打不到组。
- 等级：**静态推论（机制明确，未做进程树实测）**。要坐实只需在 restart 前后各打一次 `ps -ef | grep claude-agent-acp`；本轮时间盒内未做。

### `@latest`：【已证实】7 处，零锁定
`implementations/acp-proxy-ts/src/engines.ts`：

| 行 | 内容 | 覆盖 spec |
|---|---|---|
| `:74` | `-y @agentclientprotocol/claude-agent-acp@latest` | claude-code |
| `:81` | 同上 | tclaude |
| `:88` | 同上 | claude-internal |
| `:104` | `-y @agentclientprotocol/codex-acp@latest` | codex |
| `:111` | 同上 | tcodex |
| `:118` | `-y opencode-ai@latest acp` | opencode |
| `:155` | `-y zcode-acp-server@latest` | zcode |

- **无版本锁定机制**：spec 无 version 字段，无 env 覆盖旋钮（`grep -E "ENGINE_VERSION|ACP_VERSION|pinVersion" engines.ts` 零命中）。唯一覆盖手段是 `--acp-command` 整串替换（`engines.ts:60-68` `ResolveEngineSpecOptions`）。
- 另有 `:121-128` `openclaw`：`args: ['openclaw', 'acp']` —— **裸包名，连 tag 都没有**。
- 影响：上游包任意发版，**bridge 重启即静默换实现**（首个 `npx` 调用时拉取）。与「重启后行为变了」类问题强相关。

---

## Q4 — 环境现状：bridge 侧协议 + 成员能否落盘 →【已证实：不能落盘，根因已定位】

### 事实 1：本机 `shepaw` 不是 Hub 的 CLI，是 bridge 自装的 PATH shim
- `$SHEPAW_BIN` = `/var/folders/38/…/T/shepaw-acp-proxy-501/bin/shepaw`，内容：
  `exec "/Users/edenzou/.nvm/versions/node/v24.13.0/bin/node" "/Users/edenzou/workspace/shepaw/agent-bridge/implementations/acp-proxy-ts/dist/shepaw-cli.js" "$@"`
- 生成逻辑：`implementations/acp-proxy-ts/src/shepaw-cli-shim.ts:24-31`（dist 布局）/ `:51-56`（shim 脚本）/ `:69-73`（目录 `tmpdir()/shepaw-acp-proxy-<uid>/bin`）

### 事实 2：协议**不是**旧的 —— bridge 走的就是高层 op
- `implementations/acp-proxy-ts/src/store-tools.ts:283-347` `write()`：`write.begin`（`:292`）→ 分块 `write.chunk`（`:302`）→ `commit`（`:342`）。
- 传输：`store-tools.ts:244-256` `storeOp()` POST 到 `${base}/api/v1/store`，body `{op, payload}`。
- 目标服务：env `SHEPAW_HUB_STORE_URL=http://127.0.0.1:18794`。
- 该服务在线且正常：`curl :18794/api/v1/health` → `{"ok":true,"device":"c1b74877debb2fd6","store_root":"/Users/edenzou/.config/shepaw-hub/store"}`；
  `POST /api/v1/store {"op":"write.begin","payload":{"space":"runtime","path":"probe/x.txt","size":2,"sha256":"abc"}}` → `{"op":"result","data":{"upload_id":"26bf8602-…","received":0}}` ✅

### 事实 3：`shepaw store write` **100% 失败**（读/列/元数据不受影响）
四种写法全同错：
```
shepaw store write --filename x --space runtime  --content hi   → {"success":false,"error":"space required","code":"bad_op"}
shepaw store write --filename x --space=runtime  --content hi   → 同上
shepaw store write --filename x                  --content hi   → 同上
shepaw store write --uri store://runtime/…/probe --filename x --space runtime --content hi → 同上
```
对照，`shepaw store list --uri store://runtime/c1b74877debb2fd6 --depth 1` → `{"success":true,"entries":[…]}` ✅

### 根因（逐字对拍）
`store-tools.ts:302-306` 的 `write.chunk` **漏传 `space`**：
```ts
await this.storeOp('write.chunk', {
  upload_id: uploadId,
  offset,
  data: Buffer.from(chunk).toString('base64'),
});          // ← 没有 space
```
Hub 侧要求（`agent-hub/core/src/peer/peer-store-protocol.ts:186`）：
```ts
case 'write.chunk': {
  if (!space) throw Object.assign(new Error('space required'), { code: 'bad_op' });
```
curl 对拍（同一 upload_id，同一字节）：
```
不带 space → {"op":"error","code":"bad_op","message":"space required"}
带   space → {"op":"result","data":{"received":2}}
```
**错误串 `space required` / `bad_op` 与 CLI 输出逐字一致。**

### git 溯源
- `store-tools.ts` 的 write 路径来自 `b4882ac`（2026-08-01 `feat: Nexuspouch MCP examples + gateway store tools`）
- `peer-store-protocol.ts` 的 `space` 校验来自 `2471416`（2026-08-06 `feat(peer-store): serve store.* over peer channel for shared pouch`）
- ⇒ **自 2026-08-06 起，bridge 高层 store write 一直是坏的**，约 6 周。因为 `read`/`list`/`meta` 走 `--uri`（space 藏在 URI 里），只有 write 踩雷，所以长期没被发现。

### 结论
- bridge 侧 peer **不是**旧协议，是**新协议 + 一处参数漏传**。
- 成员**不能**用高层 `shepaw store write` 落盘；本轮产物按宿主约束退到 repo 挂载路径。
- **修复面极小**：`store-tools.ts:302` 加一行 `space,` 即可（`commit` 在 `:342` 已正确带 space）。

---

## 交叉点印证：权限确认卡片的「回传」走哪条路径 / 超时后 bridge 看到什么

### 去与回走**同一条** ACP WS 连接
- **去（下发）**：`acp-subprocess.ts:1697-1706` `turn.taskCtx.sendActionConfirmation({confirmationId, prompt, actions, extra})`
  → `task-context.ts:285-296` `sendRaw(jsonrpcNotification('ui.actionConfirmation', {… confirmation_id: cid …}))`
  → `task-context.ts:492-497` `sendRaw` → `:543` `wsSend(ws, message)` → 到 App。
- **回（上行）**：App 点确认 → `submitResponse`
  → **同一条 WS** → `server.ts:2131-2153` `handleSubmitResponse`：`for (const idKey of ['confirmation_id','select_id','upload_id','form_id'])` 取 `componentId`
  → `:2136` `entry.pendingConfirmations.delete(componentId)`；`:2138` `const deferred = this.pendingResponses.get(componentId)` → `resolve(responseData)`
  → `task-context.ts:462-486` `waitForResponse` 的 deferred 兑现 → `request_permission` 返回 → 上游 agent 继续。
- 匹配键：`perm_<uuid>`（`acp-subprocess.ts:1697` `const confirmationId = \`perm_${randomUUID()}\``）。
- 兜底：无 waiter 时进 `earlyResponses`（`server.ts:2150-2153`、`:2162-2166`），由 `takeEarlyResponse`（`task-context.ts:473`）在注册时捞回 —— 这条是好设计，不属问题。

### 所以在 channel 的 30s 上行超时下，bridge 侧观察到的是**整条隧道 Close，不是半开断流**
`server.ts:1128-1146`（`ws.on('close')`）会正常触发，日志只有一行：
`server.ts:1147` `console.log('[ACP] WebSocket connection closed');`
（本机日志实证同型行，例如 `agent-bridge-claude/logs/agent.log:53400` 附近连续三条 `[ACP] WebSocket connection closed`）

### 而且是**盲的**：bridge 侧根本没有 1006/1011 的落点
- `server.ts:1128` `ws.on('close', () => { … })` —— **形参为空**，`code` / `reason` 被丢弃且不落日志。
- 全文件唯一 `ws.close(code, reason)` 在 `server.ts:1050`（**发送**侧），另有 5 处只置 `v2Closing` 标志（`:924 :1037 :1048 :1410 :1426`），同样不看对端 code。
- ⇒ bridge **无法区分**「App 因 30s 上行超时主动断」与「App 掉线」。channel 报的 1006 是 App 侧观测，bridge 侧不存在等价观测点。

### 断开之后 bridge 干什么（`server.ts:1130-1144` 注释即规格）
1. 任务**继续跑**，输出继续累积进 replay buffer；
2. 每条 `taskReplay` 的 `route` 置 `undefined`（`:1141-1143`）—— 之后 `transport()` 因 `route === undefined` 直接 return（`server.ts:1534-1537`）；
3. **审批 waiter 保留**，`timeoutMs: 0` 永不超时（`acp-subprocess.ts:1701-1702` + `task-context.ts:479-483`）。

于是正好落回 R9/R10：卡片 `delivered=true` 不补发（`server.ts:2073`）、waiter 永不超时 ⇒ **turn 永久挂起，重连也救不回来**。

**这就是「权限确认点了没反应」的完整闭环**：channel 的 30s 上行超时打断回传 → 卡片不补发 → waiter 无限期 → 用户侧永久转圈。

---

## Top 可疑问题（按本轮证据强度排序）

| # | 问题 | 位置 | 等级 |
|---|---|---|---|
| 1 | **`shepaw store write` 全坏**：`write.chunk` 漏传 `space` | `store-tools.ts:302-306` vs `peer-store-protocol.ts:186` | **已证实（curl 逐字对拍）** |
| 2 | **R1 连带清会话**：单 child + 单 Map + 无条件 clear | `acp-subprocess.ts:236, 604, 1048-1054`；`agent.ts:219, 273` | **已证实（日志双 sessionId + 跨会话 `session.prompt` 被打断）** |
| 3 | **R10 去重以本地 socket 写成功为准** → 永不补发 | `server.ts:1539-1543` + `task-context.ts:568-576` + `server.ts:2073` | **已证实（构造级；比原报告更宽）** |
| 4 | **R9 sealed 模式返回空头 cid + `timeoutMs:0` 无限等** | `task-context.ts:276-284`；`acp-subprocess.ts:1691-1706` | **已证实** |
| 5 | **bridge 丢弃 WS close code**，无 1006/1011 落点，无法区分主动断/掉线 | `server.ts:1128`（唯一 `close(code,reason)` 在 `:1050` 发送侧） | **已证实** |
| 6 | **7 处 `@latest` 零锁定** + `openclaw` 裸包名 → 重启即静默换实现 | `engines.ts:74,81,88,104,111,118,155,121-128` | **已证实** |
| 7 | **无 tree-kill**：SIGTERM 只打 `npx`，真 agent 是孙进程 → 可能孤儿 | `acp-subprocess.ts:552-556`（无 detached）、`:711, :1450` | **静态推论（未做进程树实测）** |
| 8 | 报告 `acp-subprocess.ts:1417-1421` 行号已漂移；且"全仓无 SIGKILL"不成立（Hub 托管进程有） | 实际 `:1441-1451`；`spawn.ts:537` 等 | **已证实（纠正）** |

---

## 最近验证时间与结论
- **验证时间**：2026-09-20（本轮）
- **已坐实**：#1 #2 #3 #4 #5 #6 #8
- **仍悬**：#7（需一次 `ps -ef | grep claude-agent-acp` 的进程树实测）
- **对上一版的改写**：R10 的判据从「网关 `wsSend` 成功」精确到「**本地 socket 写回调成功**」；R3「全仓无 SIGKILL」被纠正为「ACP child 无，Hub 托管进程有」；新增 #1（store write 全坏）与 #5（close code 丢失）。

## 建议修复优先级（供裁决，本轮不实施）
1. `store-tools.ts:302` 补 `space` —— 1 行，解 6 周故障
2. `server.ts:2073` 的补发判据改为「App 层 ack」或至少「重连一律补发未确认卡片」
3. `disposeSessions()` 按 shepawSessionId 精确失效，而非全表 clear
4. `server.ts:1128` 接住 `(code, reason)` 并落日志
5. `engines.ts` 引入版本锁定
