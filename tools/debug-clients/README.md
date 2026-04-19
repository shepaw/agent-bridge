# tools/debug-clients

One-off Python WebSocket clients used during early Shepaw ACP protocol
bring-up. **Not unit tests** — don't run under pytest, don't expect
assertions. They connect to a locally running agent and print the JSON-RPC
traffic so you can eyeball the wire format.

| File | What it exercises |
|------|-------------------|
| `test_agent.py` | Smoke: `auth.authenticate` + `agent.chat`, logs each frame with a timestamp, times out after 3× 10 s to flag deadlocks. |
| `test_integrated.py` | Spawns an agent in-process and sends a chat message; avoids subprocess hassle when reproducing a hang. |
| `test_no_hub_response.py` | Reproduces the deadlock when the "Shepaw Hub" side never answers `hub.getUIComponentTemplates`. |
| `test_shepaw_style.py` | Mimics how the Shepaw Flutter app talks — Bearer auth via the `Authorization` header, no `auth.authenticate` roundtrip. |

## How to use

Start any agent on port 8081 with token `mytoken123` (or edit the scripts):

```sh
# Option A: Python echo agent from the SDK
python -m shepaw_acp_sdk.examples.echo_agent --port 8081 --token mytoken123

# Option B: TypeScript echo agent
cd ../../sdks/shepaw-acp-sdk-typescript
PORT=8081 npx tsx examples/echo-agent.ts  # note: default token is "my-secret"

# Option C: the Claude Code gateway
cd ../../implementations/claude-code-ts && npm run build
node dist/cli.js serve --port 8081 --token mytoken123 --cwd ~/any-project
```

Then in another shell:

```sh
cd tools/debug-clients
python test_agent.py          # or any of the others
```

The scripts hard-code the URL / token for quick iteration — edit them
before reaching for env vars.

## These are historical

They helped us hunt down specific deadlocks during protocol work. Keep
them for regression debugging; don't treat them as a test suite.
