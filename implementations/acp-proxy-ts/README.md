# Shepaw ACP Proxy Gateway

Unified gateway that connects the [Shepaw](https://shepaw.com) mobile app to any
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) compatible coding agent.

## Phase 2 capabilities

- **Session resume** — after gateway restart or upstream idle death, restores
  upstream ACP sessions via `session/resume` (preferred) or `session/load`
  (incl. Cursor load-only), using `sessions.json` mappings. Hung restores are
  bounded by a timeout that restarts the upstream agent before falling back to
  `session/new`.
- **Run / permission mode** — after `session/new` / resume / load, applies the instance
  `PAW_ACP_SESSION_MODE` (Cursor run mode `auto-review`/`allowlist`/`unrestricted` via
  `--auto-review`/`--force` + `approvalMode` config when advertised; Claude
  `acceptEdits`, Codex `on-request`/`never`, OpenCode `build`/`plan`, …) via
  `session/set_config_option` or `session/set_mode`. Unset leaves the agent's default.
  The App can list/switch modes the same way as models (`agent.modes.list` /
  `agent.modes.setCurrent`, peer frames `agent_modes_req` / `agent_modes_set_req`).
  Remaining `session/request_permission` calls are forwarded to the App
  (`PAW_ACP_APPROVAL_MODE` defaults to `ask`).
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
shepaw-acp-proxy serve --engine my-agent --engine-display-name "My Agent" \
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

**Hub peer store (paired devices, no Nexuspouch required):** when
`shepaw-hub` peer service is running, it exposes the same `/api/v1/*` store
HTTP surface on the peer port (default `18792`) and serves `store.*` frames
over the Noise peer channel. Point tools at the hub with:

```bash
export SHEPAW_HUB_STORE_URL=http://127.0.0.1:18792
# or
export SHEPAW_PEER_STORE=1
```

Gateway sessions then inject a stdio MCP (`shepaw-peer-store` →
`dist/peer-store-mcp.js`) so upstream agents get `store_read` / `store_list` /
`store_meta` / `store_write` automatically (skipped if `NEXUSPOUCH_ROOT` is
already set; force both with `SHEPAW_PEER_STORE_FORCE=1`).

`StoreToolsClient` (`src/store-tools.ts`) + `resolveHubStoreBase`
(`src/hub-store-env.ts`) talk to that API. Agents should pass `store://`
URIs verbatim (`store://files/<device-id>/…`); after pairing, remote device
spaces are readable over the shared peer channel (live owner preferred,
master mirror as backup).

**`shepaw store` CLI shim (shell access for external agents):** the shepaw
app's `[implicit]` hint tells agents to read `store://` URIs with
`shepaw store read --uri <uri-as-is>`. When any store backend above is
configured, the gateway writes a tiny `shepaw` executable into a shim dir
(`$TMPDIR/shepaw-acp-proxy-<uid>/bin`) and prepends it to the upstream
agent's `PATH`, so the hint works verbatim from the agent's shell tool. The
shim execs `dist/shepaw-cli.js` (`src/shepaw-cli.ts`), which speaks the same
`/api/v1` store API and prints a single JSON envelope
(`{"success":true,…}` / `{"success":false,"error":…}`, exit 1 on failure),
matching the built-in Dart CLI's `content` / `content_base64` shapes:

```bash
shepaw store read --uri store://files/<device-id>/docs/a.txt
shepaw store write --filename report.md --content "# Q2" \
  [--task t1] [--owner <agent|group>] [--channel <session>] [--space runtime]
shepaw store list|meta --uri store://…

Default write space is **runtime** (aligned with the Shepaw App):

`store://runtime/<device>/<owner>/<channel>/artifacts/<task>/<file>`

Owner/channel are taken from CLI flags, then `SHEPAW_STORE_OWNER` /
`SHEPAW_STORE_CHANNEL` / `SHEPAW_STORE_AGENT_ID`, then the per-turn
`store-context.json` updated by the gateway on each chat. Pass
`--space artifacts` only for legacy flat URIs.
```

Backend resolution order mirrors the transcript sink: `NEXUSPOUCH_URL` → hub
peer store → `http://127.0.0.1:8787` when `NEXUSPOUCH_ROOT` is set. Disable
the shim with `SHEPAW_STORE_CLI=off` (overrides: `SHEPAW_STORE_CLI_SCRIPT`,
`SHEPAW_STORE_CLI_SHIM_DIR`). This complements, not replaces, the MCP
`store_*` tools — tool-native agents use MCP, hint-following agents use the
CLI.

**Device pouch card:** on the first prompt of each Shepaw session, the gateway
prepends a short card: the pouch is this device's `store://<space>/<device_id>/…`
tree; placement follows space partitions (`files` / `public` / `runtime` /
`memory` / `workspaces` / `backups`). `device_id` comes from
`SHEPAW_HUB_STORE_DEVICE` or `NEXUSPOUCH_DEVICE` when set. Disable with
`SHEPAW_STORE_POUCH_CARD=off`. The card is skipped when no store backend is
configured.

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

Built-in `--engine` ids match Hub's catalog (Paseo's 39 providers plus OpenClaw,
ZCode, and DeepSeek Harness). Common ones:

| `--engine`   | Upstream command |
|-------------|------------------|
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| `codex`       | `npx -y @agentclientprotocol/codex-acp@latest` |
| `cursor`      | `agent acp` |
| `gemini`      | `npx -y @google/gemini-cli@latest --acp` |
| `copilot`     | `copilot --acp` |
| `pi`          | `npx -y pi-acp` |
| `qwen-code`   | `qwen --acp` |

See `agent-hub/core/src/engine-catalog.ts` for the full list. Unknown ids can
still be launched with `--acp-command`.

## Quick start

```sh
npm install -g shepaw-acp-proxy-gateway

# Terminal 1 — bind to LAN so the phone can reach the gateway
shepaw-acp-proxy serve --engine claude-code --cwd ~/your-project --host 0.0.0.0

# Terminal 2 — print the pairing QR (LAN address auto-detected)
shepaw-acp-proxy pair
```

In the Shepaw app choose **Add agent → scan the QR**. The single-use code is
redeemed during the Noise handshake; the device's public key lands in
`authorized_peers.json` automatically.

Pairing outside your LAN (reverse tunnel / channel service):

```sh
shepaw-acp-proxy serve --engine codebuddy --cwd ~/your-project \
  --tunnel-server wss://channel.example.com --tunnel-channel-id <id> --tunnel-secret <secret>
shepaw-acp-proxy pair --base-url wss://channel.example.com/proxy/<id>
```

Manual fallback (no QR): `shepaw-acp-proxy peers add <base64-pubkey>` with the
pubkey from the app's "Add agent" screen.

From a source checkout, replace `shepaw-acp-proxy` with
`node implementations/acp-proxy-ts/dist/cli.js` after `npm install && npm run build`.

List engines:

```sh
shepaw-acp-proxy engines
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
