# shepaw-claude-code-gateway

Run [Claude Code](https://claude.com/claude-code) as an agent for the
[Shepaw](https://shepaw.com) mobile app — approve tool calls, fill in
clarifying questions, and watch the stream from your phone.

## What it does

```
Shepaw app (phone)  ──ACP JSON-RPC/WS──▶  shepaw-claude-code-gateway  ──@anthropic-ai/claude-agent-sdk──▶  Claude
       ▲                                         │
       └────── ui.actionConfirmation ────────────┘
              (every tool call routed here)
```

- Forwards every `canUseTool` from the Agent SDK to `ui.actionConfirmation`
  on the phone. Bash / Write / Edit / Read / Glob / Grep are all gated on
  user approval by default.
- Maps `AskUserQuestion` (Claude's clarifying-questions tool) to
  `ui.singleSelect` / `ui.multiSelect`.
- Persists the Claude Code SDK `session_id` per Shepaw session, so you
  can kill the gateway, restart it, and keep talking to the same thread.
- `agent.cancelTask` aborts the in-flight `query()` immediately.

## Install

```sh
npm install -g shepaw-claude-code-gateway
```

Or build from source:

```sh
git clone <repo>
cd agent-bridge
npm install
cd packages/claude-code-gateway
npm run build
```

## Run

```sh
# Minimal, LAN only
shepaw-claude-code serve --cwd ~/code/my-project --port 8090 --token my-secret

# With model + turn cap
shepaw-claude-code serve \
  --cwd ~/code/my-project \
  --port 8090 \
  --token my-secret \
  --model claude-opus-4-7 \
  --max-turns 20

# See all flags
shepaw-claude-code serve --help
```

Requires `ANTHROPIC_API_KEY` in the environment (standard Claude Agent SDK
authentication).

## Reach your desktop from outside the LAN (tunnel)

If your phone isn't on the same Wi-Fi as your desktop, open a reverse
tunnel to the Shepaw Channel Service. Use the Channel credentials from
your Shepaw app settings:

```sh
export PAW_ACP_TUNNEL_SERVER_URL=https://channel.example.com
export PAW_ACP_TUNNEL_CHANNEL_ID=ch_abc123
export PAW_ACP_TUNNEL_SECRET=ch_sec_xyz
# Optional: short-name endpoint shown in the public URL
export PAW_ACP_TUNNEL_ENDPOINT=myagent

shepaw-claude-code serve \
  --cwd ~/code/my-project \
  --port 8090 \
  --token my-secret
```

Or pass the flags inline:

```sh
shepaw-claude-code serve \
  --cwd ~/code/my-project \
  --port 8090 --token my-secret \
  --tunnel-server https://channel.example.com \
  --tunnel-channel-id ch_abc123 \
  --tunnel-secret ch_sec_xyz \
  --tunnel-endpoint myagent
```

When the tunnel comes up you'll see a `Public WS: wss://…` line — paste
that URL into the Shepaw app's "remote agent address" field (token same
as `--token`). The tunnel reconnects automatically (exponential backoff,
capped at 60s).

## Connect from the Shepaw app

Add a remote agent in Shepaw:

- **Address:** `ws://<your-host>:8090/acp/ws`
- **Token:** whatever you passed to `--token`

Then send a chat message. When Claude tries to use a tool, you'll get a
three-button confirmation on your phone (Allow / Allow & remember / Deny).

## Debug logs

Two debug namespaces:

```sh
# Just the agent-level lifecycle (permission requests, session resume, results)
DEBUG=shepaw:gateway shepaw-claude-code serve …

# Every JSON-RPC frame in and out (verbose)
DEBUG=shepaw:wire shepaw-claude-code serve …

# Both
DEBUG=shepaw:* shepaw-claude-code serve …
```

## Status

First release. Known limitations:

- **`Allow & remember`** just returns `allow` for now — the remember-this
  whitelist isn't implemented yet.
- **`AskUserQuestion` "Other" / free-text** isn't supported — the model
  has to pick one of its pre-generated options.
- Only text assistant output is forwarded. Tool _results_ (file contents,
  command stdout) are summarised but not streamed verbatim; they show up
  as the tool announcement plus the next assistant message.
- Single-user, single-instance. No multi-tenancy.

## License

Apache-2.0
