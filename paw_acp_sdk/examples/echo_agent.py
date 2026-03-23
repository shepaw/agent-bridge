#!/usr/bin/env python3
"""Minimal ACP agent using the paw_acp_sdk — ~20 lines of code.

Usage:
    pip install aiohttp
    python echo_agent.py

    # Then in the PAW app, add a remote agent:
    #   Address: ws://<your-ip>:8080/acp/ws
    #   Token:   my-secret
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from paw_acp_sdk import ACPAgentServer, TaskContext


class EchoAgent(ACPAgentServer):
    """Echoes back whatever the user says."""

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"Echo: {message}")


if __name__ == "__main__":
    EchoAgent(name="Echo Agent", token="my-secret").run(port=8080)
