# Shepaw Agent Hub 部署指南

本文说明如何将 **agent-bridge** 仓库中的 **Shepaw Agent Hub**（`shepaw-hub`）部署到一台主机上，并通过 Shepaw 手机 App 连接、使用本机上的 Agent 实例。

Hub 的典型形态是：**单机或 VM 上运行 CLI + Web 仪表盘 + 若干 Agent 子进程**。  
Docker / systemd 示例见 **[DOCKER.md](./DOCKER.md)**（`deploy/` 目录）；以下步骤以裸机部署为准。

---

## 架构概览

```
Shepaw App (手机)
    │
    ├─ 局域网 ──► Peer 服务 (:18793 /peer/ws) ──► 各 Agent 实例 (loopback :8090+)
    │
    └─ 外网 ───► Channel Service ──► 隧道路由器 (:18789) ──► Peer / Agent
```

| 组件 | 作用 | 默认端口 |
|------|------|----------|
| **Web 仪表盘** | 管理实例、引擎、Peer 配对、Channel | `4000` |
| **Peer 服务** | `shepaw://peer` 扫码配对，代理手机与全部实例的对话 | `18793` |
| **隧道路由器** | 共享 Channel 入站流量分发到本机 Agent / Peer | `18789`（本地） |
| **Agent 实例** | `shepaw-acp-proxy` 子进程，对接上游 CLI（Claude Code 等） | 自 `8090` 起递增 |

配置与状态目录：`~/.config/shepaw-hub/`（可通过 `SHEPAW_HUB_HOME` 覆盖）。

---

## 一、环境准备

| 要求 | 说明 |
|------|------|
| **Node.js** | ≥ 18.17（见仓库根目录 `package.json`） |
| **操作系统** | macOS / Linux / Windows |
| **Shepaw App** | iOS / Android，用于 Device Pairing 扫码与对话 |
| **上游 Agent CLI** | 按所选引擎安装，例如 `claude-code`、`cursor-agent`、`codex` 等 |
| **引擎凭据** | 各引擎 API Key 或登录态（在「设置 → 引擎管理」或实例环境变量中配置） |
| **Channel 服务**（外网可选） | Shepaw Channel Service 的 URL、Channel ID、HMAC Secret |

---

## 二、构建与安装

```bash
git clone <repo-url> agent-bridge
cd agent-bridge

npm install
npm run build
```

安装 CLI（二选一）：

```bash
# 方式 A：全局 link
cd agent-hub/cli && npm link

# 方式 B：直接调用构建产物
node agent-hub/cli/dist/cli.js <子命令>
```

初始化 Hub 配置目录：

```bash
shepaw-hub init
```

---

## 三、配置引擎

在 Web 仪表盘打开 **设置 → 引擎管理**，或使用 CLI：

```bash
shepaw-hub engine list
shepaw-hub engine install <engine-id>   # 部分引擎支持一键安装
```

为引擎配置默认凭据（如 `ANTHROPIC_API_KEY`、`CURSOR_API_KEY`）。引擎未就绪时，创建或启动实例会失败。

---

## 四、注册并启动 Agent 实例

### CLI

```bash
shepaw-hub instance add my-agent \
  --engine claude-code \
  --cwd /path/to/your/project \
  --label "我的工作区"

shepaw-hub instance start my-agent
shepaw-hub instance-list
```

### Web 仪表盘

默认仅监听本机（安全）：

```bash
shepaw-hub web --host 127.0.0.1 --port 4000
```

若必须在局域网访问 Dashboard，**必须**设置鉴权 token，并显式绑定：

```bash
export SHEPAW_HUB_TOKEN="$(openssl rand -hex 24)"
shepaw-hub web --host 0.0.0.0 --port 4000 --no-open
```

浏览器打开后，在 DevTools Console 执行一次（或写入本地设置）：

```js
localStorage.setItem('shepaw_hub_token', '<你的 SHEPAW_HUB_TOKEN>')
```

未设置 `SHEPAW_HUB_TOKEN` 时，`--host 0.0.0.0` 会被拒绝启动。

浏览器访问 `http://<主机>:4000`，通过 **Add Instance** 创建并启动实例。

> **说明**：添加实例时无需填写 per-instance channel。共享 Channel 在 **设置 → Peer 配对** 中统一配置。高级 tunnel 三项（Server URL、Channel ID、Secret）须**同时填写或全部留空**，否则会阻止提交。

---

## 五、启动后台服务

### 1. Peer 服务（推荐：手机 Device Pairing 扫码）

