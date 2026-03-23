#!/usr/bin/env python3
"""LLM-powered ACP agent with OpenAI streaming and directive parsing (~50 lines).

Usage:
    export OPENAI_API_KEY=sk-...
    python llm_agent_example.py

    # Then in the PAW app, add a remote agent:
    #   Address: ws://<your-ip>:8080/acp/ws
    #   Token:   my-secret
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from paw_acp_sdk import (
    ACPAgentServer,
    ACPDirectiveStreamParser,
    ACPDirective,
    ACPTextChunk,
    OpenAIProvider,
    TaskContext,
)


class LLMAgent(ACPAgentServer):
    """Streams an OpenAI chat completion back to the user.

    Supports ACP directive parsing so the LLM can emit interactive UI
    components via ``<<<directive ... >>>`` fence syntax.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        api_key = os.getenv("OPENAI_API_KEY", "")
        api_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
        model = os.getenv("OPENAI_MODEL", "gpt-4o")
        self.provider = OpenAIProvider(api_base, api_key, model)

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        messages = kwargs.get("messages", [])
        system_prompt = kwargs.get("system_prompt", self.system_prompt)

        parser = ACPDirectiveStreamParser()
        full_reply = ""

        async for chunk in self.provider.stream_chat(messages, system_prompt):
            full_reply += chunk
            for event in parser.feed(chunk):
                if isinstance(event, ACPTextChunk) and event.content:
                    await ctx.send_text(event.content)
                elif isinstance(event, ACPDirective):
                    # For simplicity, send unknown directives as text
                    await ctx.send_text(f"[Directive: {event.directive_type}]")

        # Flush remaining parser buffer
        for event in parser.flush():
            if isinstance(event, ACPTextChunk) and event.content:
                await ctx.send_text(event.content)

        # Save to conversation history
        self.save_reply_to_history(ctx.session_id, full_reply)


if __name__ == "__main__":
    LLMAgent(
        name="LLM Agent",
        token="my-secret",
        system_prompt="You are a helpful AI assistant.",
    ).run(port=8080)
