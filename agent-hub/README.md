# Shepaw Agent Hub

A unified supervisor for managing multiple Shepaw ACP agent projects, accessible from both the **command line** and a **web dashboard**.

## Overview

Agent Hub replaces the old `implementations/shepaw-agent-hub` with a properly layered monorepo workspace:

```
agent-hub/
├── core/    @shepaw/agent-hub-core   — Business logic (config, process lifecycle, logs)
├── api/     @shepaw/agent-hub-api    — Express REST API + WebSocket log streaming
├── ui/      @shepaw/agent-hub-ui     — React dashboard (Vite)
└── cli/     shepaw-agent-hub         — CLI binary: shepaw-hub
```

---

## Quick Start

### Install

```bash
# One-liner
curl -fsSL https://raw.githubusercontent.com/shepaw/agent-bridge/main/scripts/install.sh | bash

# Or npm
npm install -g shepaw-agent-hub    # provides the `shepaw-hub` binary
```

From a source checkout instead: `npm install && npm run build` at the repo
root, then `cd agent-hub/cli && npm link`.

### CLI

```bash
# Initialize config directory (~/.config/shepaw-hub/)
shepaw-hub init

# One-shot: dashboard + Peer (then add instances in the browser)
shepaw-hub web

# Or register a project manually
shepaw-hub instance add --engine codebuddy --cwd /path/to/workspace --host 0.0.0.0

# Start it (use the id printed by `instance add` / `quickstart`)
shepaw-hub start <id>

# Check status
shepaw-hub status

# Pair a mobile device (QR code in terminal)
shepaw-hub pair <id>

# Diagnose setup issues
shepaw-hub doctor

# Update to the latest npm release
shepaw-hub update

# Verify a running instance (HTTP; add --rpc / --chat for deeper probes)
shepaw-hub test <id> --rpc

# View live logs
shepaw-hub logs <id> -f
```

### Web Dashboard

```bash
# Start the dashboard (opens browser, auto-starts Peer for app pairing)
shepaw-hub web

# Custom port / host
shepaw-hub web --port 8080 --host 0.0.0.0

# Start without auto-opening browser
shepaw-hub web --no-open

# Dashboard only (do not start Peer / tunnel router)
shepaw-hub web --no-peer --no-gateway
```

The dashboard runs on `http://127.0.0.1:4000` by default.

Language: the dashboard follows the browser language (Chinese or English) and
remembers the choice in the top-right **中文 | English** switcher.

**First run:** `shepaw-hub web` starts Peer in the background. Open the UI and
**添加实例** (engine + working directory). The instance starts automatically;
pair the phone under **扫码配对**.

---

## CLI Reference

### Initialization

| Command | Description |
|---------|-------------|
| `shepaw-hub init` | Create `~/.config/shepaw-hub/` and `hub.json` (idempotent) |
| `shepaw-hub doctor` | Pre-flight diagnostics: Node version, gateway package, engine CLIs, per-instance state and port conflicts. `--full` adds engine version / remote auth probes. Exits non-zero on hard failures |
| `shepaw-hub quickstart` | Interactive onboarding: probe engines → pick one → set cwd → start on LAN (`0.0.0.0`) → print pairing QR. Flags: `--engine`, `--cwd`, `--label`, `--yes`, `--no-qr` |
| `shepaw-hub test [id]` | Connectivity probe. Default: HTTP `/status`. `--rpc` adds Noise WS + `agent.sessions.list`. `--chat` sends a short turn (auto-approves tools). Exits non-zero on failures |

### Project Management

| Command | Description |
|---------|-------------|
| `shepaw-hub project add <id>` | Register a new agent project |
| `shepaw-hub project list` | List all registered projects with status |
| `shepaw-hub project show <id>` | Show detailed info for one project |
| `shepaw-hub project remove <id>` | Unregister a project (stops it first if running) |
| `shepaw-hub project update <id>` | Patch label / host / baseUrl / cwd / extra-args |

**Options for `project add`:**

```
--engine <engine>     Gateway type: codebuddy | claude-code | codex | opencode  (default: codebuddy)
--cwd <dir>           Working directory for the gateway      (default: current dir)
--label <text>        Display name
--port <n>            Bind port                              (default: next free from 8090)
--host <host>         Bind host                              (default: 127.0.0.1)
--base-url <url>      Base WS URL for pairing QRs (tunnel endpoint)
--extra-arg <arg>     Extra args forwarded to gateway serve  (repeatable)
```

### Lifecycle

| Command | Description |
|---------|-------------|
| `shepaw-hub start <id>` | Spawn the gateway process (detached, survives hub exit) |
| `shepaw-hub stop <id>` | Graceful stop (SIGTERM → SIGKILL after 5s; Windows: TerminateProcess) |
| `shepaw-hub status [id]` | Show running state for one or all projects |

### Logs

| Command | Description |
|---------|-------------|
| `shepaw-hub logs <id>` | Print last 50 lines of the gateway log |
| `shepaw-hub logs <id> -f` | Follow the log (tail -f style) |
| `shepaw-hub logs <id> --tail 100` | Print last 100 lines |
| `shepaw-hub logs rotate <id>` | Force log rotation |

### Pairing & Enrollment

| Command | Description |
|---------|-------------|
| `shepaw-hub pair <id>` | Mint a single-use pairing code + QR for the Shepaw app |
| `shepaw-hub enroll <id>` | Alias for `pair` |
| `shepaw-hub enroll list <id>` | Show outstanding pairing codes |
| `shepaw-hub enroll revoke <id> <code>` | Cancel an unused code |