```bash
shepaw-hub peer-start
shepaw-hub peer-pair          # 终端输出 shepaw://peer 二维码
```

- 手机与 Hub **同一局域网**时，扫二维码即可配对。
- Peer 启动时会将 **Peer 服务公钥** 写入各实例的 `authorized_peers.json`。若缺失，Agent 日志会出现 `4405 unauthorized peer`。

在 App 中使用 **Device Pairing / Scan to Connect** 扫码（**不是** Add Agent 的 `shepaw://pair` 入口）。

### 2. 共享 Channel + 隧道路由器（外网访问，可选）

**Web**：**设置 → Peer 配对** → 填写 Channel → 启动隧道路由器。

**CLI**：

```bash
shepaw-hub gateway-set-channel \
  --server https://channel.example.com \
  --channel-id ch_xxx \
  --secret <hmac-secret>

shepaw-hub gateway-start
```

重新执行 `shepaw-hub peer-pair`（或仪表盘生成配对码），二维码将同时包含局域网入口（`local=`）与 Channel 远程入口（`channel=`）。

### 3. Web 仪表盘（管理界面）

```bash
# 本机（推荐）
shepaw-hub web --host 127.0.0.1 --port 4000

# 局域网：必须设置 SHEPAW_HUB_TOKEN
export SHEPAW_HUB_TOKEN="$(openssl rand -hex 24)"
shepaw-hub web --host 0.0.0.0 --port 4000 --no-open
# 浏览器端：localStorage.setItem('shepaw_hub_token', '<token>')
```

未设置 token 时，非 loopback 绑定会被拒绝。公网暴露时仍建议前置 HTTPS 反向代理。

---

## 六、手机配对与使用

1. 确保 Peer 服务已启动，且至少有一个实例处于 **running / online**。
2. 打开 Shepaw App → **Device Pairing / Scan to Connect**。
3. 扫描 Hub 生成的 `shepaw://peer` 二维码。
4. 配对成功后，可通过 Peer 通道访问本机**全部已授权实例**。

---

## 七、部署后检查

```bash
shepaw-hub instance-list       # 实例状态
shepaw-hub peer-status         # Peer 服务
shepaw-hub gateway-status      # 隧道路由器（若启用外网）
shepaw-hub logs <instance-id> -f
```

| 现象 | 处理 |
|------|------|
| `unauthorized peer rejected` | 重启 Peer：`shepaw-hub peer-stop` → `shepaw-hub peer-start` |
| 外网无法连接 | 确认 Channel 已保存且 `gateway-start` 在运行 |
| 引擎启动失败 | 检查引擎安装、API Key、实例 `cwd` 是否存在 |
| 添加实例被 channel 校验拦住 | 高级 tunnel 字段要么三项全填，要么全部留空 |

---

## 八、生产化建议

仓库未内置进程守护与容器编排，长期运行时可自行补充：

1. **进程守护**：使用 `systemd`、`launchd` 或 `pm2` 托管 `web`、`gateway`、`peer` 及各实例。
2. **数据备份**：定期备份 `~/.config/shepaw-hub/`（`hub.json`、各实例的 identity / peers / sessions）。
3. **安全**：Dashboard 勿裸奔公网；妥善保管 Channel Secret 与 API Key。
4. **网络**：Agent 默认绑定 loopback；外网流量经 Channel 出站，无需对公网开放实例端口。

---

## 快速路径

### 最小可用（同一 WiFi）

```text
npm install && npm run build
shepaw-hub init
shepaw-hub instance add demo --engine claude-code --cwd ~/project
shepaw-hub instance start demo
shepaw-hub peer-start
shepaw-hub web --no-open
# 生成 peer 配对码 → App Device Pairing 扫码
```

### 外网可用

在最小路径基础上增加：

```text
配置 Channel（UI：设置 → Peer 配对，或 gateway-set-channel）
shepaw-hub gateway-start
shepaw-hub peer-start
重新生成 peer 配对码
```

---

## 仅部署单个 Agent（不用 Hub）

若只需单进程网关、不需要多实例管理，参见仓库根目录 [README.md](../README.md) 与 [implementations/acp-proxy-ts/README.md](../implementations/acp-proxy-ts/README.md)。

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [agent-hub/README.md](../agent-hub/README.md) | CLI 命令与 API 参考 |
| [CHANNEL_PROXY_GUIDE.md](../CHANNEL_PROXY_GUIDE.md) | Channel 隧道协议细节 |
| [SECURITY.md](../SECURITY.md) | ACP v2.1 安全模型与配对说明 |
