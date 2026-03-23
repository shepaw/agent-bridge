"""PAW ACP SDK — build ACP agents for the AI Agent Hub app.

Quick start::

    from paw_acp_sdk import ACPAgentServer, TaskContext

    class MyAgent(ACPAgentServer):
        async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
            await ctx.send_text(f"You said: {message}")

    MyAgent(name="My Agent", token="secret").run(port=8080)
"""

from .types import (
    ACPTextChunk,
    ACPDirective,
    AgentCard,
    LLMToolCall,
    LLMStreamResult,
)
from .jsonrpc import (
    jsonrpc_response,
    jsonrpc_notification,
    jsonrpc_request,
)
from .directive_parser import ACPDirectiveStreamParser
from .conversation import ConversationManager
from .task_context import TaskContext
from .server import ACPAgentServer
from .tunnel import ChannelTunnelConfig, TunnelClient
from .providers import (
    LLMProvider,
    OpenAIProvider,
    ClaudeProvider,
    GLMProvider,
)
from .utils import acp_directive_to_notification

__all__ = [
    # Core
    "ACPAgentServer",
    "TaskContext",
    # Tunnel / Channel Service
    "ChannelTunnelConfig",
    "TunnelClient",
    # Types
    "ACPTextChunk",
    "ACPDirective",
    "AgentCard",
    "LLMToolCall",
    "LLMStreamResult",
    # JSON-RPC
    "jsonrpc_response",
    "jsonrpc_notification",
    "jsonrpc_request",
    # Parser
    "ACPDirectiveStreamParser",
    # Conversation
    "ConversationManager",
    # LLM Providers
    "LLMProvider",
    "OpenAIProvider",
    "ClaudeProvider",
    "GLMProvider",
    # Utils
    "acp_directive_to_notification",
]
