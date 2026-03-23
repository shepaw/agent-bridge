#!/usr/bin/env python3
"""
LLM Agent Server - A2A SSE Protocol with Real LLM Integration

Supports:
- OpenAI-compatible APIs (GPT, DeepSeek, Qwen, Ollama, vLLM, LM Studio, etc.)
- Anthropic Claude API (Claude 3.5/4 series)
- GLM API (GLM-4, GLM-4.7 series via BigModel platform)
- Multi-turn conversation with session-based history
- Streaming SSE output following A2A protocol

Usage:
    # OpenAI GPT
    python llm_agent.py --provider openai --model gpt-4o --api-key $OPENAI_API_KEY

    # DeepSeek
    python llm_agent.py --provider openai --model deepseek-chat \\
        --api-base https://api.deepseek.com/v1 --api-key $DEEPSEEK_API_KEY

    # Local Ollama
    python llm_agent.py --provider openai --model llama3 \\
        --api-base http://localhost:11434/v1

    # Claude
    python llm_agent.py --provider claude --model claude-sonnet-4-20250514 \\
        --api-key $ANTHROPIC_API_KEY

    # GLM-4.7 (ZhipuAI BigModel)
    python llm_agent.py --provider glm --model glm-4.7 --api-key $GLM_API_KEY

Environment variables:
    LLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GLM_API_KEY - API key
"""

import asyncio
import json
import re
import time
import uuid
import argparse
import os
import sys
from datetime import datetime
from enum import Enum, auto
from typing import AsyncGenerator, Awaitable, Callable, Dict, List, Optional, Union
from dataclasses import dataclass, field

try:
    from aiohttp import web
    import aiohttp
except ImportError:
    print("Error: aiohttp is required. Install it with: pip install aiohttp")
    sys.exit(1)


# ==================== Interactive System Prompt ====================

# Known directive types that the parser will recognize
KNOWN_DIRECTIVES = {
    "action_confirmation",
    "single_select",
    "multi_select",
    "file_upload",
    "form",
    "file_message",
    "message_metadata",
    "request_history",
}

INTERACTIVE_SYSTEM_PROMPT = r"""
## Interactive Message Directives

You can embed interactive UI elements in your responses using directive blocks.
Directive blocks use fenced syntax and will be rendered as rich interactive widgets in the user's app.

### Syntax

```
:::directive_type
{JSON payload}
:::
```

The directive block MUST start with `:::` followed by the type name on the same line,
then a valid JSON object on subsequent lines, and close with `:::` on its own line.
You may include normal text before and after directive blocks.

### Available Directive Types

#### 1. action_confirmation
Present action buttons for the user to click. Use when offering distinct actions.

```
:::action_confirmation
{
  "prompt": "What would you like to do?",
  "actions": [
    {"id": "action_1", "label": "Approve & Deploy", "style": "primary"},
    {"id": "action_2", "label": "Run More Tests", "style": "secondary"},
    {"id": "action_3", "label": "Cancel", "style": "danger"}
  ]
}
:::
```
- `style`: "primary" (main action), "secondary" (alternative), "danger" (destructive/cancel)
- The user's response will be: "Selected action: <label>"

#### 2. single_select
Present a single-choice list. Use when the user must pick exactly one option.

```
:::single_select
{
  "prompt": "Choose a deployment plan:",
  "options": [
    {"id": "opt1", "label": "Option A - Standard"},
    {"id": "opt2", "label": "Option B - Premium"},
    {"id": "opt3", "label": "Option C - Enterprise"}
  ]
}
:::
```
- The user's response will be: "Selected: <label>"

#### 3. multi_select
Present a multi-choice list. Use when the user can pick multiple options.

```
:::multi_select
{
  "prompt": "Select features to enable:",
  "options": [
    {"id": "f1", "label": "Dark Mode"},
    {"id": "f2", "label": "Push Notifications"},
    {"id": "f3", "label": "Offline Support"}
  ],
  "min_select": 1,
  "max_select": null
}
:::
```
- `min_select`: minimum selections required (default 1)
- `max_select`: maximum selections allowed (null = unlimited)
- The user's response will be: "Selected: <label1>, <label2>, ..."

#### 4. file_upload
Request file uploads from the user.

```
:::file_upload
{
  "prompt": "Please upload your documents:",
  "accept_types": ["pdf", "doc", "docx", "txt", "png", "jpg"],
  "max_files": 5,
  "max_size_mb": 20
}
:::
```
- The user's response will be: "Uploaded files: <filename1>, <filename2>, ..."

#### 5. form
Present a structured form with multiple fields.

```
:::form
{
  "title": "User Registration",
  "description": "Please fill in the information below.",
  "fields": [
    {
      "field_id": "name",
      "type": "text_input",
      "label": "Full Name",
      "placeholder": "Enter your full name",
      "required": true,
      "max_lines": 1
    },
    {
      "field_id": "email",
      "type": "text_input",
      "label": "Email",
      "placeholder": "example@email.com",
      "required": true,
      "max_lines": 1
    },
    {
      "field_id": "role",
      "type": "single_select",
      "label": "Role",
      "required": true,
      "options": [
        {"id": "dev", "label": "Developer"},
        {"id": "designer", "label": "Designer"},
        {"id": "pm", "label": "Product Manager"}
      ]
    },
    {
      "field_id": "skills",
      "type": "multi_select",
      "label": "Skills",
      "required": false,
      "options": [
        {"id": "flutter", "label": "Flutter"},
        {"id": "react", "label": "React"},
        {"id": "python", "label": "Python"}
      ]
    },
    {
      "field_id": "bio",
      "type": "text_input",
      "label": "Short Bio",
      "placeholder": "Tell us about yourself...",
      "required": false,
      "max_lines": 3
    },
    {
      "field_id": "resume",
      "type": "file_upload",
      "label": "Resume / CV",
      "required": false,
      "accept_types": ["pdf", "doc", "docx"],
      "max_files": 1,
      "max_size_mb": 10
    }
  ]
}
:::
```
- Field types: "text_input", "single_select", "multi_select", "file_upload"
- The user's response will be: "Form submitted: field1: value1; field2: value2; ..."

#### 6. file_message
Send a file or image to the user for download/preview.

```
:::file_message
{
  "url": "https://example.com/report.pdf",
  "filename": "report.pdf",
  "mime_type": "application/pdf",
  "size": 13264
}
:::
```
- For images use mime_type like "image/jpeg", "image/png"
- `size` is in bytes (0 if unknown)

#### 7. message_metadata
Add metadata to the preceding message, e.g. collapsible thinking sections.

```
:::message_metadata
{
  "collapsible": true,
  "collapsible_title": "Thinking process",
  "auto_collapse": true
}
:::
```
- When used, the text portion of the current response becomes the collapsible content.

#### 8. request_history
Request more conversation history from the user's app when you detect that
you are missing context needed to answer the current question.

Use this when:
- The user references a past conversation, decision, or topic that is not
  in your current context
- You detect phrases like "as we discussed", "remember when", "what about
  that thing from earlier", "上次", "之前说的", "还记得" etc.
- You feel uncertain about a topic that might have been discussed before

```
:::request_history
{
  "reason": "You mentioned a project we discussed earlier, but I don't have that conversation in my current context. Let me request more chat history.",
  "requested_count": 40
}
:::
```

- `reason`: Explain to the user why you need more history (shown to them)
- `requested_count`: How many additional messages you'd like (default: 40)
- IMPORTANT: After this directive, STOP generating further text. The app
  will send you additional history, after which you will re-answer.
- Do NOT use this if the user is asking a new question unrelated to past
  conversations.

### Guidelines

- Use interactive elements only when they genuinely help the user (e.g., choosing between options, filling structured data, uploading files).
- For simple questions, plain text is sufficient — do not overuse directives.
- You may combine normal text with one or more directive blocks in a single response.
- Always provide helpful context text before a directive block explaining what the user should do.
- When a user responds to an interactive element (e.g., "Selected action: Deploy"), understand their choice and continue the conversation naturally.
- **Planning mode**: When your system prompt contains a 【计划模式】 section,
  the app automatically handles plan approval. After outputting the [PLAN] block,
  stop — do NOT add any `:::action_confirmation` or other confirmation directives.
  The system will present the plan approval UI to the user on your behalf.
""".strip()


