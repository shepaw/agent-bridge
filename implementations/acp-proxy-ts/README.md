# Shepaw ACP Proxy Gateway

Unified gateway that connects the [Shepaw](https://shepaw.com) mobile app to any
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) compatible coding agent.

## Phase 2 capabilities

- **Session resume** — after gateway restart, restores upstream ACP sessions via
  `session/resume` (preferred) or `session/load`, using `sessions.json` mappings
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

## Supported upstream agents

| `--engine`   | Upstream command |
|-------------|------------------|
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| `tclaude`     | same as `claude-code` (internal auth/model routing wrapper) |
| `codebuddy`   | `codebuddy --acp` |
| `codex`       | `npx -y @zed-industries/codex-acp@latest` |
| `tcodex`      | same as `codex` (internal auth/model routing wrapper) |
| `opencode`    | `npx opencode-ai@latest acp` |
| `openclaw`    | `npx openclaw acp` |
| `cursor`      | `agent acp` |
| `hermes`      | `hermes acp` |

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
