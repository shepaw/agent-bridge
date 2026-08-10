# agent-bridge

SDKs and reference implementations for building agents that plug into the
[Shepaw](https://shepaw.com) mobile app.

## Layout

```
agent-bridge/
├── sdks/
│   ├── shepaw-acp-sdk-python/        # Python SDK (pip install shepaw-acp-sdk)
│   └── shepaw-acp-sdk-typescript/    # TypeScript SDK (npm i shepaw-acp-sdk)
│
├── implementations/
│   └── acp-proxy-ts/                 # ACP proxy gateway (npm i -g shepaw-acp-proxy-gateway)
│
├── agent-hub/                        # Multi-project supervisor (npm i -g shepaw-agent-hub)
│
├── docs/                             # Deployment and help guides
│
└── tools/
    └── debug-clients/                # One-off WS clients used during protocol bring-up
```

## Two protocols

| Protocol | Purpose |
|----------|---------|
| **Shepaw ACP v2.1** | Wire protocol between the Shepaw app and your gateway (WebSocket + Noise). Implemented by `shepaw-acp-sdk`. |
| **Agent Client Protocol (ACP)** | Industry stdio JSON-RPC between a client and coding agents (Claude Code, Codex, CodeBuddy, …). Implemented by `@agentclientprotocol/sdk`. |

The recommended gateway (`shepaw-acp-proxy`) bridges them:

```
Shepaw app → Shepaw ACP v2.1 → AcpProxyAgent → @agentclientprotocol/sdk → upstream agent subprocess
```

Both SDKs are designed to speak the **same Shepaw wire protocol** — JSON field
names stay `snake_case` in both, method names match exactly, and Tunnel /
Channel-Service framing is byte-for-byte identical, so a Python agent and a
TypeScript agent are interchangeable from the Shepaw app's point of view
(once the Python SDK is ported to v2.1 — see below).

> **Note on protocol v2.1 (April 2026):** the TypeScript SDK and the
> Shepaw Flutter app speak a Noise-IK-encrypted wire protocol with a
> **per-device public-key allowlist** — there is no shared `token`.
> The easy path is `<gateway> pair`, which prints a QR + single-use code
> the app redeems during the handshake; the manual fallback is
> `<gateway> peers add <pubkey>` with the pubkey shown in the app's
> "Add agent" screen. Pairing URLs include a `#fp=<fingerprint>` fragment.
> v2.1 is a **hard cutover** from v2 (prologue changed); both sides
> must be on v2.1. The Python SDK here is still v1 and is not
> interoperable with v2.1 apps until ported. See [`SECURITY.md`](SECURITY.md)
> for the full threat model and pairing walkthrough.

## Quick start

Two ways to run agents — both end with scanning a QR code in the Shepaw app:

- **One agent, three commands** — the ACP proxy gateway (`shepaw-acp-proxy`)
- **Many projects on one host** — Agent Hub (`shepaw-hub`): CLI + Web
  dashboard that spawns the gateway per project

Prerequisites: Node.js ≥ 18.17, the CLI of the engine you pick (e.g.
Claude Code), and the Shepaw app on the same Wi-Fi as this machine.

### Install

```sh
# One-liner (recommended)
curl -fsSL https://raw.githubusercontent.com/shepaw/agent-bridge/main/scripts/install.sh | bash

# Or via npm
npm install -g shepaw-agent-hub          # multi-project hub (includes gateway)
npm install -g shepaw-acp-proxy-gateway  # single-agent gateway only
```

Docker / systemd examples: [`docs/DOCKER.md`](docs/DOCKER.md), [`deploy/`](deploy/).

### One agent on your phone (fastest)

```sh
# if you used the install script with --proxy-only / --all, or:
npm install -g shepaw-acp-proxy-gateway

# Terminal 1 — bind to LAN so the phone can reach the gateway
shepaw-acp-proxy serve --engine claude-code --cwd ~/your-project --host 0.0.0.0

# Terminal 2 — print the pairing QR (LAN address auto-detected)
shepaw-acp-proxy pair
```

In the Shepaw app: **Add agent → scan the QR**. That's it — start chatting.

Supported `--engine` values: `claude-code`, `codebuddy`, `codex`,
`opencode`, `openclaw`, `cursor`, `hermes`, `kimi`. Pairing from outside
your LAN (tunnel / channel) is covered in
[`implementations/acp-proxy-ts/README.md`](implementations/acp-proxy-ts/README.md).

### Run multiple agents from one CLI (`shepaw-hub`)

One host, many projects — each with its own identity, session store, and
authorized-peers list. Agent Hub spawns `shepaw-acp-proxy` with per-project
configuration.

Fastest path — one interactive command:

```sh
shepaw-hub quickstart
# pick an engine → confirm cwd → scan the QR in the Shepaw app
```

Or step by step:

```sh
shepaw-hub init
shepaw-hub doctor                              # optional: check Node / engines / ports
shepaw-hub instance add --engine claude-code --cwd ~/code/work-api --host 0.0.0.0
shepaw-hub start <instance-id>
shepaw-hub pair <instance-id> --label "My iPhone"   # prints QR + short code
shepaw-hub test <instance-id> --rpc                 # verify HTTP + Noise path
```

A Web dashboard (default `:4000`) manages projects, engines, and pairing
from the browser. See [`agent-hub/README.md`](agent-hub/README.md) for the
full command reference. For step-by-step deployment (Peer pairing, Channel,
production checklist), see [`docs/deployment.md`](docs/deployment.md).

### Build a custom agent (Python)

> **v2.1 note:** the Python SDK is still protocol v1 and cannot pair with
> current Shepaw apps until ported — see the protocol note above.

```sh
pip install shepaw-acp-sdk
```

```py
from shepaw_acp_sdk import ACPAgentServer, TaskContext

class MyAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"You said: {message}")

MyAgent(name="My Agent", token="secret").run(port=8080)
```

### Build a custom agent (TypeScript)

```sh
npm install shepaw-acp-sdk
```

```ts
import { ACPAgentServer, TaskContext } from 'shepaw-acp-sdk';

class MyAgent extends ACPAgentServer {
  override async onChat(ctx: TaskContext, message: string) {
    await ctx.sendText(`You said: ${message}`);
  }
}

await new MyAgent({ name: 'My Agent' }).run({ port: 8080 });
```

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/deployment.md`](docs/deployment.md) | Deploy Shepaw Agent Hub (build, engines, instances, Peer / Channel) |
| [`docs/README.md`](docs/README.md) | Help docs index |
| [`agent-hub/README.md`](agent-hub/README.md) | CLI and REST API reference |
| [`CHANNEL_PROXY_GUIDE.md`](CHANNEL_PROXY_GUIDE.md) | Channel tunnel protocol |
| [`SECURITY.md`](SECURITY.md) | ACP v2.1 security and pairing |

## Development

Root scripts run across the TypeScript workspaces:

```sh
npm install
npm run typecheck
npm run build
npm test
```

To run the gateway from a source checkout instead of the npm package:

```sh
npm install && npm run build
node implementations/acp-proxy-ts/dist/cli.js serve --engine claude-code --cwd ~/your-project
```

Python packages are independent — `cd` into each and use `pytest` /
`pip install -e .` as you normally would.

## License

Apache-2.0 (TypeScript) / MIT (Python). See each package's `LICENSE`.