# ==================== Configuration ====================

@dataclass
class AgentConfig:
    """Agent configuration."""
    agent_id: str
    agent_name: str
    port: int
    token: str
    provider: str           # "openai" or "claude"
    model: str
    api_base: str
    api_key: str
    system_prompt: str
    interactive: bool = True
    max_history: int = 20
    model_routing: dict = None   # Optional per-modality model overrides

    def __post_init__(self):
        if self.model_routing is None:
            self.model_routing = {}


# ==================== Conversation History ====================

class ConversationManager:
    """Manages per-session conversation history."""

    def __init__(self, max_history: int = 20):
        self.max_history = max_history
        # session_id -> list of {"role": ..., "content": ...}
        self._sessions: Dict[str, List[Dict[str, str]]] = {}
        self._last_access: Dict[str, float] = {}

    def get_messages(self, session_id: str) -> List[Dict[str, str]]:
        self._last_access[session_id] = time.time()
        return self._sessions.get(session_id, [])

    def add_user_message(self, session_id: str, content: str):
        self._ensure_session(session_id)
        self._sessions[session_id].append({"role": "user", "content": content})
        self._trim(session_id)

    def add_assistant_message(self, session_id: str, content: str):
        self._ensure_session(session_id)
        self._sessions[session_id].append({"role": "assistant", "content": content})
        self._trim(session_id)

    def rollback(self, session_id: str) -> bool:
        """Remove the last assistant+user message pair. Returns True if something was removed."""
        msgs = self._sessions.get(session_id, [])
        if not msgs:
            return False
        # Remove last assistant message
        if msgs and msgs[-1]["role"] == "assistant":
            msgs.pop()
        # Remove last user message
        if msgs and msgs[-1]["role"] == "user":
            msgs.pop()
        return True

    def has_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def initialize_session(self, session_id: str, history: List[Dict[str, str]]):
        """Pre-load a session with existing history. Only if session doesn't exist."""
        if session_id in self._sessions:
            return
        self._sessions[session_id] = list(history)
        self._last_access[session_id] = time.time()

    def prepend_history(self, session_id: str, older_messages: List[Dict[str, str]]):
        """Prepend older history messages to the beginning of an existing session."""
        if session_id not in self._sessions:
            return
        self._sessions[session_id] = older_messages + self._sessions[session_id]
        self._last_access[session_id] = time.time()

    def cleanup_expired(self, max_age_seconds: int = 259200):
        """Remove sessions older than max_age_seconds."""
        now = time.time()
        expired = [sid for sid, ts in self._last_access.items()
                   if now - ts > max_age_seconds]
        for sid in expired:
            self._sessions.pop(sid, None)
            self._last_access.pop(sid, None)

    def _ensure_session(self, session_id: str):
        if session_id not in self._sessions:
            self._sessions[session_id] = []
        self._last_access[session_id] = time.time()

    def _trim(self, session_id: str):
        msgs = self._sessions[session_id]
        # Keep at most max_history * 2 messages (user+assistant pairs)
        max_msgs = self.max_history * 2
        if len(msgs) > max_msgs:
            self._sessions[session_id] = msgs[-max_msgs:]


# ==================== Tool Calling Data Classes ====================

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


# ==================== LLM Providers ====================

class LLMProvider:
    """Base class for LLM providers."""

    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str,
    ) -> AsyncGenerator[str, None]:
        raise NotImplementedError
        yield  # make it a generator

    async def stream_chat_with_tools(
        self,
        messages: List[Dict],
        system_prompt: str,
        tools: List[Dict],
        on_text_chunk: Callable[[str], Awaitable[None]],
    ) -> LLMStreamResult:
        """Stream a chat completion that may include tool calls.

        Text chunks are delivered via the on_text_chunk callback.
        Returns the complete result including any tool calls.
        """
        raise NotImplementedError


