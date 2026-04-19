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

## Quick start

### Run Claude Code on your phone (TypeScript gateway)

```sh
cd implementations/claude-code-ts
npm install && npm run build
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js serve --cwd ~/your-project --port 8090 --token dev
# Add ws://<host>:8090/acp/ws (token: dev) as a remote agent in Shepaw.
```

For external access via the Shepaw Channel Service, see
[`implementations/claude-code-ts/README.md`](implementations/claude-code-ts/README.md).

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

await new MyAgent({ name: 'My Agent', token: 'secret' }).run({ port: 8080 });
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
