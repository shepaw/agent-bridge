# shepaw-acp-sdk

Python SDK for building ACP (Agent Communication Protocol) agents that integrate with the [Shepaw](https://shepaw.com) app.

## Installation

```bash
pip install shepaw-acp-sdk
```

## Quick Start

```python
from shepaw_acp_sdk import ACPAgentServer, TaskContext

class MyAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"You said: {message}")

MyAgent(name="My Agent", token="secret").run(port=8080)
```

Then in the Shepaw app, add a remote agent:
- **Address**: `ws://<your-ip>:8080/acp/ws`
- **Token**: `secret`

## Features

- **ACP Protocol**: JSON-RPC 2.0 over WebSocket (RFC 6455)
- **Streaming responses**: Real-time token-by-token output
- **Interactive UI**: Send rich UI components (buttons, forms, etc.)
- **LLM Providers**: Built-in support for OpenAI, Claude (Anthropic), GLM
- **Conversation history**: Per-session history with configurable TTL
- **Tunnel support**: Expose local agents to the public internet via Shepaw Channel Service
- **OpenClaw integration**: Bridge to OpenClaw Gateway

## Examples

### Echo Agent (minimal)

```python
from shepaw_acp_sdk import ACPAgentServer, TaskContext

class EchoAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"Echo: {message}")

EchoAgent(name="Echo Agent", token="my-secret").run(port=8080)
```

### LLM Agent (OpenAI streaming)

```python
import os
from shepaw_acp_sdk import ACPAgentServer, OpenAIProvider, TaskContext

class LLMAgent(ACPAgentServer):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.provider = OpenAIProvider(
            api_base=os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
            api_key=os.getenv("OPENAI_API_KEY", ""),
            model=os.getenv("OPENAI_MODEL", "gpt-4o"),
        )

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        messages = kwargs.get("messages", [])
        async for chunk in self.provider.stream_chat(messages, self.system_prompt):
            await ctx.send_text(chunk)

LLMAgent(name="LLM Agent", token="my-secret").run(port=8080)
```

### Public Tunnel

```python
import os
from shepaw_acp_sdk import ACPAgentServer, ChannelTunnelConfig, TaskContext

class MyAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"Hello: {message}")

agent = MyAgent(name="My Agent")
tunnel = ChannelTunnelConfig(
    server_url=os.environ["PAW_ACP_TUNNEL_SERVER_URL"],
    channel_id=os.environ["PAW_ACP_TUNNEL_CHANNEL_ID"],
    secret=os.environ["PAW_ACP_TUNNEL_SECRET"],
)
agent.run_with_tunnel(tunnel_config=tunnel, port=8080)
```

## API Reference

See [API_REFERENCE.md](API_REFERENCE.md) for full documentation.

## Protocol Overview

ACP is built on JSON-RPC 2.0 over WebSocket:

| Message | Direction | Description |
|---------|-----------|-------------|
| `auth.authenticate` | Client → Server | Token authentication |
| `agent.chat` | Client → Server | Send a message |
| `agent.getCard` | Client → Server | Fetch agent metadata |
| `ui.textContent` | Server → Client | Stream text response |
| `task.started` | Server → Client | Task started notification |
| `task.completed` | Server → Client | Task completed notification |

## Requirements

- Python 3.10+
- aiohttp >= 3.9

## License

MIT
