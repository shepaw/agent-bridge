# agent-bridge

SDKs and reference implementations for building ACP (Agent Client
Protocol) agents that plug into the [Shepaw](https://shepaw.com)
mobile app.

## Layout

```
agent-bridge/
├── sdks/
│   ├── shepaw-acp-sdk-python/        # Python SDK (pip install shepaw-acp-sdk)
│   └── shepaw-acp-sdk-typescript/    # TypeScript SDK (npm i shepaw-acp-sdk)
│
├── implementations/
│   ├── claude-code-ts/               # Claude Code as a Shepaw agent (TS, current)
│   ├── codebuddy-code/               # CodeBuddy Code as a Shepaw agent (TS)
│   ├── shepaw-agent-hub/             # Multi-project supervisor CLI (TS) — see below
│   ├── claude-code-py/               # Claude Code as a Shepaw agent (Python, older)
│   └── paw-agent-py/                 # Multi-platform OS control agent (Python, unmaintained)
│
└── tools/
    └── debug-clients/                # One-off WS clients used during protocol bring-up
```

Both SDKs speak the **same wire protocol** — a Python agent and a
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

### Run Claude Code on your phone (TypeScript gateway)

```sh
cd implementations/claude-code-ts
npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js serve --cwd ~/your-project --port 8090
# The banner prints your agent's fingerprint + "Authorized peers: 0".
# Copy your Shepaw app's public key from the "Add agent" screen, then run:
node dist/cli.js peers add <base64-pubkey> --label "My iPhone"
# Paste the banner's ws:// URL (including #fp=...) into Shepaw to connect.
```

For external access via the Shepaw Channel Service, see
[`implementations/claude-code-ts/README.md`](implementations/claude-code-ts/README.md).

### Run multiple agents from one CLI (`shepaw-agent-hub`)

One host, many projects — each with its own identity and authorized-peers
list. `shepaw-hub` is a cross-platform supervisor that spawns the unmodified
gateway binaries with per-project configuration:

```sh
cd implementations/shepaw-agent-hub
npm install && npm run build

shepaw-hub init
shepaw-hub project add work-api --engine codebuddy --cwd ~/code/work-api \
    --base-url "wss://channel.shepaw.com/c/work-api"
shepaw-hub start work-api
shepaw-hub pair work-api --label "My iPhone"   # prints QR + short code
```

See [`implementations/shepaw-agent-hub/README.md`](implementations/shepaw-agent-hub/README.md) for the full command reference and Windows notes.

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
npm run typecheck    # tsc --noEmit in both TS packages
npm run build        # tsup in both TS packages
npm test             # vitest in both TS packages (SDK has 33 tests; gateway has none yet)
```

Python packages are independent — `cd` into each and use `pytest` /
`pip install -e .` as you normally would.

## License

Apache-2.0 (TypeScript) / MIT (Python). See each package's `LICENSE`.
