# shepaw-agent-hub

One CLI to manage multiple [Shepaw](https://shepaw.com) agent gateways on a
single host. Each project gets its own X25519 identity, its own authorized-peers
allowlist, and its own port — no shared secrets, no cross-project blast
radius if one project's keys leak.

Cross-platform: macOS, Linux, Windows.

## What it does

```
shepaw-hub start work-api        ┐
shepaw-hub start side-proj       ├─►  one `shepaw-hub` → N gateway processes
shepaw-hub start play-ground     ┘    each with its own identity + peers list

~/.config/shepaw-hub/
├── hub.json                  — list of projects (id, cwd, port, engine)
└── projects/
    ├── work-api/             — independent: identity, peers, enrollments, logs
    ├── side-proj/            — independent
    └── play-ground/          — independent
```

The hub is a **supervisor + config manager**, not a daemon. It spawns the
unmodified `shepaw-codebuddy-code-gateway` / `shepaw-claude-code-gateway`
binaries with three environment variables that point them at per-project
files:

```sh
SHEPAW_IDENTITY_PATH     # where the project's private key lives
SHEPAW_PEERS_PATH        # where the project's authorized devices live
SHEPAW_ENROLLMENTS_PATH  # where single-use pairing codes live
```

Shepaw app is **untouched**. You still add each agent to the app separately
(scan a QR, or paste URL + pairing code). The hub just makes the operator
side — the agent host — bearable.

## Install

```sh
npm install -g shepaw-agent-hub shepaw-codebuddy-code-gateway shepaw-claude-code-gateway
# (install only the engines you actually want)
```

Or build from source:

```sh
git clone <repo>
cd agent-bridge
npm install
npm run build --workspaces
```

## Quick start

```sh
# 1. Initialize the config dir (idempotent; re-run any time)
shepaw-hub init

# 2. Register a project (one per codebase)
shepaw-hub project add work-api \
    --engine codebuddy \
    --cwd ~/code/work-api \
    --label "Work API" \
    --base-url "wss://channel.shepaw.com/c/work-api"

# 3. Start the gateway (detached — hub exits, agent keeps running)
shepaw-hub start work-api

# 4. Pair your phone: prints a QR + 9-character short code
shepaw-hub pair work-api --label "My iPhone"

# 5. Open Shepaw, scan the QR, done.
```

## Project commands

```sh
shepaw-hub project add <id> [options]      # Register a new project
shepaw-hub project list                    # List all projects with status
shepaw-hub project show <id>               # Detailed info for one project
shepaw-hub project update <id> [options]   # Patch label / host / base-url / cwd / extra-arg
shepaw-hub project remove <id>             # Unregister (stops first if running)
```

`add` supports:

| Flag | Purpose |
|---|---|
| `--engine codebuddy \| claude-code` | Which gateway binary to spawn |
| `--cwd <dir>` | Working directory for the gateway |
| `--label <text>` | Display name in `status` |
| `--port <n>` | Explicit port; omit to get next free from 8090+ |
| `--host <host>` | Bind host (default 127.0.0.1; use 0.0.0.0 for LAN) |
| `--base-url <url>` | Base WS URL for pairing QRs (typically your Channel Service URL) |
| `--extra-arg=<arg>` | Pass-through to the gateway's `serve` command. Repeatable. Use `=` form to avoid cac consuming the arg: `--extra-arg=--model --extra-arg=claude-opus-4-7` |

## Lifecycle

```sh
shepaw-hub start <id>          # Spawn the gateway (detached). Idempotent.
shepaw-hub stop <id>           # Stop gracefully (SIGTERM on Unix; see Windows notes)
shepaw-hub status [<id>]       # Show running/stopped/crashed state
shepaw-hub logs <id> -f        # Tail the gateway's stdout/stderr
shepaw-hub logs rotate <id>    # Force log rotation (keeps last 7 segments, 10 MiB each)
```

## Pairing

```sh
shepaw-hub pair <id> --label "Alice's iPhone"
# Prints:
#   - 9-character short code (XXX-XXX-XXX, 10-minute TTL, single-use)
#   - QR code encoding `shepaw://pair?url=<WS URL>&code=<9-char code>`
#   - Project's Agent ID + 16-hex fingerprint for out-of-band verification

shepaw-hub enroll-list <id>              # Show outstanding codes
shepaw-hub enroll-revoke <id> <code>     # Cancel an unused code
```

Codes are transmitted inside the Noise-encrypted handshake payload — Channel
Service sees only AEAD ciphertext. See `SECURITY.md` in the parent repo for
the full threat model.

## Manual peer management

```sh
shepaw-hub peers list <id>                           # List authorized devices
shepaw-hub peers add <id> <base64-pubkey> [--label] # Authorize
shepaw-hub peers remove <id> <16-hex-fingerprint>   # Revoke; live sessions close 4411
```

Each project's allowlist lives in
`~/.config/shepaw-hub/projects/<id>/authorized_peers.json`. Changes are
picked up by the running gateway within ~100 ms via `fs.watch`.

## Cross-platform notes

### Windows

- **`stop` is a hard terminate**, not a graceful SIGTERM. Windows has no
  POSIX signal equivalent; `process.kill(pid)` maps to `TerminateProcess`.
  In-flight WebSocket sessions see a TCP RST, which the Shepaw app
  surfaces as a transient network error and auto-reconnects.
- **Console windows hidden** (`windowsHide: true`). The gateway runs
  without popping up a black terminal.
- **Config files in `%USERPROFILE%\.config\shepaw-hub\`** by default. Set
  `SHEPAW_HUB_HOME` or `XDG_CONFIG_HOME` to move them.
- **File permissions** (`0600` chmod) are skipped on Windows since ACLs
  don't map to Unix perm bits. The files still inherit NTFS ACLs from
  their parent directory. Rely on filesystem-level protection (user-only
  home directory).

### macOS / Linux

- `stop` sends SIGTERM, waits up to 5 seconds, then escalates to SIGKILL.
- Files are written atomically (`.tmp + rename`) with mode 0600.
- `fs.watch` is used for log follow; falls back to 500 ms polling on
  filesystems that don't support it (NFS, SMB mounts).

## Config directory

Resolution order (highest precedence first):

1. `$SHEPAW_HUB_HOME`
2. `$XDG_CONFIG_HOME/shepaw-hub/`
3. `~/.config/shepaw-hub/`

Programmatic override: `loadOrCreateHubConfig({ path: '...' })`.

## Log rotation

`rotating-file-stream` handles rotation:

- Cap per segment: 10 MiB
- Retained: last 7 rotated files (`agent.log.1`, `.2`, ...)
- Compression: off (keeps `tail`/`grep` work without `zcat`)

Force rotation: `shepaw-hub logs rotate <id>`. Wire into cron/Task Scheduler
for time-based rotation; the hub's supervisor does not auto-rotate on a
schedule.

## Programmatic API

The hub also exports a library API in case you want to script it:

```ts
import {
  loadOrCreateHubConfig,
  addProject,
  startProject,
  stopProject,
} from 'shepaw-agent-hub';
```

See the exports of `shepaw-agent-hub/dist/index.js`.

## Status

- v0.1: **supervisor only**. No web UI, no metrics endpoint, no
  cross-host orchestration. If you need those, run hub behind systemd /
  Task Scheduler with your own monitoring.

## License

Apache-2.0
