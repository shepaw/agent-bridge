# shepaw-codebuddy-code-gateway

Run [CodeBuddy Code](https://cnb.cool/codebuddy/codebuddy-code) as an agent
for the [Shepaw](https://shepaw.com) mobile app — approve tool calls, fill
in clarifying questions, and watch the stream from your phone.

This is a drop-in counterpart to
[`shepaw-claude-code-gateway`](../claude-code-ts), with the same
non-blocking approval pipeline but wired to
[`@tencent-ai/agent-sdk`](https://www.npmjs.com/package/@tencent-ai/agent-sdk)
instead of `@anthropic-ai/claude-agent-sdk`.

## What it does

```
Shepaw app (phone)  ──ACP JSON-RPC/WS──▶  shepaw-codebuddy-code-gateway  ──@tencent-ai/agent-sdk──▶  CodeBuddy
       ▲                                         │
       └────── ui.actionConfirmation ────────────┘
              (every tool call routed here; non-blocking)
```

- Every `canUseTool` from the Agent SDK is turned into a
  `ui.actionConfirmation` on the phone. The gateway **does not block the
  SDK turn** waiting for your reply — it tells CodeBuddy "denied for now",
  ends the turn cleanly, and records a pending approval. When you later
  tap **Allow** / **Deny** (or type `allow` / `同意` / `deny` / `拒绝`),
  Shepaw sends that as a new `agent.chat` message; the gateway records
  the verdict in a 20-minute approval cache and forwards the text to
  CodeBuddy. CodeBuddy retries the same tool call on the next turn, this
  time the cache hit lets it through without another prompt.
- `AskUserQuestion` (the SDK's clarifying-questions tool) is mapped to
  a single `ui.form` with `radio_group` / `checkbox_group` fields. Same
  non-blocking pattern: the turn ends, the user submits the form, and
  their answers arrive as a plain-text message which CodeBuddy picks up
  on the next turn.
- Persists the CodeBuddy SDK `session_id` per Shepaw session, so you
  can kill the gateway, restart it, and keep talking to the same thread.
- `agent.cancelTask` aborts the in-flight `query()` immediately.

## Install

```sh
npm install -g shepaw-codebuddy-code-gateway
```

Or build from source:

```sh
git clone <repo>
cd agent-bridge
npm install
cd implementations/codebuddy-code
npm run build
```

## Try it without API credentials (mock mode)

If you just want to see the Shepaw app ↔ gateway round-trip without
touching the CodeBuddy API, run with `--mock`:

```sh
node dist/cli.js serve --port 8090 --mock
```

On first start the gateway prints a banner with its **agent id** and
16-hex **fingerprint**, and writes a long-term X25519 keypair to
`~/.config/shepaw-cb-gateway/identity.json` (see
[Encrypted protocol & identity](#encrypted-protocol--identity) below for
the full picture):

```
============================================================
  CodeBuddy Code (ACP Agent Server)
============================================================
  Agent ID:         acp_agent_a1b2c3d4
  Fingerprint:      a1b2c3d4ffd6fa20
  Identity:         /Users/you/.config/shepaw-cb-gateway/identity.json
  Authorized peers: 0
  ⚠ No peers authorized. Run `shepaw-codebuddy-code peers add <pubkey>` to accept connections.
  ACP WS:           ws://localhost:8090/acp/ws?agentId=acp_agent_a1b2c3d4#fp=a1b2c3d4ffd6fa20
============================================================
```

Before Shepaw can connect, you have to **authorize the device's public
key**. In the Shepaw app's "Add remote agent" screen, tap the
"Copy public key" button and then run on the agent host:

```sh
shepaw-codebuddy-code peers add <base64-pubkey-from-app> --label "My iPhone"
```

The running gateway picks up the new entry within ~100 ms — no
restart. Then copy the banner's `ACP WS:` URL (**including the `#fp=`
fragment**) into Shepaw. Once connected, try these messages:

| Type | What you'll see on the phone |
|------|------------------------------|
| `help` | A list of the other scenarios |
| `hello` (or anything else) | Plain text echo |
| `run bash` | A `ui.actionConfirmation` (Allow / Deny). The first turn ends with a "sent a confirmation to your phone" message; **reply `allow`** (or `同意`) and the command output streams on the next turn. |
| `ask me` | A `ui.form` with a single `radio_group` field. Fill it in and submit — your answer comes back as a plain chat message, and the mock echoes it. |
| `slow` | A sentence streamed word-by-word so you can watch the chunks arrive |
| `error` | The gateway throws — exercises the `task.error` path |

Cancelling (back-swipe in Shepaw) works in every scenario. This is the
same pipeline the real CodeBuddy flow uses — just with a scripted
generator instead of `@tencent-ai/agent-sdk`'s `query()`.

## Managing authorized peers

Each paired Shepaw device is authorized by its base64 X25519 static
public key, stored in `authorized_peers.json` alongside `identity.json`.
The file is `0600` on Unix and is never read by the gateway without a
permission check.

### Quickest pairing: `enroll` (recommended)

```sh
shepaw-codebuddy-code enroll --label "My iPhone" \
    --base-url wss://channel.example.com/c/my-agent
```

Prints a single-use 9-character pairing code like `4B7-9KX-M2P`
(10-minute TTL). Give the code to the user along with the URL; they
paste both into the Shepaw app's "Add remote agent" screen. On first
handshake the agent consumes the code and auto-adds the device's
pubkey to `authorized_peers.json` — no second command needed.

Listing / revoking unused codes:

```sh
shepaw-codebuddy-code enroll-list
shepaw-codebuddy-code enroll-revoke 4B7-9KX-M2P
```

Codes travel inside the Noise-encrypted msg 1 payload — Channel
Service never sees them in the clear.

### Manual peer management

```sh
# List all authorized devices
shepaw-codebuddy-code peers list

# Authorize a new device (pubkey from the Shepaw app)
shepaw-codebuddy-code peers add <base64-pubkey> --label "Alice's iPhone"

# Revoke a device by its 16-hex fingerprint
shepaw-codebuddy-code peers remove a1b2c3d4e5f6a7b8
```

`peers add` is idempotent — re-adding the same pubkey returns the
existing entry. `peers remove` is "live": if the gateway is running,
any active WebSocket session for that fingerprint is closed with code
`4411` within ~100 ms via `fs.watch`. The user's Shepaw app surfaces
this as "agent removed this device".

See [`../../SECURITY.md`](../../SECURITY.md) for the full threat model.

## Run against the real CodeBuddy API

```sh
# Minimal, LAN only
shepaw-codebuddy-code serve --cwd ~/code/my-project --port 8090

# With model + turn cap
shepaw-codebuddy-code serve \
  --cwd ~/workspace/shepaw/agent-bridge \
  --port 8090 \
  --max-turns 20

# See all flags
shepaw-codebuddy-code serve --help
```

Authentication (from the CodeBuddy SDK docs):

- Set `CODEBUDDY_API_KEY` in the environment for API-key auth.
- Or set `CODEBUDDY_AUTH_TOKEN` for enterprise OAuth Client Credentials.
- Or run `codebuddy` CLI once to do an interactive login; the SDK
  re-uses those credentials automatically.
- Set `CODEBUDDY_INTERNET_ENVIRONMENT=internal` for the China version.

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

shepaw-codebuddy-code serve \
  --cwd ~/code/my-project \
  --port 8090
```

Or pass the flags inline:
channel-agent --server http://channel.shepaw.com --channel-id f7977615-0148-443a-9ed9-39654a3301d4 --secret ch_sec_243d56d05e1201b65ccdaa71e91e5cd8
```sh
shepaw-codebuddy-code serve \
  --cwd ~/workspace/shepaw/agent-bridge \
  --port 8090 \
  --tunnel-server http://channel.shepaw.com \
  --tunnel-channel-id f7977615-0148-443a-9ed9-39654a3301d4  \
  --tunnel-secret ch_sec_243d56d05e1201b65ccdaa71e91e5cd8 \
  --tunnel-endpoint shepaw-root
```

When the tunnel comes up you'll see a `Public WS: wss://…#fp=…` line —
paste that URL **including the `#fp=` fragment** into the Shepaw app's
"remote agent address" field. Authorize the device's pubkey via
`peers add` (above). The tunnel reconnects automatically (exponential
backoff, capped at 60s) and sends a JSON-level keepalive every 20s.

## Encrypted protocol & identity

Since SDK v0.3 (protocol v2.1) the gateway speaks the **ACP v2.1
protocol**: every WebSocket frame between the Shepaw app and the
gateway is sealed with ChaCha20-Poly1305 under keys derived from a
Noise IK handshake, and each paired device is authorized by its X25519
static public key listed in `authorized_peers.json`. **There is no
shared `--token` anymore.** The Channel Service relay cannot read chat
contents, method names, or device identity inside frames. See
[`../../SECURITY.md`](../../SECURITY.md) for the threat model.

What that means operationally:

- **Identity file.** On first start the gateway generates an X25519
  keypair and writes it to
  `$SHEPAW_IDENTITY_PATH` / `$XDG_CONFIG_HOME/shepaw-cb-gateway/identity.json` /
  `~/.config/shepaw-cb-gateway/identity.json` (first match wins), with
  Unix permissions `0600`. The file's public-key fingerprint becomes
  your agent id (`acp_agent_<8-hex>`) and is printed on every startup.
  The same keypair is reused forever — don't delete it unless you want
  to force-unpair every Shepaw device.

- **Authorized peers file.** `authorized_peers.json` lives in the same
  directory as `identity.json` (overridable via `$SHEPAW_PEERS_PATH`
  or `--peers-path`). Managed via the `peers` subcommands above. The
  agent `fs.watch`es this file, so changes take effect within ~100 ms
  without restarting the gateway.

- **Fingerprint on the URL.** The pairing URL ends in `#fp=<16-hex>`.
  Shepaw reads the fragment locally (it is **not** sent to the relay
  during the WebSocket upgrade) and pins the fingerprint. A MITM that
  swaps the agent's public key is rejected at handshake with WS close
  `4403`. Users have to paste the whole URL — copying just the
  `ws://…/acp/ws` portion will fail with "URL 缺失指纹".

- **Running multiple gateways on one host.** The default identity path
  is `shepaw-cb-gateway/identity.json` — shared with
  `shepaw-claude-code-gateway`. If you run both on the same machine,
  give each its own identity file:

  ```sh
  SHEPAW_IDENTITY_PATH=~/.config/shepaw-codebuddy-gateway/identity.json \
  SHEPAW_PEERS_PATH=~/.config/shepaw-codebuddy-gateway/authorized_peers.json \
    shepaw-codebuddy-code serve …
  ```

  Otherwise whichever gateway starts second will load the other's
  keypair and present itself with the wrong agent id.

- **No backward compatibility.** v2 and v1 Shepaw apps are closed with
  WS code `4400` (bad envelope / prologue mismatch). Users must update
  the app to a v2.1 build.

## Connect from the Shepaw app

1. Open "Add remote agent" in Shepaw.
2. Paste the banner's `ACP WS:` URL (must include `#fp=...`). Shepaw
   will display your device's base64 public key and a ready-made
   `peers add` command.
3. On the agent host, run the shown `peers add` command (you can
   customise the `--label`).
4. Tap "Connect" in Shepaw. Once the handshake completes, start
   chatting.

When CodeBuddy tries to use a tool you'll see a confirmation bubble on
your phone (Allow / Deny). Tapping **Allow** (or typing `allow` /
`同意`) on your next message lets CodeBuddy proceed; the approval is
cached for 20 minutes so repeated calls to the same tool with the same
input don't re-prompt.

To revoke a device: either run `peers remove <fp>` on the agent host,
or in Shepaw delete the agent row — the app will send `peer.unregister`
over the active Noise session before tearing down, which removes the
entry from `authorized_peers.json` automatically.

## Debug logs

Two debug namespaces:

```sh
# Just the agent-level lifecycle (permission requests, session resume, results)
DEBUG=shepaw:gateway shepaw-codebuddy-code serve …

# Every JSON-RPC frame in and out (verbose)
DEBUG=shepaw:wire shepaw-codebuddy-code serve …

# Both
DEBUG=shepaw:* shepaw-codebuddy-code serve …
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
