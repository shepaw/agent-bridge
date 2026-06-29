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
│   ├── acp-proxy-ts/                 # Unified ACP proxy gateway (recommended)
│   ├── _archived/                    # Legacy vendor-SDK gateways (deprecated)
│   ├── claude-code-py/               # Claude Code as a Shepaw agent (Python, older)
│   └── paw-agent-py/                 # Multi-platform OS control agent (Python, unmaintained)
│
├── agent-hub/                        # Multi-project supervisor (CLI + Web UI)
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

Both SDKs speak the **same Shepaw wire protocol** — a Python agent and a
TypeScript agent are interchangeable from the Shepaw app's point of view.
JSON field names stay `snake_case` in both, method names match exactly,
and Tunnel / Channel-Service framing is byte-for-byte identical.

> **Note on protocol v2.1 (April 2026):** the TypeScript SDK and the
> Shepaw Flutter app speak a Noise-IK-encrypted wire protocol with a
> **per-device public-key allowlist** — there is no shared `token`.
> Pairing URLs include a `#fp=<fingerprint>` fragment; authorization
> is done out of band by running `<gateway> peers add <pubkey>` on the
> agent host with the pubkey shown in the app's "Add agent" screen.
> v2.1 is a **hard cutover** from v2 (prologue changed); both sides
> must be on v2.1. The Python SDK here is still v1 and is not
> interoperable with v2.1 apps until ported. See [`SECURITY.md`](SECURITY.md)
> for the full threat model and pairing walkthrough.

## Quick start

### Run any ACP agent on your phone (recommended)

```sh
cd implementations/acp-proxy-ts
npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...   # when using --engine claude-code
node dist/cli.js serve --engine claude-code --cwd ~/your-project --port 8090
node dist/cli.js peers add <base64-pubkey> --label "My iPhone"
```

Supported `--engine` values: `claude-code`, `tclaude`, `codebuddy`, `codex`, `tcodex`,
`opencode`, `openclaw`, `cursor`, `hermes`. See
[`implementations/acp-proxy-ts/README.md`](implementations/acp-proxy-ts/README.md).

Legacy vendor-SDK gateways (`claude-code-ts`, `codebuddy-code`, …) are
archived — see [`implementations/_archived/README.md`](implementations/_archived/README.md).

### Run multiple agents from one CLI (`shepaw-hub`)

One host, many projects — each with its own identity, session store, and
authorized-peers list. Agent Hub spawns `shepaw-acp-proxy` with per-project
configuration:

```sh
npm install && npm run build
cd agent-hub/cli && npm link   # or npx shepaw-hub

shepaw-hub init
shepaw-hub project add work-api --engine claude-code --cwd ~/code/work-api \
    --base-url "wss://channel.shepaw.com/c/work-api"
shepaw-hub start work-api
shepaw-hub pair work-api --label "My iPhone"   # prints QR + short code
```

See [`agent-hub/README.md`](agent-hub/README.md) for the full command reference,
Web UI, and Windows notes.

### Build a custom agent (Python)

```sh
pip install -e sdks/shepaw-acp-sdk-python
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
cd sdks/shepaw-acp-sdk-typescript && npm run build
# from your project:
npm install path/to/agent-bridge/sdks/shepaw-acp-sdk-typescript
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

## Development

Root scripts run across the TypeScript workspaces:

```sh
npm install
npm run typecheck
npm run build
npm test
```

Python packages are independent — `cd` into each and use `pytest` /
`pip install -e .` as you normally would.

## License

Apache-2.0 (TypeScript) / MIT (Python). See each package's `LICENSE`.
