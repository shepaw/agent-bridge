# Nexuspouch MCP 接入示例

把任何支持 MCP 的 agent（Claude Code、Codex、Cursor、本地框架）接到
[Nexuspouch](https://github.com/nexuspouch/nexuspouch) store 节点上，
让 agent 直接获得 `store_write` / `store_read` / `store_list` 等工具：
产物以 `store://` URI 落盘、跨设备可寻址、数据默认不出用户硬件。

## 前置条件

1. 节点已运行（`nexuspouch --root ./data --listen :8787 --name home-nas`）；
2. 二进制在 PATH 中（`cargo install --path .` 或直接指绝对路径）；
3. 建议配置 scoped token（`--admin-token` / `NEXUSPOUCH_ADMIN_TOKEN`）。

## Claude Code

将 `claude_code.json` 合并进 Claude Desktop / Claude Code 的 MCP 配置，或直接：

```bash
claude mcp add nexuspouch -- nexuspouch mcp --root /var/lib/nexuspouch --token <scoped-token>
```

## Codex

追加到 `~/.codex/config.toml`（见 `codex.toml`）：

```toml
[mcp_servers.nexuspouch]
command = "nexuspouch"
args = ["mcp", "--root", "/var/lib/nexuspouch", "--token", "<scoped-token>"]
```

## Cursor

在 Cursor 的 MCP 设置里新增 server（见 `cursor.json`）。

## 零依赖 Node 客户端（验证用）

```bash
node mcp-client.mjs --root /var/lib/nexuspouch --token <scoped-token>
```

脚本会完成 initialize → tools/list → store_write → store_read 全链路并打印结果，
不依赖任何 npm 包（直接与 stdio MCP server 用 JSON-RPC 对话）。

## 暴露的工具

| 工具 | 作用 |
|------|------|
| `store_write` | 写文件，返回 `store://` URI |
| `store_read` / `store_read_chunk` | 读文件 / 分块读（base64） |
| `store_meta` / `store_list` | 元数据 / 列目录 |
| `store_search` | 检索（M5 接通） |
| `store_watch` | 事件订阅（M3 接通，当前返回 recent 环） |
| `store_space` | 空间占用与卷告警 |

## 与 acp-proxy 的关系

`acp-proxy-ts` 网关把 ShePaw App 接到 ACP agent（Claude Code / Codex / Cursor 等）。
这些 agent 自身支持 MCP，因此**当前推荐**在 agent 侧直接挂上述 MCP 配置即可获得
store 工具。网关侧原生注入 `store_*` 工具（无需 agent 单独配置）列为 M1.5 后续项。

## 说明

- `nexuspouch mcp` 复用节点本机的 `/api/v1`（loopback 或 Bearer token 鉴权），
  不另开端口；协议细节见 Nexuspouch `docs/AGENTS.md`。
- 引用纪律：agent 应原样传递 `store://` URI，不拼接、不构造（见 AGENTS.md §3）。
