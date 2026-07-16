# Docker & systemd（Shepaw Agent Hub）

Hub 依赖本机 Agent CLI（Claude Code / Cursor / Codex 等），容器内完整复刻「全家桶」成本高。  
推荐两种形态：

1. **裸机 / VM + systemd**（生产默认）— 与 [deployment.md](./deployment.md) 一致  
2. **Docker 仅跑 Web 仪表盘 API**（可选）— 实例与 Peer 仍在宿主机，用 `network_mode: host` 或挂载 `SHEPAW_HUB_HOME`

仓库提供：

| 路径 | 说明 |
|------|------|
| [`deploy/Dockerfile`](../deploy/Dockerfile) | 构建 `shepaw-hub` CLI + API/UI 产物 |
| [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) | 示例：host 网络 + 配置卷 |
| [`deploy/systemd/`](../deploy/systemd/) | `shepaw-hub-web` / `gateway` / `peer` unit 示例 |

## Docker 快速试用（host 网络）

```bash
cd agent-bridge
docker compose -f deploy/docker-compose.yml up --build
```

环境变量：

```bash
# 非 loopback 绑定时必须
export SHEPAW_HUB_TOKEN="$(openssl rand -hex 24)"
```

浏览器打开 `http://127.0.0.1:4000`。若 compose 使用 `--host 0.0.0.0`，务必设置 `SHEPAW_HUB_TOKEN`。

限制：

- 容器内通常**没有**你的 Claude/Cursor 登录态；创建/启动实例更适合在宿主机 CLI 完成
- Channel 隧道、Peer 配对端口需在宿主机放行（见 deployment.md 端口表）

## systemd（推荐）

```bash
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shepaw-hub-web
# 可选外网：
# sudo systemctl enable --now shepaw-hub-gateway shepaw-hub-peer
```

编辑 unit 中的 `User=`、`WorkingDirectory=`、`Environment=SHEPAW_HUB_HOME=`、`SHEPAW_HUB_TOKEN=`。

## 与 Channel 的关系

外网手机接入家里 Hub 时，另外部署 [channel](../../channel/) 中继（自有 Dockerfile），再在 Hub 执行 `gateway-set-channel` + `gateway-start`。详见 deployment.md「外网」一节与 channel 的 `docs/DOCKER_PRODUCTION.md`。