class OpenAIProvider(LLMProvider):
    """
    OpenAI-compatible API provider.
    Works with: OpenAI, DeepSeek, Qwen, Ollama, vLLM, LM Studio, etc.
    """

    def __init__(self, api_base: str, api_key: str, model: str):
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str,
    ) -> AsyncGenerator[str, None]:
        url = f"{self.api_base}/chat/completions"

        # Build messages list with system prompt
        api_messages = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        api_messages.extend(messages)

        payload = {
            "model": self.model,
            "messages": api_messages,
            "stream": True,
        }

        headers = {
            "Content-Type": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(
                        f"LLM API error {resp.status}: {error_body[:500]}"
                    )

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content")
                            if content:
                                yield content
                        except (json.JSONDecodeError, IndexError, KeyError):
                            continue

    async def stream_chat_with_tools(
        self,
        messages: List[Dict],
        system_prompt: str,
        tools: List[Dict],
        on_text_chunk: Callable[[str], Awaitable[None]],
    ) -> LLMStreamResult:
        url = f"{self.api_base}/chat/completions"

        api_messages = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        api_messages.extend(messages)

        payload = {
            "model": self.model,
            "messages": api_messages,
            "stream": True,
            "tools": tools,
            "tool_choice": "auto",
        }

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        text_content = ""
        # tool_calls indexed by position: {index: {"id": ..., "name": ..., "arguments": ...}}
        tool_call_buffers: Dict[int, Dict] = {}

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(f"LLM API error {resp.status}: {error_body[:500]}")

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            delta = data.get("choices", [{}])[0].get("delta", {})

                            # Text content
                            content = delta.get("content")
                            if content:
                                text_content += content
                                await on_text_chunk(content)

                            # Tool calls (incremental)
                            tc_deltas = delta.get("tool_calls")
                            if tc_deltas:
                                for tc_delta in tc_deltas:
                                    idx = tc_delta.get("index", 0)
                                    if idx not in tool_call_buffers:
                                        tool_call_buffers[idx] = {
                                            "id": tc_delta.get("id", ""),
                                            "name": "",
                                            "arguments": "",
                                        }
                                    buf = tool_call_buffers[idx]
                                    if tc_delta.get("id"):
                                        buf["id"] = tc_delta["id"]
                                    func = tc_delta.get("function", {})
                                    if func.get("name"):
                                        buf["name"] = func["name"]
                                    if func.get("arguments"):
                                        buf["arguments"] += func["arguments"]

                        except (json.JSONDecodeError, IndexError, KeyError):
                            continue

        # Parse accumulated tool calls
        tool_calls = []
        for idx in sorted(tool_call_buffers.keys()):
            buf = tool_call_buffers[idx]
            try:
                args = json.loads(buf["arguments"]) if buf["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(LLMToolCall(
                id=buf["id"],
                name=buf["name"],
                arguments=args,
            ))

        return LLMStreamResult(text_content=text_content, tool_calls=tool_calls)


class ClaudeProvider(LLMProvider):
    """Anthropic Claude API provider."""

    def __init__(self, api_base: str, api_key: str, model: str):
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str,
    ) -> AsyncGenerator[str, None]:
        url = f"{self.api_base}/messages"

        payload = {
            "model": self.model,
            "max_tokens": 4096,
            "stream": True,
            "messages": messages,
        }
        if system_prompt:
            payload["system"] = system_prompt

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(
                        f"Claude API error {resp.status}: {error_body[:500]}"
                    )

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        try:
                            data = json.loads(data_str)
                            event_type = data.get("type")
                            if event_type == "content_block_delta":
                                delta = data.get("delta", {})
                                if delta.get("type") == "text_delta":
                                    text = delta.get("text", "")
                                    if text:
                                        yield text
                            elif event_type == "message_stop":
                                break
                        except json.JSONDecodeError:
                            continue

    async def stream_chat_with_tools(
        self,
        messages: List[Dict],
        system_prompt: str,
        tools: List[Dict],
        on_text_chunk: Callable[[str], Awaitable[None]],
    ) -> LLMStreamResult:
        url = f"{self.api_base}/messages"

        payload = {
            "model": self.model,
            "max_tokens": 4096,
            "stream": True,
            "messages": messages,
            "tools": tools,
        }
        if system_prompt:
            payload["system"] = system_prompt

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }

        text_content = ""
        # Track tool_use blocks: {block_index: {"id": ..., "name": ..., "arguments": ...}}
        tool_use_blocks: Dict[int, Dict] = {}
        current_block_index = -1
        current_block_type = None

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(f"Claude API error {resp.status}: {error_body[:500]}")

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        try:
                            data = json.loads(data_str)
                            event_type = data.get("type")

                            if event_type == "content_block_start":
                                block = data.get("content_block", {})
                                current_block_index = data.get("index", current_block_index + 1)
                                current_block_type = block.get("type")
                                if current_block_type == "tool_use":
                                    tool_use_blocks[current_block_index] = {
                                        "id": block.get("id", ""),
                                        "name": block.get("name", ""),
                                        "arguments": "",
                                    }

                            elif event_type == "content_block_delta":
                                delta = data.get("delta", {})
                                delta_type = delta.get("type")
                                if delta_type == "text_delta":
                                    text = delta.get("text", "")
                                    if text:
                                        text_content += text
                                        await on_text_chunk(text)
                                elif delta_type == "input_json_delta":
                                    partial = delta.get("partial_json", "")
                                    if current_block_index in tool_use_blocks:
                                        tool_use_blocks[current_block_index]["arguments"] += partial

                            elif event_type == "message_stop":
                                break

                        except json.JSONDecodeError:
                            continue

        # Parse accumulated tool calls
        tool_calls = []
        for idx in sorted(tool_use_blocks.keys()):
            buf = tool_use_blocks[idx]
            try:
                args = json.loads(buf["arguments"]) if buf["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(LLMToolCall(
                id=buf["id"],
                name=buf["name"],
                arguments=args,
            ))

        return LLMStreamResult(text_content=text_content, tool_calls=tool_calls)