### Peer Management

| Command | Description |
|---------|-------------|
| `shepaw-hub peers list <id>` | List authorized devices for a project |
| `shepaw-hub peers add <id> <pubkey>` | Authorize a device by public key |
| `shepaw-hub peers remove <id> <fingerprint>` | Revoke a device |

### Web Dashboard

| Command | Description |
|---------|-------------|
| `shepaw-hub web` | Start the dashboard at `http://127.0.0.1:4000` and auto-start Peer |
| `shepaw-hub web --port <n>` | Custom port |
| `shepaw-hub web --host <host>` | Custom bind host |
| `shepaw-hub web --no-open` | Skip auto-opening browser |
| `shepaw-hub web --no-peer` | Do not auto-start the device peer service |
| `shepaw-hub web --no-gateway` | Do not auto-start the tunnel router |

---

## Web Dashboard Features

| Feature | Description |
|---------|-------------|
| **Project CRUD** | Add, view, update, and remove agent projects directly from the UI |
| **QR Code + Tunnel Config** | Generate pairing codes with QR, support tunnel/proxy URLs for external connections |
| **Start / Stop** | One-click lifecycle control per project |
| **Real-time logs** | WebSocket-streamed log viewer with auto-scroll (tail N lines) |
| **Pair device** | Modal dialog for generating single-use enrollment codes |
| **Peer management** | View authorized devices and revoke access |
| **Session Resume** | List persisted Shepaw→ACP session mappings, copy session IDs, remove stale entries |
| **Auto-refresh** | Status polling every 3 seconds — CLI and Web stay in sync |

---

## REST API

The web server exposes a REST API at `/api`. All requests/responses use JSON.

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects with live status |
| `POST` | `/api/projects` | Register a new project |
| `GET` | `/api/projects/:id` | Get one project |
| `PATCH` | `/api/projects/:id` | Update project fields |
| `DELETE` | `/api/projects/:id` | Remove project (stops first) |
| `POST` | `/api/projects/:id/start` | Start gateway |
| `POST` | `/api/projects/:id/stop` | Stop gateway |

### Peers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects/:id/peers` | List authorized peers |
| `POST` | `/api/projects/:id/peers` | Add peer `{ pubkey, label? }` |
| `DELETE` | `/api/projects/:id/peers/:fp` | Revoke peer by fingerprint |

### Enrollment

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects/:id/enroll` | List outstanding pairing codes |
| `POST` | `/api/projects/:id/enroll` | Mint new code `{ label?, ttlMinutes? }` |
| `DELETE` | `/api/projects/:id/enroll/:code` | Revoke a pairing code |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects/:id/sessions` | List persisted Shepaw→ACP session mappings |
| `DELETE` | `/api/projects/:id/sessions/:shepawSessionId` | Remove a stale mapping |

### Custom engines

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/engines` | List built-in + custom engines |
| `POST` | `/api/engines` | Register `{ id, displayName, acpCommand }` |
| `DELETE` | `/api/engines/:id` | Remove a custom engine (409 if in use) |

### WebSocket Log Streaming

Connect to `ws://<host>:<port>/ws/logs/<projectId>[?tail=N]`.

**Server → client messages (JSON):**

```jsonc
{ "type": "data",  "text": "log chunk..." }   // log output
{ "type": "error", "text": "error message" }  // error
{ "type": "end" }                             // stream closed
```

**Client → server:**

```
"close"   // graceful disconnect
```

---

## Configuration

Hub state lives in `~/.config/shepaw-hub/` (or `$SHEPAW_HUB_HOME`):

```
~/.config/shepaw-hub/
├── hub.json                     — Project registry (version 1, mode 0600)
└── projects/
    └── <project-id>/
        ├── identity.json        — X25519 keypair (mode 0600)
        ├── authorized_peers.json
        ├── enrollments.json
        ├── state.json           — PID + timestamps
        └── logs/
            └── agent.log
```

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `SHEPAW_HUB_HOME` | Override the hub config directory |
| `XDG_CONFIG_HOME` | XDG base dir (Linux) |
| `SHEPAW_HUB_DEBUG` | Print stack traces on errors |

---

## Development

```bash
# Build all packages
npm run build -w agent-hub/core
npm run build -w agent-hub/api
npm run build -w agent-hub/ui
npm run build -w agent-hub/cli

# Or build everything from the monorepo root
npm run build

# Watch mode (individual packages)
npm run dev -w agent-hub/core
npm run dev -w agent-hub/api

# UI dev server (proxies /api and /ws to port 4000)
npm run dev -w agent-hub/ui

# Type-check
npm run typecheck -w agent-hub/core
```

---

## Architecture

```
  CLI (shepaw-hub)
       │
       ├── project add / start / stop / logs / pair / peers
       │         └── calls @shepaw/agent-hub-core directly
       │
       └── web
             └── starts @shepaw/agent-hub-api (Express + WS)
                        │
                        ├── REST  /api/*  ─── @shepaw/agent-hub-core
                        ├── WS   /ws/logs/:id ─── tailLog() stream
                        └── Static  /*  ─── @shepaw/agent-hub-ui/dist
```

Both CLI and Web read/write the **same** `~/.config/shepaw-hub/` files, so changes from one interface are immediately visible in the other.
