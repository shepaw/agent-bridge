"""OpenClaw Channel Agent Example — shepaw_acp_sdk

Demonstrates how to bridge a Shepaw App user to an OpenClaw Gateway, so
users can talk to OpenClaw (and all its configured AI agents) directly from
the Shepaw mobile app.

Architecture
------------

    Shepaw App  <──ACP WebSocket──>  This Agent (port 8080)
                                          │
                                          │ OpenClaw Gateway Protocol
                                          │ (WebSocket)
                                          ▼
                                    OpenClaw Gateway (port 18789)
                                          │
                           ┌─────────────┼─────────────┐
                           ▼             ▼              ▼
                       Discord      Telegram      (other channels)


Usage
-----
1. Install::

       pip install shepaw-acp-sdk

2. Start OpenClaw Gateway (in a separate terminal)::

       openclaw gateway --port 18789

3. Set environment variables (optional — defaults work for local setup)::

       export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
       export OPENCLAW_GATEWAY_TOKEN=your-openclaw-token
       export OPENCLAW_SESSION_KEY=acp:shepaw-bridge   # optional
       export PAW_ACP_TOKEN=your-shepaw-agent-token    # optional

4. Run this agent::

       python openclaw_agent_example.py

5. Connect from the Shepaw app:

       WebSocket URL: ws://<your-local-ip>:8080/acp/ws
       Token:         (your PAW_ACP_TOKEN, or empty if not set)

Every message you send from Shepaw will be forwarded to OpenClaw, and the
OpenClaw reply streams back in real time.
"""

import os

from shepaw_acp_sdk import ACPAgentServer, TaskContext
from shepaw_acp_sdk.openclaw_channel import OpenClawChannel, OpenClawChannelConfig


# ── Agent definition ──────────────────────────────────────────────────────────


class OpenClawBridgeAgent(ACPAgentServer):
    """Bridges Shepaw users to an OpenClaw Gateway.

    Every message received from Shepaw is forwarded to the configured OpenClaw
    Gateway session.  The reply is streamed back chunk by chunk so users see
    the response as it is generated.
    """

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs) -> None:
        session_id = kwargs.get("session_id", "")

        if self.openclaw_channel is None:
            await ctx.send_text(
                "OpenClaw channel is not configured. "
                "Please provide an OpenClawChannelConfig."
            )
            return

        try:
            # Stream reply chunks from OpenClaw back to the Shepaw user
            received_any = False
            async for chunk in self.openclaw_channel.send_and_stream(message):
                if chunk:
                    await ctx.send_text(chunk)
                    received_any = True

            if not received_any:
                await ctx.send_text("(OpenClaw returned an empty response)")

        except ConnectionError as e:
            await ctx.send_text(
                f"Could not reach OpenClaw Gateway: {e}\n\n"
                "Make sure `openclaw gateway` is running on "
                f"{self.openclaw_channel.config.gateway_url}"
            )
        except RuntimeError as e:
            await ctx.send_text(f"OpenClaw error: {e}")

        # Persist a brief summary to conversation history
        self.save_reply_to_history(session_id, f"[Forwarded to OpenClaw: {message[:60]}]")


# ── Configuration helpers ─────────────────────────────────────────────────────


def _openclaw_config_from_env() -> OpenClawChannelConfig:
    """Build an :class:`OpenClawChannelConfig` from environment variables.

    Environment variables (all optional):
        OPENCLAW_GATEWAY_URL    — WebSocket URL of the OpenClaw Gateway
                                  (default: ``ws://127.0.0.1:18789``)
        OPENCLAW_GATEWAY_TOKEN  — authentication token for the gateway
        OPENCLAW_SESSION_KEY    — session key to send messages to
    """
    return OpenClawChannelConfig(
        gateway_url=os.environ.get("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789"),
        gateway_token=os.environ.get("OPENCLAW_GATEWAY_TOKEN", ""),
        session_key=os.environ.get("OPENCLAW_SESSION_KEY", ""),
    )


# ── Main ──────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    PORT = int(os.environ.get("PAW_ACP_LOCAL_PORT", "8080"))
    TOKEN = os.environ.get("PAW_ACP_TOKEN", "")

    openclaw_config = _openclaw_config_from_env()

    print(f"[main] OpenClaw Gateway: {openclaw_config.gateway_url}")
    if openclaw_config.gateway_token:
        print(f"[main] Gateway token:    {'*' * len(openclaw_config.gateway_token)}")
    else:
        print("[main] Gateway token:    (none — no auth)")

    agent = OpenClawBridgeAgent(
        name="OpenClaw Bridge",
        token=TOKEN,
        description="Bridges Shepaw users to an OpenClaw Gateway",
    )

    agent.run_with_openclaw_channel(openclaw_config, port=PORT)