class GLMProvider(LLMProvider):
    """ZhipuAI GLM API provider (GLM-4, GLM-4.7 series).

    The BigModel platform uses JWT-based authentication: the API key has the
    format ``{id}.{secret}``.  A short-lived JWT is generated from these parts
    and sent as a Bearer token.  The chat completions endpoint is OpenAI-
    compatible in terms of request/response format.
    """

    def __init__(self, api_base: str, api_key: str, model: str):
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model

    def _generate_jwt(self) -> str:
        """Generate a JWT token from the API key (format: id.secret)."""
        import hashlib
        import hmac
        import base64

        parts = self.api_key.split(".", 1)
        if len(parts) != 2:
            # If the key doesn't contain a dot, use it as a plain Bearer token
            return self.api_key

        api_key_id, api_key_secret = parts

        # Header
        header = json.dumps({"alg": "HS256", "sign_type": "SIGN", "typ": "JWT"}, separators=(",", ":"))
        # Payload — token valid for 3 days
        now = int(time.time())
        payload = json.dumps({
            "api_key": api_key_id,
            "exp": now + 259200,
            "timestamp": now,
        }, separators=(",", ":"))

        def _b64url(data: bytes) -> str:
            return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

        header_b64 = _b64url(header.encode("utf-8"))
        payload_b64 = _b64url(payload.encode("utf-8"))
        signing_input = f"{header_b64}.{payload_b64}"

        signature = hmac.new(
            api_key_secret.encode("utf-8"),
            signing_input.encode("utf-8"),
            hashlib.sha256,
        ).digest()

        return f"{signing_input}.{_b64url(signature)}"

    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str,
    ) -> AsyncGenerator[str, None]:
        url = f"{self.api_base}/chat/completions"

        # Build messages list with system prompt
        api_messages = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        api_messages.extend(messages)

        payload = {
            "model": self.model,
            "messages": api_messages,
            "stream": True,
        }

        token = self._generate_jwt()
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(
                        f"GLM API error {resp.status}: {error_body[:500]}"
                    )

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content")
                            if content:
                                yield content
                        except (json.JSONDecodeError, IndexError, KeyError):
                            continue

    async def stream_chat_with_tools(
        self,
        messages: List[Dict],
        system_prompt: str,
        tools: List[Dict],
        on_text_chunk: Callable[[str], Awaitable[None]],
    ) -> LLMStreamResult:
        url = f"{self.api_base}/chat/completions"

        api_messages = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        api_messages.extend(messages)

        payload = {
            "model": self.model,
            "messages": api_messages,
            "stream": True,
            "tools": tools,
            "tool_choice": "auto",
        }

        token = self._generate_jwt()
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }

        text_content = ""
        tool_call_buffers: Dict[int, Dict] = {}

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_body = await resp.text()
                    raise RuntimeError(f"GLM API error {resp.status}: {error_body[:500]}")

                async for line in resp.content:
                    line = line.decode("utf-8").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            delta = data.get("choices", [{}])[0].get("delta", {})

                            content = delta.get("content")
                            if content:
                                text_content += content
                                await on_text_chunk(content)

                            tc_deltas = delta.get("tool_calls")
                            if tc_deltas:
                                for tc_delta in tc_deltas:
                                    idx = tc_delta.get("index", 0)
                                    if idx not in tool_call_buffers:
                                        tool_call_buffers[idx] = {
                                            "id": tc_delta.get("id", ""),
                                            "name": "",
                                            "arguments": "",
                                        }
                                    buf = tool_call_buffers[idx]
                                    if tc_delta.get("id"):
                                        buf["id"] = tc_delta["id"]
                                    func = tc_delta.get("function", {})
                                    if func.get("name"):
                                        buf["name"] = func["name"]
                                    if func.get("arguments"):
                                        buf["arguments"] += func["arguments"]

                        except (json.JSONDecodeError, IndexError, KeyError):
                            continue

        tool_calls = []
        for idx in sorted(tool_call_buffers.keys()):
            buf = tool_call_buffers[idx]
            try:
                args = json.loads(buf["arguments"]) if buf["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(LLMToolCall(
                id=buf["id"],
                name=buf["name"],
                arguments=args,
            ))

        return LLMStreamResult(text_content=text_content, tool_calls=tool_calls)

# ==================== Directive Stream Parser ====================

class _ParserState(Enum):
    STREAMING_TEXT = auto()
    MAYBE_DIRECTIVE = auto()
    IN_DIRECTIVE = auto()


@dataclass
class TextEvent:
    """A plain text fragment to be sent as TEXT_MESSAGE_CONTENT."""
    content: str


@dataclass
class DirectiveEvent:
    """A parsed directive block to be sent as an interactive SSE event."""
    directive_type: str
    payload: dict


class DirectiveStreamParser:
    """Streaming state-machine parser that splits LLM output into TextEvents and DirectiveEvents.

    Recognises fenced directive blocks of the form:

        :::directive_type
        {JSON}
        :::

    Everything outside those blocks is emitted as TextEvent chunks.
    """

    _FENCE = ":::"

    def __init__(self):
        self._state = _ParserState.STREAMING_TEXT
        self._buffer = ""
        # Accumulated when in MAYBE_DIRECTIVE / IN_DIRECTIVE
        self._directive_type: str = ""
        self._directive_body: str = ""
        # The raw text of the opening fence line, kept for fallback
        self._fence_line: str = ""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def feed(self, chunk: str) -> List[Union[TextEvent, DirectiveEvent]]:
        """Feed a chunk of text from the LLM and return any events parsed so far."""
        self._buffer += chunk
        events: List[Union[TextEvent, DirectiveEvent]] = []
        self._process(events)
        return events

    def flush(self) -> List[Union[TextEvent, DirectiveEvent]]:
        """Call when the LLM stream is done.  Flushes any buffered content as text."""
        events: List[Union[TextEvent, DirectiveEvent]] = []
        if self._state == _ParserState.MAYBE_DIRECTIVE:
            # Never confirmed as a directive — emit the fence line + buffer as text
            events.append(TextEvent(self._fence_line + self._buffer))
        elif self._state == _ParserState.IN_DIRECTIVE:
            # Unclosed directive — fall back to text
            events.append(TextEvent(self._fence_line + self._directive_body + self._buffer))
        elif self._buffer:
            events.append(TextEvent(self._buffer))
        self._buffer = ""
        self._reset_directive_state()
        return events

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _reset_directive_state(self):
        self._state = _ParserState.STREAMING_TEXT
        self._directive_type = ""
        self._directive_body = ""
        self._fence_line = ""

    def _process(self, events: List[Union[TextEvent, DirectiveEvent]]):
        """Process self._buffer according to the current state, appending events."""
        # Loop because a single buffer may contain multiple transitions
        changed = True
        while changed:
            changed = False
            if self._state == _ParserState.STREAMING_TEXT:
                changed = self._process_streaming_text(events)
            elif self._state == _ParserState.MAYBE_DIRECTIVE:
                changed = self._process_maybe_directive(events)
            elif self._state == _ParserState.IN_DIRECTIVE:
                changed = self._process_in_directive(events)

    def _process_streaming_text(self, events) -> bool:
        idx = self._buffer.find(self._FENCE)
        if idx == -1:
            # No fence marker at all — but keep last 2 chars in case `:::` is split
            safe = len(self._buffer) - 2
            if safe > 0:
                events.append(TextEvent(self._buffer[:safe]))
                self._buffer = self._buffer[safe:]
            return False
        # Emit text before the fence
        if idx > 0:
            events.append(TextEvent(self._buffer[:idx]))
        self._buffer = self._buffer[idx:]  # starts with ":::"
        self._state = _ParserState.MAYBE_DIRECTIVE
        self._fence_line = ""
        return True

    def _process_maybe_directive(self, events) -> bool:
        # We need the full first line (up to \n) to know the directive type
        newline_idx = self._buffer.find("\n")
        if newline_idx == -1:
            return False  # wait for more data
        first_line = self._buffer[:newline_idx].strip()
        # first_line should look like ":::action_confirmation"
        if first_line.startswith(self._FENCE):
            dtype = first_line[len(self._FENCE):].strip()
            if dtype in KNOWN_DIRECTIVES:
                self._directive_type = dtype
                self._fence_line = self._buffer[:newline_idx + 1]
                self._buffer = self._buffer[newline_idx + 1:]
                self._directive_body = ""
                self._state = _ParserState.IN_DIRECTIVE
                return True
        # Not a recognised directive — fall back to plain text
        # Emit the ":::" itself as text and continue scanning from after it
        events.append(TextEvent(self._buffer[:len(self._FENCE)]))
        self._buffer = self._buffer[len(self._FENCE):]
        self._state = _ParserState.STREAMING_TEXT
        return True

    def _process_in_directive(self, events) -> bool:
        # Look for closing fence ":::" on its own line
        # Search for \n::: pattern (closing fence must start on a new line)
        search_target = "\n" + self._FENCE
        close_idx = self._buffer.find(search_target)
        if close_idx == -1:
            # Also check if buffer starts with ::: (body is empty or already consumed newlines)
            if self._buffer.lstrip().startswith(self._FENCE) and self._directive_body:
                # The closing fence might be at the start of buffer
                stripped = self._buffer.lstrip()
                after_fence = stripped[len(self._FENCE):]
                # The closing ::: should be followed by newline or end-of-content
                if not after_fence or after_fence[0] == '\n' or after_fence.strip() == '':
                    # Found closing fence
                    return self._try_parse_directive(events, self._directive_body, self._buffer[self._buffer.index(self._FENCE) + len(self._FENCE):])
            # No closing fence yet — move content to directive_body but keep
            # trailing characters that could be the start of "\n:::" so the
            # closing fence is not split across body and buffer.
            keep = len(search_target) - 1  # keep last 3 chars ("\n::")
            safe = len(self._buffer) - keep
            if safe > 0:
                self._directive_body += self._buffer[:safe]
                self._buffer = self._buffer[safe:]
            return False

        # Found closing fence
        body = self._directive_body + self._buffer[:close_idx]
        remaining = self._buffer[close_idx + len(search_target):]
        # Skip the rest of the closing fence line
        nl = remaining.find("\n")
        if nl != -1:
            remaining = remaining[nl + 1:]
        else:
            remaining = ""
        return self._try_parse_directive(events, body, remaining)

    def _try_parse_directive(self, events, body: str, remaining: str) -> bool:
        body = body.strip()
        try:
            payload = json.loads(body)
            events.append(DirectiveEvent(self._directive_type, payload))
        except (json.JSONDecodeError, ValueError):
            # JSON parse failed — fall back to text
            events.append(TextEvent(self._fence_line + body + "\n" + self._FENCE))
        self._buffer = remaining
        self._reset_directive_state()
        return True


