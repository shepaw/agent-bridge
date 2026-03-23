"""Data types for the ACP protocol."""

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class ACPTextChunk:
    """A plain text fragment emitted by the directive stream parser."""
    content: str


@dataclass
class ACPDirective:
    """A parsed directive block with type and payload."""
    directive_type: str
    payload: dict


@dataclass
class AgentCard:
    """Metadata describing an ACP agent's capabilities."""
    agent_id: str
    name: str
    description: str = ""
    version: str = "1.0.0"
    capabilities: List[str] = field(default_factory=lambda: ["chat", "streaming"])
    supported_protocols: List[str] = field(default_factory=lambda: ["acp"])


@dataclass
class LLMToolCall:
    """Represents a tool call returned by the LLM."""
    id: str
    name: str
    arguments: dict


@dataclass
class LLMStreamResult:
    """Result of a streaming chat with tools."""
    text_content: str
    tool_calls: List[LLMToolCall]
