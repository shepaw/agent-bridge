# shepaw-dsh-plugin

把 [Shepaw](https://shepaw.com) 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 cordis 插件：在 DSH 进程内挂一个 **Shepaw ACP v2.1** 服务器（WebSocket + Noise，按设备公钥白名单授权），把 Shepaw 的每一条 `agent.chat` 路由进一个 DSH Agent，并把 DSH 的持久会话事件流回推成 `ui.textContent` 增量。

对比「网关 → `npx @deepseek-ai/dsh-acp-demo`」这条路，本插件跑在**完整 DSH 运行时**（`@deepseek-ai/dsh`，自带 `dsh-llm-deepseek` / `dsh-sandbox-local` / `dsh-bash-sandbox` 等全部叶子插件）里，天然绕开独立 ACP demo 包缺叶子插件的问题。

## 架构

```
Shepaw app  ──Shepaw ACP v2.1 (WS+Noise)──►  shepaw-dsh-plugin (ACPAgentServer)
                                                  │  onChat / followup / session events
                                                  ▼
                              ctx.agents.create/resume → DSH Agent loop
```

## 前置条件

- Node.js ≥ 22.19（DSH 要求；`shepaw-acp-sdk` 只需 ≥ 18.17）
- 一个能跑起来的 DSH profile：`llm-deepseek` 适配器、sandbox、bash、approval 等已就绪（`dsh-base` / 官方 `web` / `headless` bundle 已含）
- `DEEPSEEK_API_KEY`

## 安装

```sh
# 1. 建/进入一个 profile，把本插件装进它的 node_modules
dsh plugin --profile my-shepaw add shepaw-dsh-plugin
# 本地开发（未发布）改用路径安装，先在本目录 `npm run build` 产出 dist：
#   npm run build
#   dsh plugin --profile my-shepaw add file:../agent-bridge/implementations/dsh-shepaw-plugin

# 2. 把 composition 入口写进 profile 的 cordis.patch.yml（见本目录 cordis.patch.yml）
#    - id: shepaw-bridge
#      name: 'shepaw-dsh-plugin'
#      config: { host: 0.0.0.0, port: 8080 }

# 3. 启动
dsh --profile my-shepaw
```

`@deepseek-ai/*` 是 peerDependencies，运行时从宿主的 DSH 安装解析（`dsh plugin add` 不会重复装一份 cordis/dsh）。

## 配对（Shepaw app）

插件启动后会在 stdout 打印 ACP banner（`Agent ID` / `Fingerprint` / `ACP WS:` URL）。授权该设备公钥后，把 URL（含 `#fp=` 片段）粘贴进 Shepaw app 扫码即可：

```sh
# 与 shepaw-acp-sdk 的 peers CLI 等价；或直接用 SDK 的 addPeer
shepaw-acp-peers add <base64-pubkey> --label "My iPhone"
```

多实例时建议用 `config.identityPath` / `config.peersPath` 把身份与白名单隔离到各自目录（默认落在 `~/.config/shepaw-cb-gateway/`；Windows 下同样落在 `%USERPROFILE%\.config\shepaw-cb-gateway\`）。

## 与 Hub 的 peer 通道 / 配对

插件沿用 Shepaw ACP v2.1（Noise IK + 按设备公钥白名单），并复用 `ACPAgentServer` 的默认解析：

- 身份/白名单/配对码：自动读取 `SHEPAW_IDENTITY_PATH` / `SHEPAW_PEERS_PATH` / `SHEPAW_ENROLLMENTS_PATH`；Hub 启动实例时会注入这三个变量，指向 Hub 的**共享 peer 身份**。
- 通道 inbox：自动读取 `PAW_ACP_MAILBOX_SERVER_URL` / `PAW_ACP_MAILBOX_CHANNEL_ID` / `PAW_ACP_MAILBOX_SECRET`，接入 Hub 的**共享 channel 隧道**（router 持有唯一设备隧道，实例走 loopback 收件箱）。
- 监听地址：Hub 启动实例时会注入 `SHEPAW_DSH_HOST` / `SHEPAW_DSH_PORT`（**优先于** cordis.patch.yml 里的 `host`/`port`）；独立运行时回退到 cordis.patch.yml 的默认值 `0.0.0.0:8080`。
- 权限预设：自动读取 `DSH_PERMISSION_MODE`（Hub 把实例的 sessionMode 注入到这里，DSH 的 sandbox-policy 据此生效）。

因此由 Hub 拉起的 DSH 实例共享同一套 peer 身份 + 白名单 + 通道，**app 只需对 peer 通道扫一次码**，无需再对该 DSH 实例单独扫码。独立运行（非 Hub 托管）时则是它自己的身份，才需要单独配对。

## DSH 版本与自升级

Hub 一键安装会 pin 一个**经测试**的 DSH 版本（见仓库根目录 `scripts/setup-deepseek-harness.sh` 里的 `DSH_VERSION`，或 Web 面板 Engine Management 的安装命令）。这个 pin **只影响新用户的一键安装**，运行时 Hub 只检查 PATH 上是否存在 `dsh` 命令，**不会**强制版本必须与 pin 一致。

你可以随时自行升级本地 DSH，例如：

```sh
npm install -g @deepseek-ai/dsh@latest
dsh --version
```

升级后 Hub 会直接使用新版 `dsh --profile shepaw` 启动实例。插件的 `@deepseek-ai/*` 是 peerDependencies（`*`），运行时从宿主 DSH 解析，**不捆绑固定版本的 DSH**。

**兼容性预期：**

- 同一大版本线内的 rc / patch 升级（如 `0.1.1-rc.2` → `0.1.1-rc.3`）通常可直接使用，无需更新插件。
- 若 DSH 改了插件依赖的 API（`ctx.agents`、`approval/request`、`session/event` 等），可能需要等 `shepaw-dsh-plugin` 跟进更新。

**自升级后若异常，按顺序排查：**

```sh
# 1. 确认 shepaw profile 仍挂载插件
dsh --profile shepaw --dump-config | grep shepaw-bridge

# 2. 若组合树里没有 shepaw-bridge，重新安装插件
bash scripts/setup-deepseek-harness.sh
# 或手动：
#   dsh plugin --profile shepaw add file:.../implementations/dsh-shepaw-plugin

# 3. 仍不行时，回退到 Hub 当前 pin 的版本（见 setup-deepseek-harness.sh 的 DSH_VERSION）
npm install -g @deepseek-ai/dsh@<pin版本>
```

也可先用 `dsh web` 单独验证 API Key 和模型配置是否正常（`~/.dsh/settings.yaml` / `~/.dsh/.credentials.yaml` 会被 `shepaw` profile 共用）。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | Shepaw WS 监听地址 |
| `port` | `8080` | Shepaw WS 端口 |
| `name` | `DeepSeek Harness` | 展示给 Shepaw app 的 agent 名 |
| `cwd` | `process.cwd()` | 新 DSH 会话的工作目录（绝对路径） |
| `identityPath` / `peersPath` / `enrollmentsPath` | 默认路径 | 身份 / 白名单 / 一次性配对码存储路径 |
| `maxConcurrency` | `5` | 并发 chat 任务上限 |
| `provider` / `model` | profile 的 `agentDefaultModel` | 模型路由覆盖 |

## 协议映射

| Shepaw 侧 | DSH 侧 |
|---|---|
| `agent.chat` | `ctx.agents.create/resume` + `agent.followup(createUserMessage(...))` |
| `ui.textContent` 流式 | `session/event` 里 `assistant/chunk` 的 `text-delta` |
| `agent.cancelTask` | `agent.cancel({ kind: 'user' })` |
| DSH 权限审批（`approval/request`） | `sendActionConfirmation` + `waitForResponse` → `allowed-once`/`rejected` |
| `agent.sessions.list` / `history` | `ctx.agents.list()` + `session.events` 重放 |

## 已知限制

- **流式粒度**：按 `assistant/chunk`（token 级）回推，但 `onChat` 的收尾以 `turn/end` + `whenIdle()` 为准；一个 Shepaw turn 对应一个 DSH turn。
- **会话持久化**：当前复用进程内 live agent（`ctx.agents.get`）；跨进程恢复历史需在 `ensureAgent` 里改走 `ctx.agents.resume`（要求 DSH 配置了 `dsh-session-persistence-jsonl`）。
- **审批**：用 `waitForResponse`（阻塞式）桥接，超时/取消按 fail-closed 处理。
- **模型路由**：默认读 `agentDefaultModel`；覆盖需同时给 `provider` + `model`。

## 开发

```sh
npm install            # 安装 devDeps（含 @deepseek-ai/* 类型）后可 typecheck
npm run build          # tsup → dist/index.js（@deepseek-ai/* 保持 external）
npm run typecheck
```

> 本仓库的 workspace 内未默认安装 `@deepseek-ai/*`；`npm run build` 因把 `@deepseek-ai/*` 标为 external，不装也能出包。`npm run typecheck` 需要先装齐 devDeps。