# ==================== A2A SSE Protocol ====================

def create_sse_event(data: Dict) -> str:
    """Create an SSE event string."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def verify_token(request: web.Request, config: AgentConfig) -> bool:
    """Verify request token."""
    if not config.token:
        return True
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:] == config.token
    token = request.query.get("token", "")
    return token == config.token


def _build_directive_sse_event(
    event: DirectiveEvent, task_id: str, config: AgentConfig
) -> Dict:
    """Convert a DirectiveEvent into an SSE event dict matching the mock agent structures."""
    dtype = event.directive_type
    payload = event.payload

    if dtype == "action_confirmation":
        confirmation_id = f"confirm_{uuid.uuid4().hex[:8]}"
        actions = payload.get("actions", [])
        return {
            "event_type": "ACTION_CONFIRMATION",
            "data": {
                "task_id": task_id,
                "confirmation_id": confirmation_id,
                "prompt": payload.get("prompt", "Please select an action:"),
                "actions": actions,
            },
        }

    elif dtype == "single_select":
        select_id = f"select_{uuid.uuid4().hex[:8]}"
        return {
            "event_type": "SINGLE_SELECT",
            "data": {
                "select_id": select_id,
                "prompt": payload.get("prompt", "Please choose one:"),
                "options": payload.get("options", []),
                "selected_option_id": None,
            },
        }

    elif dtype == "multi_select":
        select_id = f"mselect_{uuid.uuid4().hex[:8]}"
        return {
            "event_type": "MULTI_SELECT",
            "data": {
                "select_id": select_id,
                "prompt": payload.get("prompt", "Select all that apply:"),
                "options": payload.get("options", []),
                "min_select": payload.get("min_select", 1),
                "max_select": payload.get("max_select", None),
                "selected_option_ids": None,
            },
        }

    elif dtype == "file_upload":
        upload_id = f"upload_{uuid.uuid4().hex[:8]}"
        return {
            "event_type": "FILE_UPLOAD",
            "data": {
                "upload_id": upload_id,
                "prompt": payload.get("prompt", "Please upload files:"),
                "accept_types": payload.get("accept_types", []),
                "max_files": payload.get("max_files", 5),
                "max_size_mb": payload.get("max_size_mb", 20),
                "uploaded_files": None,
            },
        }

    elif dtype == "form":
        form_id = f"form_{uuid.uuid4().hex[:8]}"
        return {
            "event_type": "FORM",
            "data": {
                "form_id": form_id,
                "title": payload.get("title", "Form"),
                "description": payload.get("description", ""),
                "fields": payload.get("fields", []),
                "submitted_values": None,
            },
        }

    elif dtype == "file_message":
        return {
            "event_type": "FILE_MESSAGE",
            "data": {
                "task_id": task_id,
                "url": payload.get("url", ""),
                "filename": payload.get("filename", "file"),
                "mime_type": payload.get("mime_type", "application/octet-stream"),
                "size": payload.get("size", 0),
            },
        }

    elif dtype == "message_metadata":
        return {
            "event_type": "MESSAGE_METADATA",
            "data": {
                "task_id": task_id,
                "metadata": {
                    "collapsible": payload.get("collapsible", True),
                    "collapsible_title": payload.get("collapsible_title", "Details"),
                    "auto_collapse": payload.get("auto_collapse", True),
                },
            },
        }

    elif dtype == "request_history":
        request_id = f"hist_req_{uuid.uuid4().hex[:8]}"
        return {
            "event_type": "REQUEST_HISTORY",
            "data": {
                "task_id": task_id,
                "request_id": request_id,
                "reason": payload.get("reason", "I need more conversation context."),
                "requested_count": payload.get("requested_count", 40),
            },
        }

    # Should not reach here if KNOWN_DIRECTIVES is in sync, but fallback anyway
    return {
        "event_type": "TEXT_MESSAGE_CONTENT",
        "data": {
            "task_id": task_id,
            "content": f"[Unknown directive: {dtype}]",
            "is_final": False,
        },
    }


# ==================== Conversation History Cleanup ====================

_DIRECTIVE_BLOCK_RE = re.compile(
    r":::(\w+)\s*\n(.*?)\n:::",
    re.DOTALL,
)


def _clean_reply_for_history(full_reply: str) -> str:
    """Replace raw directive blocks in the assistant reply with human-readable summaries.

    This prevents the LLM from seeing its own directive syntax in conversation history,
    which could confuse it on subsequent turns.
    """

    def _summarise(m: re.Match) -> str:
        dtype = m.group(1)
        body = m.group(2).strip()
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            return m.group(0)  # keep original if can't parse

        if dtype == "action_confirmation":
            labels = [a.get("label", "?") for a in payload.get("actions", [])]
            return f"[Presented action buttons: {', '.join(labels)}]"
        elif dtype == "single_select":
            labels = [o.get("label", "?") for o in payload.get("options", [])]
            return f"[Presented single-select: {', '.join(labels)}]"
        elif dtype == "multi_select":
            labels = [o.get("label", "?") for o in payload.get("options", [])]
            return f"[Presented multi-select: {', '.join(labels)}]"
        elif dtype == "file_upload":
            return f"[Requested file upload]"
        elif dtype == "form":
            title = payload.get("title", "Form")
            field_labels = [f.get("label", "?") for f in payload.get("fields", [])]
            return f"[Presented form '{title}' with fields: {', '.join(field_labels)}]"
        elif dtype == "file_message":
            return f"[Sent file: {payload.get('filename', 'file')}]"
        elif dtype == "message_metadata":
            return f"[Metadata: {payload.get('collapsible_title', 'details')}]"
        elif dtype == "request_history":
            return f"[Requested more conversation history: {payload.get('reason', '')}]"
        else:
            return f"[Directive: {dtype}]"

    return _DIRECTIVE_BLOCK_RE.sub(_summarise, full_reply)


async def handle_agent_card(request: web.Request) -> web.Response:
    """Return agent card."""
    config: AgentConfig = request.app["config"]
    capabilities = ["chat", "streaming"]
    if config.interactive:
        capabilities.append("interactive_messages")
    card = {
        "agent_id": config.agent_id,
        "name": config.agent_name,
        "description": f"LLM Agent ({config.provider}/{config.model})",
        "version": "1.0.0",
        "capabilities": capabilities,
        "supported_protocols": ["a2a"],
        "metadata": {
            "framework": "LLM Agent",
            "provider": config.provider,
            "model": config.model,
            "endpoint": f"http://localhost:{config.port}/a2a/task",
        },
    }
    return web.json_response(card)


async def handle_task(request: web.Request) -> web.StreamResponse:
    """Handle A2A task request with streaming SSE response.

    When interactive mode is enabled, the LLM output is parsed through
    DirectiveStreamParser so that :::directive blocks are converted into
    rich interactive SSE events (ACTION_CONFIRMATION, SINGLE_SELECT, etc.).
    """
    config: AgentConfig = request.app["config"]
    provider: LLMProvider = request.app["provider"]
    conv_mgr: ConversationManager = request.app["conv_mgr"]

    # Token verification
    if not verify_token(request, config):
        return web.json_response(
            {"error": "Unauthorized", "message": "Invalid or missing token"},
            status=401,
        )

    # Parse request
    try:
        data = await request.json()
    except Exception as e:
        return web.json_response(
            {"error": "Invalid JSON", "message": str(e)},
            status=400,
        )

    task_id = data.get("task_id", data.get("id", str(uuid.uuid4())))
    metadata = data.get("metadata", {})
    session_id = metadata.get("session_id", task_id)

    # Extract input text
    a2a_data = data.get("a2a", {})
    input_text = a2a_data.get("input", data.get("instruction", ""))

    if not input_text:
        return web.json_response(
            {"error": "Missing input", "message": "No input found in a2a.input or instruction"},
            status=400,
        )

    print(f"\n{'='*60}")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Task {task_id}")
    print(f"  Session: {session_id}")
    print(f"  Input:   {input_text[:120]}{'...' if len(input_text) > 120 else ''}")
    print(f"{'='*60}")

    # Restore session from app-provided history if session doesn't exist
    if not conv_mgr.has_session(session_id):
        history = metadata.get("history")
        if history and isinstance(history, list):
            valid_history = [
                {"role": m["role"], "content": m["content"]}
                for m in history
                if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content")
            ]
            if valid_history:
                conv_mgr.initialize_session(session_id, valid_history)
                print(f"  📚 Restored {len(valid_history)} messages from app history")

    # Check if this is a history supplement (not a normal user message)
    is_history_supplement = metadata.get("history_supplement") is True

    if is_history_supplement:
        # Handle history supplement
        additional_history = metadata.get("additional_history", [])
        if additional_history and isinstance(additional_history, list):
            valid_additional = [
                {"role": m["role"], "content": m["content"]}
                for m in additional_history
                if isinstance(m, dict)
                and m.get("role") in ("user", "assistant")
                and m.get("content")
            ]
            if valid_additional:
                conv_mgr.prepend_history(session_id, valid_additional)
                print(f"  📚 Prepended {len(valid_additional)} older messages")

        # Remove the previous incomplete assistant reply (from the request_history response)
        msgs = conv_mgr.get_messages(session_id)
        if msgs and msgs[-1]["role"] == "assistant":
            msgs.pop()

        # Don't add a new user message — the original question is already in history
        messages = conv_mgr.get_messages(session_id)
    else:
        # Normal flow
        conv_mgr.add_user_message(session_id, input_text)
        messages = conv_mgr.get_messages(session_id)

    # Set up SSE response
    response = web.StreamResponse(
        status=200,
        reason="OK",
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
    await response.prepare(request)

    full_reply = ""
    use_parser = config.interactive

    try:
        # 1. RUN_STARTED
        await response.write(
            create_sse_event({
                "event_type": "RUN_STARTED",
                "data": {
                    "task_id": task_id,
                    "agent_id": config.agent_id,
                    "started_at": datetime.now().isoformat(),
                },
            }).encode("utf-8")
        )

        # 2. Stream LLM response — with or without directive parsing
        parser = DirectiveStreamParser() if use_parser else None

        try:
            async for chunk in provider.stream_chat(messages, config.system_prompt):
                full_reply += chunk

                if parser:
                    # Feed chunk into the state machine
                    for evt in parser.feed(chunk):
                        if isinstance(evt, TextEvent) and evt.content:
                            await response.write(
                                create_sse_event({
                                    "event_type": "TEXT_MESSAGE_CONTENT",
                                    "data": {
                                        "task_id": task_id,
                                        "content": evt.content,
                                        "is_final": False,
                                    },
                                }).encode("utf-8")
                            )
                        elif isinstance(evt, DirectiveEvent):
                            sse_evt = _build_directive_sse_event(evt, task_id, config)
                            await response.write(
                                create_sse_event(sse_evt).encode("utf-8")
                            )
                else:
                    # Non-interactive: pass through as plain text
                    await response.write(
                        create_sse_event({
                            "event_type": "TEXT_MESSAGE_CONTENT",
                            "data": {
                                "task_id": task_id,
                                "content": chunk,
                                "is_final": False,
                            },
                        }).encode("utf-8")
                    )

        except Exception as e:
            error_msg = f"\n\n[Error from LLM API: {e}]"
            full_reply += error_msg
            await response.write(
                create_sse_event({
                    "event_type": "TEXT_MESSAGE_CONTENT",
                    "data": {
                        "task_id": task_id,
                        "content": error_msg,
                        "is_final": False,
                    },
                }).encode("utf-8")
            )

        # Flush remaining buffered content from the parser
        if parser:
            for evt in parser.flush():
                if isinstance(evt, TextEvent) and evt.content:
                    await response.write(
                        create_sse_event({
                            "event_type": "TEXT_MESSAGE_CONTENT",
                            "data": {
                                "task_id": task_id,
                                "content": evt.content,
                                "is_final": False,
                            },
                        }).encode("utf-8")
                    )
                elif isinstance(evt, DirectiveEvent):
                    sse_evt = _build_directive_sse_event(evt, task_id, config)
                    await response.write(
                        create_sse_event(sse_evt).encode("utf-8")
                    )

        # Send final empty chunk to signal text completion
        await response.write(
            create_sse_event({
                "event_type": "TEXT_MESSAGE_CONTENT",
                "data": {
                    "task_id": task_id,
                    "content": "",
                    "is_final": True,
                },
            }).encode("utf-8")
        )

        # Save assistant reply to history (cleaned of raw directive syntax)
        if full_reply:
            cleaned = _clean_reply_for_history(full_reply) if use_parser else full_reply
            conv_mgr.add_assistant_message(session_id, cleaned)

        # 3. RUN_COMPLETED
        await response.write(
            create_sse_event({
                "event_type": "RUN_COMPLETED",
                "data": {
                    "task_id": task_id,
                    "status": "success",
                    "completed_at": datetime.now().isoformat(),
                },
            }).encode("utf-8")
        )

        print(f"  Reply:   {full_reply[:120]}{'...' if len(full_reply) > 120 else ''}")
        print(f"  Length:  {len(full_reply)} chars")

    except (ConnectionResetError, BrokenPipeError, RuntimeError) as e:
        print(f"  Client disconnected: {e}")
    finally:
        try:
            await response.write_eof()
        except Exception:
            pass  # Client already disconnected
        return response


async def handle_rollback(request: web.Request) -> web.Response:
    """Handle rollback request - remove last conversation turn."""
    config: AgentConfig = request.app["config"]
    conv_mgr: ConversationManager = request.app["conv_mgr"]

    if not verify_token(request, config):
        return web.json_response(
            {"error": "Unauthorized", "message": "Invalid or missing token"},
            status=401,
        )

    try:
        data = await request.json()
    except Exception as e:
        return web.json_response(
            {"error": "Invalid JSON", "message": str(e)},
            status=400,
        )

    message_id = data.get("message_id", "unknown")
    session_id = data.get("metadata", {}).get("session_id", "default")

    removed = conv_mgr.rollback(session_id)

    print(f"[Rollback] session={session_id} message_id={message_id} removed={removed}")

    return web.json_response({
        "status": "ok",
        "message_id": message_id,
        "timestamp": datetime.now().isoformat(),
    })


async def handle_health(request: web.Request) -> web.Response:
    """Health check endpoint."""
    config: AgentConfig = request.app["config"]
    return web.json_response({
        "status": "healthy",
        "agent_id": config.agent_id,
        "agent_name": config.agent_name,
        "provider": config.provider,
        "model": config.model,
        "timestamp": datetime.now().isoformat(),
    })


async def handle_info(request: web.Request) -> web.Response:
    """Agent info endpoint."""
    config: AgentConfig = request.app["config"]
    return web.json_response({
        "agent_id": config.agent_id,
        "name": config.agent_name,
        "provider": config.provider,
        "model": config.model,
        "endpoints": {
            "a2a_task": f"http://localhost:{config.port}/a2a/task",
            "a2a_agent_card": f"http://localhost:{config.port}/a2a/agent_card",
            "a2a_rollback": f"http://localhost:{config.port}/a2a/rollback",
            "health": f"http://localhost:{config.port}/health",
            "info": f"http://localhost:{config.port}/info",
        },
        "auth": "Bearer token required" if config.token else "No auth required",
    })


# ==================== Session Cleanup Task ====================

async def periodic_cleanup(app: web.Application):
    """Periodically clean up expired sessions."""
    conv_mgr: ConversationManager = app["conv_mgr"]
    while True:
        await asyncio.sleep(600)  # every 10 minutes
        conv_mgr.cleanup_expired(max_age_seconds=3600)


async def start_background_tasks(app: web.Application):
    app["cleanup_task"] = asyncio.create_task(periodic_cleanup(app))


async def cleanup_background_tasks(app: web.Application):
    app["cleanup_task"].cancel()
    try:
        await app["cleanup_task"]
    except asyncio.CancelledError:
        pass


# ==================== App Factory ====================

def create_app(config: AgentConfig, provider: LLMProvider) -> web.Application:
    """Create the web application."""
    app = web.Application()
    app["config"] = config
    app["provider"] = provider
    app["conv_mgr"] = ConversationManager(max_history=config.max_history)

    # Routes
    app.router.add_get("/health", handle_health)
    app.router.add_get("/info", handle_info)
    app.router.add_get("/a2a/agent_card", handle_agent_card)
    app.router.add_post("/a2a/task", handle_task)
    app.router.add_post("/a2a/rollback", handle_rollback)

    # Background tasks
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)

    return app


# ==================== CLI ====================

def resolve_api_key(args) -> str:
    """Resolve API key from args or environment variables."""
    if args.api_key:
        return args.api_key

    # Try provider-specific env vars first, then generic
    env_vars = ["LLM_API_KEY"]
    if args.provider == "openai":
        env_vars = ["OPENAI_API_KEY", "LLM_API_KEY"]
    elif args.provider == "claude":
        env_vars = ["ANTHROPIC_API_KEY", "LLM_API_KEY"]
    elif args.provider == "glm":
        env_vars = ["GLM_API_KEY", "ZHIPUAI_API_KEY", "LLM_API_KEY"]

    for var in env_vars:
        val = os.getenv(var)
        if val:
            return val

    return ""


def resolve_api_base(args) -> str:
    """Resolve API base URL."""
    if args.api_base:
        return args.api_base
    if args.provider == "claude":
        return "https://api.anthropic.com/v1"
    if args.provider == "glm":
        return "https://open.bigmodel.cn/api/paas/v4"
    return "https://api.openai.com/v1"


def parse_args():
    parser = argparse.ArgumentParser(
        description="LLM Agent Server - A2A protocol with real LLM integration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # OpenAI GPT-4o
  python llm_agent.py --provider openai --model gpt-4o --api-key sk-xxx

  # DeepSeek
  python llm_agent.py --provider openai --model deepseek-chat \\
      --api-base https://api.deepseek.com/v1 --api-key sk-xxx

  # Qwen (DashScope)
  python llm_agent.py --provider openai --model qwen-plus \\
      --api-base https://dashscope.aliyuncs.com/compatible-mode/v1 --api-key sk-xxx

  # Local Ollama
  python llm_agent.py --provider openai --model llama3 \\
      --api-base http://localhost:11434/v1

  # Claude
  python llm_agent.py --provider claude --model claude-sonnet-4-20250514 --api-key sk-ant-xxx

  # GLM-4.7 (ZhipuAI BigModel)
  python llm_agent.py --provider glm --model glm-4.7 --api-key xxx.xxx
        """,
    )

    parser.add_argument(
        "--provider",
        default="openai",
        choices=["openai", "claude", "glm"],
        help="LLM provider (default: openai)",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o",
        help="Model name (default: gpt-4o)",
    )
    parser.add_argument(
        "--api-base",
        default="",
        help="API base URL (auto-detected from provider if not set)",
    )
    parser.add_argument(
        "--api-key",
        default="",
        help="API key (also reads from OPENAI_API_KEY / ANTHROPIC_API_KEY / GLM_API_KEY / LLM_API_KEY env vars)",
    )
    parser.add_argument(
        "--system-prompt",
        default="You are a helpful AI assistant.",
        help="System prompt for the LLM",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("AGENT_PORT", "8080")),
        help="Server port (default: 8080)",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("AGENT_TOKEN", ""),
        help="Bearer token for authentication (optional)",
    )
    parser.add_argument(
        "--name",
        default=os.getenv("AGENT_NAME", "LLM Agent"),
        help="Agent display name",
    )
    parser.add_argument(
        "--agent-id",
        default=os.getenv("AGENT_ID", f"llm_agent_{uuid.uuid4().hex[:8]}"),
        help="Agent ID",
    )
    parser.add_argument(
        "--max-history",
        type=int,
        default=20,
        help="Max conversation turns to keep per session (default: 20)",
    )
    parser.add_argument(
        "--no-interactive",
        action="store_true",
        default=False,
        help="Disable interactive message directives (pure text mode)",
    )

    return parser.parse_args()


