"""Tunnel Agent Example — paw_acp_sdk

Demonstrates running an ACP agent that is reachable both on the local network
AND from the public internet via the Shepaw Channel Service.

Usage
-----
1. Install dependencies::

       pip install paw_acp_sdk

2. Set your Channel Service credentials (from the Shepaw app settings)::

       export PAW_ACP_TUNNEL_SERVER_URL=https://channel.example.com
       export PAW_ACP_TUNNEL_CHANNEL_ID=ch_abc123
       export PAW_ACP_TUNNEL_SECRET=ch_sec_xyz
       # Optional: short-name endpoint shown in Shepaw UI
       export PAW_ACP_TUNNEL_ENDPOINT=myagent

3. Run::

       python tunnel_agent_example.py

The agent will be accessible:
  - Locally:      ws://localhost:8080/acp/ws
  - Public (WS):  wss://channel.example.com/c/myagent/acp/ws  (or /proxy/ch_abc123/acp/ws)
"""

import os

from paw_acp_sdk import ACPAgentServer, ChannelTunnelConfig, TaskContext


# ── Agent definition ──────────────────────────────────────────────────────────

class TunnelDemoAgent(ACPAgentServer):
    """A simple echo agent that works over local network and public tunnel."""

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs) -> None:
        session_id = kwargs.get("session_id", "")
        user_id = kwargs.get("user_id", "")

        await ctx.send_text(
            f"Hello from TunnelDemoAgent!\n\n"
            f"You said: **{message}**\n\n"
            f"Session: `{session_id}`  •  User: `{user_id}`"
        )
        # Save reply to conversation history
        self.save_reply_to_history(session_id, f"Echo: {message}")


# ── Configuration helpers ─────────────────────────────────────────────────────

def _tunnel_config_from_env() -> ChannelTunnelConfig | None:
    """Build a :class:`ChannelTunnelConfig` from environment variables.

    Required:
        PAW_ACP_TUNNEL_SERVER_URL  — Channel Service base URL
        PAW_ACP_TUNNEL_CHANNEL_ID  — channel ID
        PAW_ACP_TUNNEL_SECRET      — channel secret

    Optional:
        PAW_ACP_TUNNEL_ENDPOINT    — short-name endpoint
    """
    server_url = os.environ.get("PAW_ACP_TUNNEL_SERVER_URL", "")
    channel_id = os.environ.get("PAW_ACP_TUNNEL_CHANNEL_ID", "")
    secret = os.environ.get("PAW_ACP_TUNNEL_SECRET", "")

    if not (server_url and channel_id and secret):
        return None

    return ChannelTunnelConfig(
        server_url=server_url,
        channel_id=channel_id,
        secret=secret,
        channel_endpoint=os.environ.get("PAW_ACP_TUNNEL_ENDPOINT", ""),
    )


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    PORT = int(os.environ.get("PAW_ACP_LOCAL_PORT", "8080"))
    TOKEN = os.environ.get("PAW_ACP_TOKEN", "")

    agent = TunnelDemoAgent(
        name="Tunnel Demo Agent",
        token=TOKEN,
        description="A demo agent accessible over local network and public tunnel",
    )

    tunnel_config = _tunnel_config_from_env()

    if tunnel_config:
        # Mode: local server + public tunnel (via Channel Service)
        print("[main] Starting in tunnel mode (local + public)...")
        agent.run_with_tunnel(
            tunnel_config=tunnel_config,
            port=PORT,
        )
    else:
        # Mode: local server only
        print("[main] No tunnel config found — starting in local-only mode.")
        print("       Set PAW_ACP_TUNNEL_SERVER_URL, PAW_ACP_TUNNEL_CHANNEL_ID,")
        print("       and PAW_ACP_TUNNEL_SECRET to enable public access.")
        agent.run(port=PORT)
