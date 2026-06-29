# Shepaw ACP Proxy Gateway

Unified gateway that connects the [Shepaw](https://shepaw.com) mobile app to any
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) compatible coding agent.

Instead of wrapping each vendor SDK directly, this gateway:

1. Speaks **Shepaw ACP v2.1** to the mobile app (WebSocket + Noise encryption)
2. Acts as an **ACP Client** to a subprocess using `@agentclientprotocol/sdk`
3. Spawns the industry-standard ACP entry point for the selected agent

## Supported upstream agents

| `--engine`   | Upstream command |
|-------------|------------------|
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| `codebuddy`   | `codebuddy --acp` |
| `codex`       | `npx -y @zed-industries/codex-acp@latest` |
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