def main():
    args = parse_args()

    api_key = resolve_api_key(args)
    api_base = resolve_api_base(args)

    # Validate API key for cloud providers
    if args.provider in ("openai", "claude", "glm") and not api_key:
        is_local = any(h in api_base for h in ["localhost", "127.0.0.1", "0.0.0.0"])
        if not is_local:
            print(f"Warning: No API key provided for {args.provider}.")
            print("Set --api-key or the appropriate environment variable.")
            print("Continuing anyway (will fail on first request)...\n")

    # Combine system prompt with interactive directive instructions
    interactive = not args.no_interactive
    system_prompt = args.system_prompt
    if interactive:
        system_prompt = system_prompt.rstrip() + "\n\n" + INTERACTIVE_SYSTEM_PROMPT

    config = AgentConfig(
        agent_id=args.agent_id,
        agent_name=args.name,
        port=args.port,
        token=args.token,
        provider=args.provider,
        model=args.model,
        api_base=api_base,
        api_key=api_key,
        system_prompt=system_prompt,
        interactive=interactive,
        max_history=args.max_history,
    )

    # Create LLM provider
    if args.provider == "claude":
        provider = ClaudeProvider(api_base, api_key, args.model)
    elif args.provider == "glm":
        provider = GLMProvider(api_base, api_key, args.model)
    else:
        provider = OpenAIProvider(api_base, api_key, args.model)

    # Print startup info
    print("=" * 60)
    print("  LLM Agent Server")
    print("=" * 60)
    print(f"  Agent ID:   {config.agent_id}")
    print(f"  Agent Name: {config.agent_name}")
    print(f"  Provider:   {config.provider}")
    print(f"  Model:      {config.model}")
    print(f"  API Base:   {api_base}")
    print(f"  API Key:    {'***' + api_key[-4:] if len(api_key) > 4 else '(not set)'}")
    print(f"  Port:       {config.port}")
    print(f"  Auth:       {'Token required' if config.token else 'No auth'}")
    print(f"  History:    {config.max_history} turns per session")
    print(f"  Interactive: {'Enabled' if config.interactive else 'Disabled'}")
    print("-" * 60)
    print(f"  Agent Card: http://localhost:{config.port}/a2a/agent_card")
    print(f"  Task:       http://localhost:{config.port}/a2a/task")
    print(f"  Rollback:   http://localhost:{config.port}/a2a/rollback")
    print(f"  Health:     http://localhost:{config.port}/health")
    print(f"  Info:       http://localhost:{config.port}/info")
    if config.token:
        print("-" * 60)
        print(f"  Token:      {config.token}")
    print("=" * 60)
    print(f"\nServer starting on port {config.port}... Press Ctrl+C to stop.\n")

    app = create_app(config, provider)
    web.run_app(app, host="0.0.0.0", port=config.port, print=None)


if __name__ == "__main__":
    main()
