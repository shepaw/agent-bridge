# Shepaw ACP Proxy Gateway

Unified gateway that connects the [Shepaw](https://shepaw.com) mobile app to any
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) compatible coding agent.

## Phase 2 capabilities

- **Session resume** — after gateway restart or upstream idle death, restores
  upstream ACP sessions via `session/resume` (preferred) or `session/load`
  (incl. Cursor load-only), using `sessions.json` mappings. Hung restores are
  bounded by a timeout that restarts the upstream agent before falling back to
  `session/new`.
- **Model picker** — maps ACP `configOptions` (category `model`) to Shepaw
  `agent.models.list` / `agent.models.setCurrent` via `session/set_config_option`
- **Terminal proxy** — runs shell commands on the gateway host when agents request
  `terminal/*` client methods
- **Hub default** — `shepaw-hub` spawns this gateway for all engine types

## Phase 3 capabilities

- **Per-project session store** — Agent Hub passes `--session-store-path` so each
  project keeps isolated `sessions.json` mappings
- **Hub session UI** — Web UI lists persisted sessions and supports copy/remove
- **Sessions CLI** — `sessions list` (local mappings) and `sessions acp-list`
  (upstream `session/list`)
- **Smarter load replay** — idle-based drain after `session/load` instead of a
  fixed 2s timeout

## Custom local engines

Built-in engines cannot cover every ACP CLI. Register your own:

```sh
# Agent Hub CLI
shepaw-hub engine add my-agent --display "My Local Agent" --command "my-cli acp"

# Gateway CLI (without Hub)
node dist/cli.js serve --engine my-agent --engine-display-name "My Agent" \
  --acp-command "my-cli acp" --cwd ~/project --port 8090
```

Custom engines are stored in `hub.json` under `customEngines` and appear in the Hub UI
**Custom Engines** dialog and project engine picker.

## Nexuspouch store tools

**Gateway MCP injection (preferred):** set `NEXUSPOUCH_ROOT` (and optional
`NEXUSPOUCH_ADMIN_TOKEN`) on the acp-proxy process. Session `new` / `resume` /
`load` then inject a stdio MCP server running `nexuspouch mcp`, so upstream
agents get `store_*` tools without per-agent MCP config. Disable with
`NEXUSPOUCH_MCP=off`. See `src/nexuspouch-mcp.ts`.

**Session transcript bypass (P3):** with a running Nexuspouch HTTP API, set
`NEXUSPOUCH_URL` (default `http://127.0.0.1:8787` when `NEXUSPOUCH_ROOT` is set),
`NEXUSPOUCH_DEVICE`, and `NEXUSPOUCH_ADMIN_TOKEN`. Each chat turn is debounced
(5s) into `store://sessions/<device>/<engine>/<session>.jsonl`. Disable with
`NEXUSPOUCH_TRANSCRIPT=off`.

**HTTP helper (optional):** `src/store-tools.ts` provides `StoreToolsClient` +
`executeStoreTool` for in-process HTTP against `/api/v1` (tests / custom hooks).

Agents can still use the agent-side MCP examples in `examples/mcp/`.

`npm test` (vitest) covers store-tools roundtrip and MCP injection env parsing.
Recommended Node is 20 (see repo `.nvmrc` / Docker `node:20`).

## Supported upstream agents

| `--engine`   | Upstream command |
|-------------|------------------|
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| `codebuddy`   | `codebuddy --acp` |
| `codex`       | `npx -y @agentclientprotocol/codex-acp@latest` |
| `opencode`    | `npx opencode-ai@latest acp` |
| `openclaw`    | `npx openclaw acp` |
| `cursor`      | `agent acp` |
| `hermes`      | `hermes acp` |
| `kimi`        | `kimi acp` |

## Quick start

```sh
cd implementations/acp-proxy-ts
npm install && npm run build

# Claude Code via ACP adapter
node dist/cli.js serve --engine claude-code --cwd ~/your-project --port 8090

# CodeBuddy (native ACP)
node dist/cli.js serve --engine codebuddy --cwd ~/your-project --port 8090

node dist/cli.js peers add <base64-pubkey> --label "My iPhone"
```

List engines:

```sh
node dist/cli.js engines
```

## Architecture

```
Shepaw App ── Shepaw ACP v2.1 ──► AcpProxyAgent (shepaw-acp-sdk)
                                      │
                                      │ @agentclientprotocol/sdk
                                      ▼
                               ACP subprocess (stdio JSON-RPC)
                               claude-agent-acp / codebuddy --acp / …
```

File operations and permission prompts from the upstream agent are handled on the
gateway host (the machine running the CLI), then surfaced to the phone via Shepaw UI.

## Agent Hub

When used with `shepaw-hub`, the hub spawns this gateway with `--engine` matching
the project's configured engine. Per-project identity, peers, and tunnel credentials
are injected via `SHEPAW_*` and `PAW_ACP_TUNNEL_*` environment variables.
