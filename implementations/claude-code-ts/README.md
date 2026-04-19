# shepaw-claude-code-gateway

Run [Claude Code](https://claude.com/claude-code) as an agent for the
[Shepaw](https://shepaw.com) mobile app — approve tool calls, fill in
clarifying questions, and watch the stream from your phone.

## What it does

```
Shepaw app (phone)  ──ACP JSON-RPC/WS──▶  shepaw-claude-code-gateway  ──@anthropic-ai/claude-agent-sdk──▶  Claude
       ▲                                         │
       └────── ui.actionConfirmation ────────────┘
              (every tool call routed here; non-blocking)
```

- Every `canUseTool` from the Agent SDK is turned into a
  `ui.actionConfirmation` on the phone. The gateway **does not block the
  SDK turn** waiting for your reply — it tells Claude "denied for now",
  ends the turn cleanly, and records a pending approval. When you later
  tap **Allow** / **Deny** (or type `allow` / `同意` / `deny` / `拒绝`),
  Shepaw sends that as a new `agent.chat` message; the gateway records
  the verdict in a 20-minute approval cache and forwards the text to
  Claude. Claude retries the same tool call on the next turn, this time
  the cache hit lets it through without another prompt.
- `AskUserQuestion` (Claude's clarifying-questions tool) is mapped to a
  single `ui.form` with `radio_group` / `checkbox_group` fields. Same
  non-blocking pattern: the turn ends, the user submits the form, and
  their answers arrive as a plain-text message which Claude picks up on
  the next turn.
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
cd implementations/claude-code-ts
npm run build
```

## Try it without an API key (mock mode)

If you just want to see the Shepaw app ↔ gateway round-trip without
burning Claude credits, run with `--mock`:

```sh
node dist/cli.js serve --port 8090 --token dev --mock
```

Now add `ws://<host>:8090/acp/ws` (token: `dev`) in Shepaw and send one
of these messages:

| Type | What you'll see on the phone |
|------|------------------------------|
| `help` | A list of the other scenarios |
| `hello` (or anything else) | Plain text echo |
| `run bash` | A `ui.actionConfirmation` (Allow / Deny). The first turn ends with a "sent a confirmation to your phone" message; **reply `allow`** (or `同意`) and the command output streams on the next turn. |
| `ask me` | A `ui.form` with a single `radio_group` field. Fill it in and submit — your answer comes back as a plain chat message, and the mock echoes it. |
| `slow` | A sentence streamed word-by-word so you can watch the chunks arrive |
| `error` | The gateway throws — exercises the `task.error` path |

Cancelling (back-swipe in Shepaw) works in every scenario. This is the
same pipeline the real Claude Code flow uses — just with a scripted
generator instead of `@anthropic-ai/claude-agent-sdk`'s `query()`.

## Run against the real Claude API

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

Then send a chat message. When Claude tries to use a tool, you'll see a
confirmation bubble on your phone (Allow / Deny). Tapping **Allow** (or
typing `allow` / `同意`) on your next message lets Claude proceed; the
approval is cached for 20 minutes so repeated calls to the same tool
with the same input don't re-prompt.

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

- **Approval cache** is in-memory only; restarting the gateway forgets
  past approvals. The 20-minute TTL is generous enough that most sessions
  don't notice.
- **`AskUserQuestion` "Other" / free-text** isn't supported — the model
  has to pick one of its pre-generated options.
- Only text assistant output is forwarded. Tool _results_ (file contents,
  command stdout) are summarised but not streamed verbatim; they show up
  as the tool announcement plus the next assistant message.
- Single-user, single-instance. No multi-tenancy.

## License

Apache-2.0
