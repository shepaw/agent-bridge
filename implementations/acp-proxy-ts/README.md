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

## Nexuspouch store tools (M1.5)

`src/store-tools.ts` provides a self-contained Nexuspouch HTTP client
(`StoreToolsClient`) with `store_write` / `store_read` / `store_meta` /
`store_list` tool definitions and a `executeStoreTool` dispatcher
(sha256-verified write path over the store frame API). It is ready to be
injected into the gateway tool pipeline; until that hook lands, agents reach
the same tools through the agent-side MCP config in `examples/mcp/`.

```ts
import { StoreToolsClient, executeStoreTool } from './src/store-tools.js';
const client = new StoreToolsClient('http://127.0.0.1:8787', '<token>', '<device>');
const out = await executeStoreTool('store_write',
  { filename: 't-1/out.md', content: '...', space: 'artifacts' }, client);
```

`npm test` (vitest) covers the write→read roundtrip and error mapping.
Recommended Node is 20 (see repo `.nvmrc` / Docker `node:20`); vitest 2.1 +
vite 5.4 also starts on Node 22. Prefer `nvm use` / Node 20 for local runs.

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
