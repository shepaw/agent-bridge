"""LLM provider implementations for OpenAI-compatible, Claude, and GLM APIs."""

import hashlib
import hmac
import base64
import json
import time
from typing import AsyncGenerator, Awaitable, Callable, Dict, List

import aiohttp

from .types import LLMToolCall, LLMStreamResult


class LLMProvider:
    """Base class for LLM providers.

    Subclass and implement :meth:`stream_chat` (and optionally
    :meth:`stream_chat_with_tools`) to add a new LLM backend.
    """

    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str,
    ) -> AsyncGenerator[str, None]:
        """Yield text chunks from the LLM."""
        raise NotImplementedError
        yield  # pragma: no cover — make it a generator

    async def stream_chat_with_tools(
        self,
        messages: List[Dict],
        system_prompt: str,
        tools: List[Dict],
        on_text_chunk: Callable[[str], Awaitable[None]],
    ) -> LLMStreamResult:
        """Stream a chat completion that may include tool calls.

        Text chunks are delivered via *on_text_chunk*. Returns the complete
        result including any tool calls.
        """
        raise NotImplementedError


class OpenAIProvider(LLMProvider):
    """OpenAI-compatible API provider.

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

        api_messages: List[Dict] = []
        if system_prompt:
            api_messages.append({"role": "system", "content": system_prompt})
        api_messages.extend(messages)

        payload = {
            "model": self.model,
            "messages": api_messages,
            "stream": True,
        }

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

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

        api_messages: List[Dict] = []
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

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        text_content = ""
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
            tool_calls.append(LLMToolCall(id=buf["id"], name=buf["name"], arguments=args))

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

        payload: Dict = {
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

        payload: Dict = {
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

        tool_calls = []
        for idx in sorted(tool_use_blocks.keys()):
            buf = tool_use_blocks[idx]
            try:
                args = json.loads(buf["arguments"]) if buf["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(LLMToolCall(id=buf["id"], name=buf["name"], arguments=args))

        return LLMStreamResult(text_content=text_content, tool_calls=tool_calls)


class GLMProvider(LLMProvider):
    """ZhipuAI GLM API provider (GLM-4, GLM-4.7 series).

    The BigModel platform uses JWT-based authentication: the API key has the
    format ``{id}.{secret}``.
    """

    def __init__(self, api_base: str, api_key: str, model: str):
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model

    def _generate_jwt(self) -> str:
        """Generate a JWT token from the API key (format: id.secret)."""
        parts = self.api_key.split(".", 1)
        if len(parts) != 2:
            return self.api_key

        api_key_id, api_key_secret = parts

        header = json.dumps({"alg": "HS256", "sign_type": "SIGN", "typ": "JWT"}, separators=(",", ":"))
        now = int(time.time())
        payload = json.dumps({
            "api_key": api_key_id,
            "exp": now + 259200,  # 3 days
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

        api_messages: List[Dict] = []
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

        api_messages: List[Dict] = []
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
            tool_calls.append(LLMToolCall(id=buf["id"], name=buf["name"], arguments=args))

        return LLMStreamResult(text_content=text_content, tool_calls=tool_calls)
