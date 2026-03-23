#!/usr/bin/env python3
"""
ACP Agent Server - WebSocket bidirectional JSON-RPC 2.0 protocol

Supports the same LLM backends as llm_agent.py (OpenAI, Claude, GLM),
but communicates over WebSocket using the ACP protocol instead of HTTP+SSE.

Usage:
    python acp_agent.py --provider openai --model gpt-4o --api-key $OPENAI_API_KEY
"""

import asyncio
import json
import math
import re
import uuid
import argparse
import os
import sys
from datetime import datetime
from enum import Enum, auto
from typing import Dict, List, Optional, Union
from dataclasses import dataclass

try:
    from aiohttp import web
    import aiohttp
except ImportError:
    print("Error: aiohttp is required. Install it with: pip install aiohttp")
    sys.exit(1)

# Import reusable components from llm_agent
from llm_agent import (
    AgentConfig,
    ConversationManager,
    LLMProvider,
    LLMToolCall,
    LLMStreamResult,
    OpenAIProvider,
    ClaudeProvider,
    GLMProvider,
    verify_token,
    resolve_api_key,
    resolve_api_base,
)


# ==================== ACP Directive Stream Parser ====================

class _ACPParserState(Enum):
    STREAMING_TEXT = auto()
    MAYBE_DIRECTIVE = auto()
    IN_DIRECTIVE = auto()


@dataclass
class ACPTextChunk:
    """A plain text fragment."""
    content: str


@dataclass
class ACPDirective:
    """A parsed directive block with type and payload."""
    directive_type: str
    payload: dict


class ACPDirectiveStreamParser:
    """Streaming state-machine parser for <<<directive / >>> fence syntax.

    Recognises fenced directive blocks of the form:

        <<<directive
        {"type": "action_confirmation", ...}
        >>>

    Everything outside those blocks is emitted as ACPTextChunk.
    """

    _OPEN_FENCE = "<<<directive"
    _CLOSE_FENCE = ">>>"

    def __init__(self, known_types: set = None):
        self._state = _ACPParserState.STREAMING_TEXT
        self._buffer = ""
        self._directive_body = ""
        self._fence_line = ""  # raw text of the opening fence line, for fallback
        self._known_types = known_types

    def feed(self, chunk: str) -> List[Union[ACPTextChunk, ACPDirective]]:
        """Feed a chunk of text and return any events parsed so far."""
        self._buffer += chunk
        events: List[Union[ACPTextChunk, ACPDirective]] = []
        self._process(events)
        return events

    def flush(self) -> List[Union[ACPTextChunk, ACPDirective]]:
        """Call when the LLM stream is done. Flushes any buffered content."""
        events: List[Union[ACPTextChunk, ACPDirective]] = []
        if self._state == _ACPParserState.MAYBE_DIRECTIVE:
            events.append(ACPTextChunk(self._fence_line + self._buffer))
        elif self._state == _ACPParserState.IN_DIRECTIVE:
            events.append(ACPTextChunk(self._fence_line + self._directive_body + self._buffer))
        elif self._buffer:
            events.append(ACPTextChunk(self._buffer))
        self._buffer = ""
        self._reset()
        return events

    def _reset(self):
        self._state = _ACPParserState.STREAMING_TEXT
        self._directive_body = ""
        self._fence_line = ""

    def _process(self, events):
        changed = True
        while changed:
            changed = False
            if self._state == _ACPParserState.STREAMING_TEXT:
                changed = self._process_streaming_text(events)
            elif self._state == _ACPParserState.MAYBE_DIRECTIVE:
                changed = self._process_maybe_directive(events)
            elif self._state == _ACPParserState.IN_DIRECTIVE:
                changed = self._process_in_directive(events)

    def _process_streaming_text(self, events) -> bool:
        idx = self._buffer.find("<<<")
        if idx == -1:
            # Keep last 2 chars in case "<<<" is split across chunks
            safe = len(self._buffer) - 2
            if safe > 0:
                events.append(ACPTextChunk(self._buffer[:safe]))
                self._buffer = self._buffer[safe:]
            return False
        # Emit text before the fence
        if idx > 0:
            events.append(ACPTextChunk(self._buffer[:idx]))
        self._buffer = self._buffer[idx:]  # starts with "<<<"
        self._state = _ACPParserState.MAYBE_DIRECTIVE
        self._fence_line = ""
        return True

    def _process_maybe_directive(self, events) -> bool:
        # Need the full first line to confirm it's "<<<directive"
        newline_idx = self._buffer.find("\n")
        if newline_idx == -1:
            return False  # wait for more data
        first_line = self._buffer[:newline_idx].strip()
        if first_line == self._OPEN_FENCE:
            self._fence_line = self._buffer[:newline_idx + 1]
            self._buffer = self._buffer[newline_idx + 1:]
            self._directive_body = ""
            self._state = _ACPParserState.IN_DIRECTIVE
            return True
        # Not a valid directive opening — emit "<<<" as text and resume
        events.append(ACPTextChunk(self._buffer[:3]))
        self._buffer = self._buffer[3:]
        self._state = _ACPParserState.STREAMING_TEXT
        return True

    def _process_in_directive(self, events) -> bool:
        # Look for closing ">>>" on its own line
        search_target = "\n" + self._CLOSE_FENCE
        close_idx = self._buffer.find(search_target)
        if close_idx == -1:
            # Also check if buffer starts with ">>>" (body already consumed newlines)
            if self._buffer.lstrip().startswith(self._CLOSE_FENCE) and self._directive_body:
                stripped = self._buffer.lstrip()
                after_fence = stripped[len(self._CLOSE_FENCE):]
                if not after_fence or after_fence[0] == '\n' or after_fence.strip() == '':
                    return self._try_parse_directive(
                        events,
                        self._directive_body,
                        self._buffer[self._buffer.index(self._CLOSE_FENCE) + len(self._CLOSE_FENCE):],
                    )
            # Keep trailing chars that could be start of "\n>>>"
            keep = len(search_target) - 1
            safe = len(self._buffer) - keep
            if safe > 0:
                self._directive_body += self._buffer[:safe]
                self._buffer = self._buffer[safe:]
            return False

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
            dtype = payload.pop("type", None)
            if dtype and (self._known_types is None or dtype in self._known_types):
                events.append(ACPDirective(dtype, payload))
            else:
                # Unknown type — fall back to text
                events.append(ACPTextChunk(self._fence_line + body + "\n" + self._CLOSE_FENCE))
        except (json.JSONDecodeError, ValueError):
            events.append(ACPTextChunk(self._fence_line + body + "\n" + self._CLOSE_FENCE))
        self._buffer = remaining
        self._reset()
        return True


# ==================== ACP JSON-RPC Helpers ====================

def jsonrpc_response(id, result=None, error=None):
    """Build a JSON-RPC 2.0 response."""
    msg = {"jsonrpc": "2.0", "id": id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result if result is not None else {}
    return msg


def jsonrpc_notification(method, params=None):
    """Build a JSON-RPC 2.0 notification (no id)."""
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def jsonrpc_request(method, params=None, id=None):
    """Build a JSON-RPC 2.0 request."""
    msg = {"jsonrpc": "2.0", "method": method, "id": id or str(uuid.uuid4())}
    if params is not None:
        msg["params"] = params
    return msg


# ==================== ACP Directive -> JSON-RPC Notification Mapping ====================


def acp_directive_to_notification(
    directive: ACPDirective,
    task_id: str,
    component_method_map: Optional[Dict[str, str]] = None,
) -> dict:
    """Convert an ACPDirective into a JSON-RPC ui.* notification.

    Uses ``component_method_map`` (directive type -> ACP notification method)
    fetched from the app via hub.getUIComponentTemplates so that new component
    types added on the app side are automatically supported without modifying
    this agent code.

    The LLM's directive payload is forwarded as-is (with ``task_id`` injected),
    meaning the app defines the schema and this agent acts as a pass-through.
    """
    dtype = directive.directive_type
    payload = directive.payload

    method = (component_method_map or {}).get(dtype)

    if not method:
        return jsonrpc_notification("ui.textContent", {
            "task_id": task_id,
            "content": f"[Unknown directive: {dtype}]",
            "is_final": False,
        })

    # Generic pass-through: forward the LLM payload verbatim, inject task_id.
    params = dict(payload)
    params["task_id"] = task_id

    return jsonrpc_notification(method, params)


# ==================== Conversation History Cleanup (ACP) ====================

_ACP_DIRECTIVE_BLOCK_RE = re.compile(
    r"<<<directive\s*\n(.*?)\n>>>",
    re.DOTALL,
)


def _clean_reply_for_history_acp(full_reply: str) -> str:
    """Replace <<<directive ... >>> blocks with human-readable summaries.

    Uses a generic approach that works for any directive type by extracting
    common descriptive fields from the payload (prompt, title, options, etc.).
    No per-type branching required — new component types are summarised
    automatically.
    """

    def _summarise(m: re.Match) -> str:
        body = m.group(1).strip()
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            return m.group(0)

        dtype = payload.get("type", "unknown")

        # Build a compact summary from well-known descriptive keys present
        # in any directive payload. This works for existing types and any
        # future types that follow the same conventions.
        parts: list[str] = []

        # Prompt / title / reason — the "heading" of the directive
        for key in ("prompt", "title", "reason"):
            val = payload.get(key)
            if val and isinstance(val, str):
                parts.append(val)
                break  # one heading is enough

        # Options / actions / fields — list-like items with labels
        for key in ("actions", "options", "fields"):
            items = payload.get(key)
            if isinstance(items, list) and items:
                labels = [item.get("label", "?") for item in items if isinstance(item, dict)]
                if labels:
                    parts.append(", ".join(labels))
                break

        # Filename (for file_message etc.)
        filename = payload.get("filename")
        if filename:
            parts.append(filename)

        detail = ": " + " | ".join(parts) if parts else ""
        return f"[Directive {dtype}{detail}]"

    return _ACP_DIRECTIVE_BLOCK_RE.sub(_summarise, full_reply)


# ==================== ACP WebSocket Handler ====================

class ACPAgentServer:
    """Handles ACP WebSocket connections from the App."""

    def __init__(self, config: AgentConfig, provider: LLMProvider, conv_mgr: ConversationManager,
                 enable_mac_tools: bool = False, max_tool_rounds: int = 10):
        self.config = config
        self.provider = provider
        self.conv_mgr = conv_mgr
        self._active_tasks: Dict[str, asyncio.Task] = {}
        self._pending_hub_requests: Dict[str, asyncio.Future] = {}
        # Mac tools support
        self._enable_mac_tools = enable_mac_tools
        self._max_tool_rounds = max_tool_rounds
        self._pending_confirmations: Dict[str, asyncio.Future] = {}
        # Component version cache
        self._cached_component_version: Optional[str] = None
        self._cached_directive_prompt: Optional[str] = None
        self._cached_known_types: Optional[set] = None
        # Maps directive type name -> ACP notification method (e.g. "action_confirmation" -> "ui.actionConfirmation")
        self._cached_component_method_map: Optional[Dict[str, str]] = None
        # Cached UI component tool schemas for merging into tool-calling tool lists
        self._cached_ui_openai_tools: Optional[List[dict]] = None
        self._cached_ui_claude_tools: Optional[List[dict]] = None
        # Host/port derived from WebSocket connection for constructing reachable file URLs
        self._ws_host: Optional[str] = None

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        """Handle incoming WebSocket connection."""
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        # Capture the host from the WebSocket request for constructing file URLs
        host_header = request.headers.get("Host")
        if host_header:
            self._ws_host = host_header
        else:
            self._ws_host = f"localhost:{self.config.port}"

        print(f"[ACP] New WebSocket connection from {request.remote}")

        authenticated = False

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        await ws.send_json(jsonrpc_response(
                            None,
                            error={"code": -32700, "message": "Parse error"},
                        ))
                        continue

                    method = data.get("method")
                    msg_id = data.get("id")
                    params = data.get("params", {})

                    # Route based on message type
                    if msg_id is not None and method is not None:
                        # Request from App
                        if method == "auth.authenticate":
                            authenticated, response = self._handle_auth(msg_id, params)
                            await ws.send_json(response)
                        elif method == "ping":
                            await ws.send_json(jsonrpc_response(msg_id, result={"pong": True}))
                        elif not authenticated:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32000, "message": "Not authenticated"},
                            ))
                        elif method == "agent.chat":
                            await self._handle_chat(ws, msg_id, params)
                        elif method == "agent.cancelTask":
                            await self._handle_cancel_task(ws, msg_id, params)
                        elif method == "agent.submitResponse":
                            await self._handle_submit_response(ws, msg_id, params)
                        elif method == "agent.rollback":
                            await self._handle_rollback(ws, msg_id, params)
                        elif method == "agent.getCard":
                            await self._handle_get_card(ws, msg_id)
                        elif method == "agent.requestFileData":
                            await self._handle_request_file_data(ws, msg_id, params)
                        else:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32601, "message": f"Method not found: {method}"},
                            ))

                    elif msg_id is not None and method is None:
                        # Response to our request (e.g. hub.* responses)
                        future = self._pending_hub_requests.pop(msg_id, None)
                        if future and not future.done():
                            error = data.get("error")
                            if error:
                                future.set_exception(
                                    RuntimeError(f"Hub request failed: {error.get('message', error)}")
                                )
                            else:
                                future.set_result(data.get("result"))

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    print(f"[ACP] WebSocket error: {ws.exception()}")

        except Exception as e:
            print(f"[ACP] Connection error: {e}")
        finally:
            # Cancel any active tasks for this connection
            for task_id, task in self._active_tasks.items():
                task.cancel()
            self._active_tasks.clear()
            # Cancel any pending hub requests
            for req_id, future in self._pending_hub_requests.items():
                if not future.done():
                    future.cancel()
            self._pending_hub_requests.clear()
            print(f"[ACP] WebSocket connection closed")

        return ws

    def _handle_auth(self, msg_id, params: dict) -> tuple:
        """Handle auth.authenticate request. Returns (authenticated, response)."""
        token = params.get("token", "")

        if not self.config.token:
            # No auth required
            return True, jsonrpc_response(msg_id, result={"status": "authenticated"})

        if token == self.config.token:
            print("[ACP] Authentication successful")
            return True, jsonrpc_response(msg_id, result={"status": "authenticated"})
        else:
            print("[ACP] Authentication failed")
            return False, jsonrpc_response(
                msg_id,
                error={"code": -32000, "message": "Authentication failed"},
            )

    # ==================== Model Routing ====================

    def _detect_modality(self, attachments: list | None) -> str:
        """Detect the primary modality of a message based on its attachments.

        Priority: video > audio > image > text.
        """
        if not attachments:
            return "text"
        for a in attachments:
            if isinstance(a, dict) and a.get("type") == "video":
                return "video"
        for a in attachments:
            if isinstance(a, dict) and a.get("type") == "audio":
                return "audio"
        for a in attachments:
            if isinstance(a, dict) and a.get("type") == "image":
                return "image"
        return "text"

    def _resolve_provider(self, attachments: list | None) -> LLMProvider:
        """Return the LLMProvider for the detected modality, or the default.

        Uses config.model_routing to look up per-modality overrides. Any
        field not specified in the route inherits from the top-level config.
        """
        routing = self.config.model_routing
        if not routing:
            return self.provider

        modality = self._detect_modality(attachments)
        route = routing.get(modality)
        if not route or not isinstance(route, dict):
            return self.provider

        # Resolve with fallback to top-level config
        provider_type = route.get("provider") or self.config.provider
        model = route.get("model") or self.config.model
        api_base = route.get("api_base") or self.config.api_base
        api_key = route.get("api_key") or self.config.api_key

        # Avoid re-creating if it's the same as the default provider
        if (provider_type == self.config.provider and
                model == self.config.model and
                api_base == self.config.api_base and
                api_key == self.config.api_key):
            return self.provider

        print(f"  Model routing: modality={modality} -> provider={provider_type}, model={model}")

        if provider_type == "claude":
            return ClaudeProvider(api_base, api_key, model)
        elif provider_type == "glm":
            return GLMProvider(api_base, api_key, model)
        else:
            return OpenAIProvider(api_base, api_key, model)

    async def _handle_chat(self, ws, msg_id, params: dict):
        """Handle agent.chat request - stream LLM response via notifications."""
        task_id = params.get("task_id", str(uuid.uuid4()))
        session_id = params.get("session_id", task_id)
        message = params.get("message", "")
        user_id = params.get("user_id", "")
        message_id = params.get("message_id", "")
        history = params.get("history")
        total_message_count = params.get("total_message_count")
        is_history_supplement = params.get("history_supplement", False)
        additional_history = params.get("additional_history")
        original_question = params.get("original_question")
        system_prompt_override = params.get("system_prompt")
        group_context = params.get("group_context")
        attachments = params.get("attachments")

        if not message and not is_history_supplement:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32602, "message": "Missing 'message' parameter"},
            ))
            return

        print(f"\n{'='*60}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] ACP Chat - Task {task_id}")
        print(f"  Session: {session_id}")
        print(f"  Input:   {message[:120]}{'...' if len(message) > 120 else ''}")
        print(f"{'='*60}")

        # Send response to acknowledge the request
        await ws.send_json(jsonrpc_response(msg_id, result={
            "task_id": task_id,
            "status": "accepted",
        }))

        # Send task.started notification
        await ws.send_json(jsonrpc_notification("task.started", {
            "task_id": task_id,
            "started_at": datetime.now().isoformat(),
        }))

        # Capture interactive params for use in the background task
        ui_component_version = params.get("ui_component_version") if self.config.interactive else None

        # Restore session from app-provided history
        if not self.conv_mgr.has_session(session_id) and history:
            valid_history = [
                {"role": m["role"], "content": m["content"]}
                for m in history
                if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content")
            ]
            if valid_history:
                self.conv_mgr.initialize_session(session_id, valid_history)
                print(f"  Restored {len(valid_history)} messages from app history")

        # Log total_message_count vs local context for diagnostics
        if total_message_count is not None:
            local_count = len(self.conv_mgr.get_messages(session_id)) if self.conv_mgr.has_session(session_id) else 0
            print(f"  total_message_count from app: {total_message_count}, local context: {local_count}")
            if total_message_count > local_count:
                print(f"  Note: app has {total_message_count - local_count} more messages than local context")

        # Handle history supplement
        if is_history_supplement:
            if additional_history and isinstance(additional_history, list):
                valid_additional = [
                    {"role": m["role"], "content": m["content"]}
                    for m in additional_history
                    if isinstance(m, dict)
                    and m.get("role") in ("user", "assistant")
                    and m.get("content")
                ]
                if valid_additional:
                    self.conv_mgr.prepend_history(session_id, valid_additional)
                    print(f"  Prepended {len(valid_additional)} older messages")

            # Remove previous incomplete assistant reply
            msgs = self.conv_mgr.get_messages(session_id)
            if msgs and msgs[-1]["role"] == "assistant":
                msgs.pop()

            messages = self.conv_mgr.get_messages(session_id)
        else:
            self.conv_mgr.add_user_message(session_id, message)
            messages = self.conv_mgr.get_messages(session_id)

        # Build multimodal user message if attachments are present
        if attachments and isinstance(attachments, list):
            multimodal_messages = self._build_multimodal_messages(messages, attachments)
        else:
            multimodal_messages = messages

        # Resolve the LLM provider based on attachment modality (model routing)
        resolved_provider = self._resolve_provider(attachments)

        # Stream LLM response — choose tool-aware or plain path
        if self._enable_mac_tools:
            task = asyncio.create_task(
                self._stream_task_with_tools(ws, task_id, session_id, multimodal_messages, ui_component_version, system_prompt_override, resolved_provider)
            )
        else:
            task = asyncio.create_task(
                self._stream_task(ws, task_id, session_id, multimodal_messages, ui_component_version, system_prompt_override, resolved_provider)
            )
        self._active_tasks[task_id] = task

    def _build_multimodal_messages(self, messages: list, attachments: list) -> list:
        """Replace the last user message with a multimodal version if attachments
        contain images. Non-image attachments are prepended as text descriptions.

        The provider type determines the content format:
        - OpenAI: [{"type": "text", ...}, {"type": "image_url", ...}]
        - Claude: [{"type": "image", "source": {...}}, {"type": "text", ...}]
        """
        if not messages:
            return messages

        # Find the last user message
        last_user_idx = None
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break
        if last_user_idx is None:
            return messages

        original_text = messages[last_user_idx].get("content", "")
        image_attachments = [a for a in attachments if a.get("type") == "image" and a.get("data")]
        non_image_attachments = [a for a in attachments if a.get("type") != "image"]

        # Prepend non-image attachment descriptions
        extra_text = ""
        if non_image_attachments:
            descriptions = []
            for a in non_image_attachments:
                name = a.get("file_name", "unknown")
                size = a.get("size", 0)
                atype = a.get("type", "file")
                size_str = f"{size / 1024:.1f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.1f} MB"
                descriptions.append(f"[{atype.capitalize()}: {name} ({size_str})]")
            extra_text = "\n".join(descriptions) + "\n\n"

        effective_text = extra_text + original_text

        if not image_attachments:
            # No images — just update text with non-image descriptions
            result = list(messages)
            result[last_user_idx] = {"role": "user", "content": effective_text}
            return result

        is_claude = isinstance(self.provider, ClaudeProvider)

        if is_claude:
            content_parts = []
            for img in image_attachments:
                content_parts.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.get("mime_type", "image/png"),
                        "data": img["data"],
                    },
                })
            content_parts.append({"type": "text", "text": effective_text})
        else:
            content_parts = [{"type": "text", "text": effective_text}]
            for img in image_attachments:
                mime = img.get("mime_type", "image/png")
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{img['data']}"},
                })

        result = list(messages)
        result[last_user_idx] = {"role": "user", "content": content_parts}
        return result

    async def _build_system_prompt(self, ws, ui_component_version, system_prompt_override=None):
        """Build the effective system prompt, fetching UI components if needed.

        When mac tools mode is active, the directive prompt is NOT appended
        because tool calling is used instead of directive syntax. However, the
        UI component schemas are still fetched so they can be merged into the
        tool list.

        If ``system_prompt_override`` is provided (e.g. from a group chat
        context), it is used as the base system prompt instead of the agent's
        own configured prompt.
        """
        system_prompt = system_prompt_override if system_prompt_override else self.config.system_prompt
        if self.config.interactive:
            need_fetch = (
                self._cached_directive_prompt is None
                or (ui_component_version and ui_component_version != self._cached_component_version)
            )
            if need_fetch:
                if ui_component_version:
                    print(f"  UI component version changed: {self._cached_component_version} -> {ui_component_version}")
                else:
                    print("  No cached directive prompt, fetching UI components...")
                await self._fetch_ui_components(ws)
            # Only append directive prompt in non-mac-tools mode (directive syntax)
            if self._cached_directive_prompt and not self._enable_mac_tools:
                system_prompt = system_prompt.rstrip() + "\n\n" + self._cached_directive_prompt
        return system_prompt

    async def _stream_task(self, ws, task_id, session_id, messages, ui_component_version, system_prompt_override=None, provider=None):
        """Plain text streaming task (no tool calling)."""
        full_reply = ""
        system_prompt = await self._build_system_prompt(ws, ui_component_version, system_prompt_override)

        use_parser = self.config.interactive
        parser = ACPDirectiveStreamParser(known_types=self._cached_known_types) if use_parser else None
        component_method_map = self._cached_component_method_map
        active_provider = provider or self.provider

        try:
            async for chunk in active_provider.stream_chat(messages, system_prompt):
                full_reply += chunk

                if parser:
                    for evt in parser.feed(chunk):
                        if isinstance(evt, ACPTextChunk) and evt.content:
                            await ws.send_json(jsonrpc_notification("ui.textContent", {
                                "task_id": task_id,
                                "content": evt.content,
                                "is_final": False,
                            }))
                        elif isinstance(evt, ACPDirective):
                            notification = acp_directive_to_notification(evt, task_id, component_method_map)
                            await ws.send_json(notification)
                else:
                    await ws.send_json(jsonrpc_notification("ui.textContent", {
                        "task_id": task_id,
                        "content": chunk,
                        "is_final": False,
                    }))

            # Flush remaining parser content
            if parser:
                for evt in parser.flush():
                    if isinstance(evt, ACPTextChunk) and evt.content:
                        await ws.send_json(jsonrpc_notification("ui.textContent", {
                            "task_id": task_id,
                            "content": evt.content,
                            "is_final": False,
                        }))
                    elif isinstance(evt, ACPDirective):
                        notification = acp_directive_to_notification(evt, task_id, component_method_map)
                        await ws.send_json(notification)

            # Send final text marker
            await ws.send_json(jsonrpc_notification("ui.textContent", {
                "task_id": task_id,
                "content": "",
                "is_final": True,
            }))

            # Save to conversation history
            if full_reply:
                cleaned = _clean_reply_for_history_acp(full_reply) if use_parser else full_reply
                self.conv_mgr.add_assistant_message(session_id, cleaned)

            # Send task.completed
            await ws.send_json(jsonrpc_notification("task.completed", {
                "task_id": task_id,
                "status": "success",
                "completed_at": datetime.now().isoformat(),
            }))

            print(f"  Reply:   {full_reply[:120]}{'...' if len(full_reply) > 120 else ''}")
            print(f"  Length:  {len(full_reply)} chars")

        except asyncio.CancelledError:
            print(f"  Task {task_id} cancelled")
            await ws.send_json(jsonrpc_notification("task.error", {
                "task_id": task_id,
                "message": "Task cancelled",
                "code": -32008,
            }))
        except Exception as e:
            print(f"  Task {task_id} error: {e}")
            await ws.send_json(jsonrpc_notification("task.error", {
                "task_id": task_id,
                "message": str(e),
                "code": -32603,
            }))
        finally:
            self._active_tasks.pop(task_id, None)

    async def _stream_task_with_tools(self, ws, task_id, session_id, messages, ui_component_version, system_prompt_override=None, provider=None):
        """Tool-aware streaming task with multi-round tool execution loop."""
        from mac_tools import (
            MAC_TOOLS_DEFINITIONS, get_tool_definitions_for_claude,
            classify_risk, run_tool, get_risk_description, RiskLevel,
        )

        full_text_reply = ""
        system_prompt = await self._build_system_prompt(ws, ui_component_version, system_prompt_override)
        active_provider = provider or self.provider

        # Add mac tools context to system prompt
        mac_tools_prompt = (
            "\n\n## Mac Operation Tools\n\n"
            "You are an AI agent running directly on the user's Mac computer. "
            "You have FULL ACCESS to the user's Mac through function-calling tools. "
            "These tools allow you to run shell commands, read/write files, open applications, take screenshots, "
            "access the clipboard, query system info, and execute AppleScript.\n\n"
            "**CRITICAL: You CAN and MUST directly operate the Mac. You are NOT a cloud-based assistant "
            "without computer access. You have real tools that execute real commands on this machine. "
            "NEVER say you cannot access the computer, cannot run commands, or cannot check system info. "
            "Instead, USE the provided tools to perform the requested operations.**\n\n"
            "**Important rules:**\n"
            "- When the user asks you to perform ANY operation on their Mac (check disk space, list files, "
            "get system info, run commands, etc.), you MUST call the appropriate tool function. "
            "Do NOT refuse or say you cannot do it. Do NOT output tool invocations as text.\n"
            "- For example, to check disk space, call the `shell_exec` tool with command `df -h` "
            "or call `system_info` with category `disk`.\n"
            "- **File/Image Transfer**: When the user asks you to send, share, or show them a file or image, "
            "you MUST use the `send_file` tool. This is the ONLY way to deliver files to the user's app. "
            "Do NOT use `file_read` for binary files (images, PDFs, archives, etc.) — it will produce garbled text. "
            "Do NOT just describe the file metadata — actually send it with `send_file`.\n"
            "- Before calling a tool, briefly explain what you are about to do.\n"
            "- After receiving tool results, summarize the output clearly for the user.\n"
            "- You may call multiple tools in sequence to accomplish complex tasks.\n"
            "- Some operations may require user confirmation before execution. "
            "If so, the system will handle the confirmation flow automatically.\n"
        )

        # Add UI component tools prompt if available
        if self._cached_component_method_map:
            mac_tools_prompt += (
                "\n\n## App UI Components\n\n"
                "In addition to Mac tools, you can send interactive UI components to the user's app. "
                "These are rendered as rich widgets in the chat interface:\n"
                "- `action_confirmation`: Present action buttons (Approve/Reject/etc.)\n"
                "- `single_select`: Present a single-choice list\n"
                "- `multi_select`: Present a multi-choice list\n"
                "- `file_upload`: Request file uploads from the user\n"
                "- `form`: Present a structured form\n"
                "- `message_metadata`: Make a message collapsible\n\n"
                "**IMPORTANT**: When you need user confirmation or want to present choices, "
                "use these UI component tools — they render in the user's app. "
                "Do NOT use AppleScript dialogs or macOS native notifications for user interaction. "
                "The app UI components provide a much better experience.\n"
            )

        system_prompt = system_prompt.rstrip() + mac_tools_prompt

        # Select tool format based on provider
        is_claude = isinstance(self.provider, ClaudeProvider)
        tools = get_tool_definitions_for_claude() if is_claude else MAC_TOOLS_DEFINITIONS

        # Merge UI component tools from hub if available
        if self._cached_component_method_map:
            ui_tools = self._get_ui_component_tools(is_claude)
            if ui_tools:
                tools = list(tools) + ui_tools
                print(f"  Merged {len(ui_tools)} UI component tools into tool list")

        # Make a mutable copy of messages for the tool loop
        loop_messages = list(messages)

        # Callback to stream text chunks to the app (defined once, used in every round)
        async def on_text_chunk(chunk):
            nonlocal full_text_reply
            full_text_reply += chunk
            await ws.send_json(jsonrpc_notification("ui.textContent", {
                "task_id": task_id,
                "content": chunk,
                "is_final": False,
            }))

        try:
            for round_num in range(self._max_tool_rounds):
                print(f"  [Tool Round {round_num + 1}/{self._max_tool_rounds}]")

                result = await active_provider.stream_chat_with_tools(
                    loop_messages, system_prompt, tools, on_text_chunk
                )

                # If no tool calls, the LLM is done
                if not result.tool_calls:
                    print(f"  No tool calls in round {round_num + 1}, finishing")
                    print(f"  LLM text response: {(result.text_content or '')[:200]}")
                    break

                # Process each tool call
                tool_results = []
                sent_ui_component = False
                for tc in result.tool_calls:
                    # Check if this is a UI component tool call
                    if tc.name in (self._cached_component_method_map or {}):
                        tool_result = await self._handle_ui_component_tool_call(
                            ws, task_id, tc
                        )
                        tool_results.append((tc, tool_result))
                        sent_ui_component = True
                        continue

                    # Intercept send_file: exec, build URL, send ui.fileMessage
                    if tc.name == "send_file":
                        tool_result = await self._handle_send_file_tool_call(
                            ws, task_id, tc
                        )
                        tool_results.append((tc, tool_result))
                        continue

                    risk = classify_risk(tc.name, tc.arguments)
                    description = get_risk_description(risk, tc.name, tc.arguments)
                    print(f"  Tool: {tc.name} | Risk: {risk.value} | {description[:80]}")

                    if risk == RiskLevel.SAFE:
                        tool_result = await run_tool(tc.name, tc.arguments)

                    elif risk == RiskLevel.LOW_RISK:
                        tool_result = await run_tool(tc.name, tc.arguments)
                        # Notify user about the operation
                        await ws.send_json(jsonrpc_notification("ui.textContent", {
                            "task_id": task_id,
                            "content": f"\n> Executed: {description}\n",
                            "is_final": False,
                        }))

                    elif risk == RiskLevel.HIGH_RISK:
                        tool_result = await self._request_confirmation_and_execute(
                            ws, task_id, tc, description
                        )

                    else:
                        tool_result = {"success": False, "error": "Unknown risk level"}

                    tool_results.append((tc, tool_result))

                # If a UI component was sent, end the task immediately.
                # The user's response will arrive as a new agent.chat message.
                if sent_ui_component:
                    print(f"  UI component sent, ending task")
                    break

                # Append tool round to messages based on provider format
                if is_claude:
                    loop_messages = self._append_tool_round_claude(
                        loop_messages, result, tool_results
                    )
                else:
                    loop_messages = self._append_tool_round_openai(
                        loop_messages, result, tool_results
                    )

                # Continue the loop so LLM can process tool results

            # Send final text marker
            await ws.send_json(jsonrpc_notification("ui.textContent", {
                "task_id": task_id,
                "content": "",
                "is_final": True,
            }))

            # Save to conversation history (just the text portion)
            if full_text_reply:
                self.conv_mgr.add_assistant_message(session_id, full_text_reply)

            # Send task.completed
            await ws.send_json(jsonrpc_notification("task.completed", {
                "task_id": task_id,
                "status": "success",
                "completed_at": datetime.now().isoformat(),
            }))

            print(f"  Reply:   {full_text_reply[:120]}{'...' if len(full_text_reply) > 120 else ''}")
            print(f"  Length:  {len(full_text_reply)} chars")

        except asyncio.CancelledError:
            print(f"  Task {task_id} cancelled")
            # Clean up any pending confirmations for this task
            for cid, future in list(self._pending_confirmations.items()):
                if not future.done():
                    future.cancel()
            self._pending_confirmations.clear()
            await ws.send_json(jsonrpc_notification("task.error", {
                "task_id": task_id,
                "message": "Task cancelled",
                "code": -32008,
            }))
        except Exception as e:
            print(f"  Task {task_id} error: {e}")
            await ws.send_json(jsonrpc_notification("task.error", {
                "task_id": task_id,
                "message": str(e),
                "code": -32603,
            }))
        finally:
            self._active_tasks.pop(task_id, None)

    async def _request_confirmation_and_execute(self, ws, task_id, tool_call: 'LLMToolCall', description: str) -> dict:
        """Send a confirmation request to the user and wait for their response."""
        from mac_tools import run_tool

        confirmation_id = f"mac_tool_{uuid.uuid4().hex[:8]}"
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_confirmations[confirmation_id] = future

        # Send ui.actionConfirmation notification
        await ws.send_json(jsonrpc_notification("ui.actionConfirmation", {
            "task_id": task_id,
            "confirmation_id": confirmation_id,
            "confirmation_context": "mac_tool",
            "prompt": f"Allow this operation?\n\n{description}",
            "actions": [
                {"id": "approve", "label": "Approve", "style": "primary"},
                {"id": "reject", "label": "Reject", "style": "danger"},
            ],
        }))

        # Also notify via text stream
        await ws.send_json(jsonrpc_notification("ui.textContent", {
            "task_id": task_id,
            "content": f"\n⚠️ **Waiting for confirmation:** {description}\n",
            "is_final": False,
        }))

        try:
            response_data = await asyncio.wait_for(future, timeout=300)

            selected_action = response_data.get("selected_action_id", "")
            if selected_action == "approve":
                print(f"  Confirmation {confirmation_id}: APPROVED")
                await ws.send_json(jsonrpc_notification("ui.textContent", {
                    "task_id": task_id,
                    "content": "\n✅ Approved. Executing...\n",
                    "is_final": False,
                }))
                return await run_tool(tool_call.name, tool_call.arguments)
            else:
                print(f"  Confirmation {confirmation_id}: REJECTED")
                await ws.send_json(jsonrpc_notification("ui.textContent", {
                    "task_id": task_id,
                    "content": "\n❌ Operation rejected by user.\n",
                    "is_final": False,
                }))
                return {"success": False, "error": "Operation rejected by user"}

        except asyncio.TimeoutError:
            self._pending_confirmations.pop(confirmation_id, None)
            print(f"  Confirmation {confirmation_id}: TIMED OUT")
            await ws.send_json(jsonrpc_notification("ui.textContent", {
                "task_id": task_id,
                "content": "\n⏰ Confirmation timed out.\n",
                "is_final": False,
            }))
            return {"success": False, "error": "Confirmation timed out (300s)"}

    async def _handle_ui_component_tool_call(self, ws, task_id, tool_call: 'LLMToolCall') -> dict:
        """Convert a UI component tool call into an ACP ui.* notification.

        All UI component notifications are fire-and-forget: the notification is
        sent and the current task completes immediately. The user's response
        (button click, form submit, etc.) arrives as a new ``agent.chat``
        message — exactly like the directive-based (non-tool-calling) path.
        """
        method = (self._cached_component_method_map or {}).get(tool_call.name)
        if not method:
            return {"success": False, "error": f"Unknown UI component: {tool_call.name}"}

        params = dict(tool_call.arguments) if tool_call.arguments else {}
        params["task_id"] = task_id

        # For file_message: enrich params when url is a local path
        if tool_call.name == "file_message":
            url = params.get("url", "")
            if url and not url.startswith(("http://", "https://")):
                # Local file path — serve it over HTTP and fill in missing fields
                from mac_tools import exec_send_file
                send_result = await exec_send_file(
                    path=url,
                    filename=params.get("filename"),
                    mime_type=params.get("mime_type"),
                )
                if send_result.get("success"):
                    file_id = send_result["file_id"]
                    host = self._ws_host or f"localhost:{self.config.port}"
                    params["url"] = f"http://{host}/files/{file_id}"
                    if not params.get("size"):
                        params["size"] = send_result.get("size", 0)
                    if not params.get("filename"):
                        params["filename"] = send_result.get("filename", "file")
                    if not params.get("mime_type"):
                        params["mime_type"] = send_result.get("mime_type", "application/octet-stream")
            # Fill size from local file if still missing or zero
            if not params.get("size"):
                local_url = params.get("url", "")
                if local_url and not local_url.startswith(("http://", "https://")):
                    try:
                        params["size"] = os.path.getsize(local_url)
                    except OSError:
                        params["size"] = 0

        # Generate an ID if the LLM didn't provide one
        id_key = {
            "action_confirmation": "confirmation_id",
            "single_select": "select_id",
            "multi_select": "select_id",
            "file_upload": "upload_id",
            "form": "form_id",
        }.get(tool_call.name)
        if id_key and not params.get(id_key):
            params[id_key] = f"ui_{uuid.uuid4().hex[:8]}"

        print(f"  UI Component: {tool_call.name} -> {method}")

        # Send the UI notification (fire-and-forget)
        await ws.send_json(jsonrpc_notification(method, params))

        return {
            "success": True,
            "message": f"UI component '{tool_call.name}' has been sent to the user. "
                       "The current task is now complete. The user's response will "
                       "arrive as a new message.",
        }

    async def _handle_send_file_tool_call(self, ws, task_id, tool_call: 'LLMToolCall') -> dict:
        """Execute send_file, serve the file over HTTP, and send a ui.fileMessage notification."""
        from mac_tools import exec_send_file

        args = tool_call.arguments or {}
        result = await exec_send_file(
            path=args.get("path", ""),
            filename=args.get("filename"),
            mime_type=args.get("mime_type"),
        )

        if not result.get("success"):
            return result

        file_id = result["file_id"]
        # Build a reachable HTTP URL using the host derived from the WS connection
        host = self._ws_host or f"localhost:{self.config.port}"
        file_url = f"http://{host}/files/{file_id}"
        result["url"] = file_url

        # Send ui.fileMessage notification to the app
        file_message_params = {
            "task_id": task_id,
            "url": file_url,
            "filename": result["filename"],
            "mime_type": result["mime_type"],
            "size": result["size"],
        }

        # Forward thumbnail if the agent generated one
        if result.get("thumbnail_base64"):
            file_message_params["thumbnail_base64"] = result["thumbnail_base64"]

        await ws.send_json(jsonrpc_notification("ui.fileMessage", file_message_params))

        print(f"  send_file: {result['filename']} ({result['size']} bytes) -> {file_url}")

        return {
            "success": True,
            "message": f"File '{result['filename']}' has been sent to the user and will appear in their chat.",
            "url": file_url,
            "filename": result["filename"],
            "mime_type": result["mime_type"],
            "size": result["size"],
        }

    async def _handle_request_file_data(self, ws, msg_id, params: dict):
        """Handle agent.requestFileData — send file via binary WebSocket frames."""
        from mac_tools import get_served_file

        file_id = params.get("file_id", "")
        if not file_id:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32602, "message": "Missing 'file_id' parameter"},
            ))
            return

        entry = get_served_file(file_id)
        if entry is None:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32003, "message": f"File not found: {file_id}"},
            ))
            return

        file_path = entry["path"]
        if not os.path.exists(file_path):
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32003, "message": "File no longer exists on disk"},
            ))
            return

        chunk_size = 65536  # 64KB
        file_size = entry["size"]
        chunk_count = math.ceil(file_size / chunk_size) if file_size > 0 else 1

        metadata = {
            "file_id": file_id,
            "filename": entry["filename"],
            "mime_type": entry["mime_type"],
            "size": file_size,
            "chunk_size": chunk_size,
            "chunk_count": chunk_count,
        }

        try:
            # Step 1: Send JSON-RPC response with metadata
            await ws.send_json(jsonrpc_response(msg_id, result=metadata))

            # Step 2: Send file.transferStart notification
            await ws.send_json(jsonrpc_notification("file.transferStart", metadata))

            # Step 3: Stream binary frames
            # Header: 4 bytes magic "FILE" + 12 bytes file_id (UTF-8, null-padded)
            magic = b"FILE"
            file_id_bytes = file_id.encode("utf-8")[:12]
            file_id_padded = file_id_bytes + b"\x00" * (12 - len(file_id_bytes))
            header = magic + file_id_padded

            total_sent = 0
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    await ws.send_bytes(header + chunk)
                    total_sent += len(chunk)

            # Step 4: Send file.transferComplete notification
            await ws.send_json(jsonrpc_notification("file.transferComplete", {
                "file_id": file_id,
                "total_bytes": total_sent,
            }))

            print(f"  [FileTransfer] Sent {entry['filename']} ({total_sent} bytes) via {chunk_count} binary frames")

        except Exception as e:
            print(f"  [FileTransfer] Error sending {file_id}: {e}")
            try:
                await ws.send_json(jsonrpc_notification("file.transferError", {
                    "file_id": file_id,
                    "error": str(e),
                }))
            except Exception:
                pass  # Connection may already be broken

    def _append_tool_round_openai(self, messages, result: 'LLMStreamResult',
                                   tool_results: list) -> list:
        """Append a tool call round in OpenAI message format."""
        import json as _json

        # Assistant message with tool_calls
        assistant_msg = {"role": "assistant", "content": result.text_content or None}
        assistant_msg["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.name,
                    "arguments": _json.dumps(tc.arguments, ensure_ascii=False),
                },
            }
            for tc, _ in tool_results
        ]
        messages = list(messages)
        messages.append(assistant_msg)

        # Tool result messages
        for tc, tr in tool_results:
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": _json.dumps(tr, ensure_ascii=False),
            })

        return messages

    def _append_tool_round_claude(self, messages, result: 'LLMStreamResult',
                                   tool_results: list) -> list:
        """Append a tool call round in Claude message format."""
        import json as _json

        # Assistant message with content blocks
        content_blocks = []
        if result.text_content:
            content_blocks.append({"type": "text", "text": result.text_content})
        for tc, _ in tool_results:
            content_blocks.append({
                "type": "tool_use",
                "id": tc.id,
                "name": tc.name,
                "input": tc.arguments,
            })

        messages = list(messages)
        messages.append({"role": "assistant", "content": content_blocks})

        # User message with tool_result blocks
        result_blocks = []
        for tc, tr in tool_results:
            result_blocks.append({
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": _json.dumps(tr, ensure_ascii=False),
            })
        messages.append({"role": "user", "content": result_blocks})

        return messages

    async def _handle_cancel_task(self, ws, msg_id, params: dict):
        """Handle agent.cancelTask request."""
        task_id = params.get("task_id", "")
        task = self._active_tasks.get(task_id)

        if task and not task.done():
            task.cancel()
            await ws.send_json(jsonrpc_response(msg_id, result={
                "task_id": task_id,
                "status": "cancelled",
            }))
            print(f"[ACP] Task {task_id} cancel requested")
        else:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32003, "message": f"Task not found: {task_id}"},
            ))

    async def _handle_submit_response(self, ws, msg_id, params: dict):
        """Handle agent.submitResponse - user submitted an interactive response."""
        task_id = params.get("task_id", "")
        response_type = params.get("response_type", "")
        response_data = params.get("response_data", {})

        print(f"[ACP] Submit response: type={response_type} task={task_id}")

        # Acknowledge
        await ws.send_json(jsonrpc_response(msg_id, result={
            "task_id": task_id,
            "status": "received",
        }))

        # Try to resolve pending future by any known ID key
        for id_key in ("confirmation_id", "select_id", "upload_id", "form_id"):
            component_id = response_data.get(id_key, "")
            if component_id:
                future = self._pending_confirmations.pop(component_id, None)
                if future and not future.done():
                    future.set_result(response_data)
                    print(f"[ACP] Resolved UI component {id_key}={component_id}")
                    break

    async def _handle_rollback(self, ws, msg_id, params: dict):
        """Handle agent.rollback request."""
        session_id = params.get("session_id", "")
        message_id = params.get("message_id", "")

        removed = self.conv_mgr.rollback(session_id)
        print(f"[ACP] Rollback session={session_id} message={message_id} removed={removed}")

        await ws.send_json(jsonrpc_response(msg_id, result={
            "status": "ok",
            "message_id": message_id,
        }))

    async def _handle_get_card(self, ws, msg_id):
        """Handle agent.getCard request."""
        capabilities = ["chat", "streaming"]
        if self.config.interactive:
            capabilities.append("interactive_messages")
        if self._enable_mac_tools:
            capabilities.append("mac_tools")

        await ws.send_json(jsonrpc_response(msg_id, result={
            "agent_id": self.config.agent_id,
            "name": self.config.agent_name,
            "description": f"ACP LLM Agent ({self.config.provider}/{self.config.model})",
            "version": "1.0.0",
            "capabilities": capabilities,
            "supported_protocols": ["acp"],
        }))

    # ==================== Proactive hub.* requests ====================

    async def _send_hub_request(self, ws, method: str, params: dict = None, timeout: float = 10.0):
        """Send a JSON-RPC request to the APP and wait for the response.

        Returns the result dict on success, raises on error or timeout.
        """
        req_id = str(uuid.uuid4())
        req = jsonrpc_request(method, params, id=req_id)
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_hub_requests[req_id] = future
        try:
            await ws.send_json(req)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_hub_requests.pop(req_id, None)
            raise
        except Exception:
            self._pending_hub_requests.pop(req_id, None)
            raise

    async def _fetch_ui_components(self, ws) -> bool:
        """Fetch UI component templates from the APP via hub.getUIComponentTemplates.

        Updates _cached_component_version, _cached_directive_prompt,
        _cached_known_types, _cached_component_method_map, and the
        _cached_ui_openai_tools / _cached_ui_claude_tools tool schemas.
        Returns True on success, False on failure.
        """
        try:
            result = await self._send_hub_request(ws, "hub.getUIComponentTemplates")
            if not result or not isinstance(result, dict):
                print("[ACP] hub.getUIComponentTemplates returned empty/invalid result")
                return False

            version = result.get("version")
            prompt_templates = result.get("prompt_templates", {})
            directive_prompt = prompt_templates.get("acp_directive_prompt")
            components = result.get("components", [])

            if not directive_prompt:
                print("[ACP] hub.getUIComponentTemplates: no acp_directive_prompt in response")
                return False

            known_types = set()
            component_method_map: Dict[str, str] = {}
            for comp in components:
                name = comp.get("name")
                if name:
                    known_types.add(name)
                    method = comp.get("acp_notification_method")
                    if method:
                        component_method_map[name] = method

            self._cached_component_version = version
            self._cached_directive_prompt = directive_prompt
            self._cached_known_types = known_types
            self._cached_component_method_map = component_method_map

            # Cache tool schemas for tool-calling mode (mac_tools)
            schemas = result.get("schemas", {})
            self._cached_ui_openai_tools = schemas.get("openai_tools")
            self._cached_ui_claude_tools = schemas.get("claude_tools")
            if self._cached_ui_openai_tools:
                print(f"[ACP] Cached {len(self._cached_ui_openai_tools)} UI OpenAI tool schemas")
            if self._cached_ui_claude_tools:
                print(f"[ACP] Cached {len(self._cached_ui_claude_tools)} UI Claude tool schemas")

            print(f"[ACP] Cached UI components version={version}, types={known_types}")
            return True

        except asyncio.TimeoutError:
            print("[ACP] hub.getUIComponentTemplates timed out")
            return False
        except Exception as e:
            print(f"[ACP] hub.getUIComponentTemplates failed: {e}")
            return False

    def _get_ui_component_tools(self, is_claude: bool) -> List[dict]:
        """Return cached UI component tool schemas for the given provider format.

        Returns an empty list if no schemas are cached.
        """
        if is_claude:
            return list(self._cached_ui_claude_tools) if self._cached_ui_claude_tools else []
        return list(self._cached_ui_openai_tools) if self._cached_ui_openai_tools else []

    async def request_sessions(self, ws) -> Optional[dict]:
        """Send hub.getSessions request to the App."""
        req = jsonrpc_request("hub.getSessions", id=str(uuid.uuid4()))
        await ws.send_json(req)
        # Note: response handling would need async tracking; simplified here
        return None

    async def request_session_messages(self, ws, session_id: str, limit: int = 50) -> Optional[dict]:
        """Send hub.getSessionMessages request to the App."""
        req = jsonrpc_request("hub.getSessionMessages", {
            "session_id": session_id,
            "limit": limit,
        }, id=str(uuid.uuid4()))
        await ws.send_json(req)
        return None


# ==================== Session Cleanup ====================

async def periodic_cleanup(app: web.Application):
    """Periodically clean up expired sessions and served files."""
    from mac_tools import cleanup_expired_files

    conv_mgr: ConversationManager = app["conv_mgr"]
    while True:
        await asyncio.sleep(600)
        conv_mgr.cleanup_expired(max_age_seconds=259200)
        removed = cleanup_expired_files()
        if removed:
            print(f"[Cleanup] Removed {removed} expired served files")


async def start_background_tasks(app: web.Application):
    app["cleanup_task"] = asyncio.create_task(periodic_cleanup(app))


async def cleanup_background_tasks(app: web.Application):
    app["cleanup_task"].cancel()
    try:
        await app["cleanup_task"]
    except asyncio.CancelledError:
        pass


# ==================== HTTP File Serving ====================

async def handle_file_serve(request: web.Request) -> web.StreamResponse:
    """Serve a file registered by the send_file tool."""
    from mac_tools import get_served_file

    file_id = request.match_info.get("file_id", "")
    entry = get_served_file(file_id)
    if entry is None:
        return web.Response(status=404, text="File not found or expired")

    file_path = entry["path"]
    if not os.path.exists(file_path):
        return web.Response(status=404, text="File no longer exists on disk")

    return web.FileResponse(
        file_path,
        headers={
            "Content-Type": entry["mime_type"],
            "Content-Disposition": f'inline; filename="{entry["filename"]}"',
        },
    )


# ==================== App Factory ====================

def create_app(config: AgentConfig, provider: LLMProvider,
               enable_mac_tools: bool = False, max_tool_rounds: int = 10) -> web.Application:
    """Create the web application with ACP WebSocket routes."""
    app = web.Application()
    conv_mgr = ConversationManager(max_history=config.max_history)

    app["config"] = config
    app["provider"] = provider
    app["conv_mgr"] = conv_mgr

    # Create ACP agent server
    acp_server = ACPAgentServer(config, provider, conv_mgr,
                                enable_mac_tools=enable_mac_tools,
                                max_tool_rounds=max_tool_rounds)

    # ACP WebSocket route (health check is handled via ping inside WebSocket)
    app.router.add_get("/acp/ws", acp_server.handle_websocket)

    # HTTP file serving route for send_file tool
    app.router.add_get("/files/{file_id}", handle_file_serve)

    # Background tasks
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)

    return app


# ==================== CLI ====================

def parse_args():
    parser = argparse.ArgumentParser(
        description="ACP Agent Server - WebSocket bidirectional JSON-RPC protocol",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # OpenAI GPT-4o
  python acp_agent.py --provider openai --model gpt-4o --api-key sk-xxx

  # DeepSeek
  python acp_agent.py --provider openai --model deepseek-chat \\
      --api-base https://api.deepseek.com/v1 --api-key sk-xxx

  # Claude
  python acp_agent.py --provider claude --model claude-sonnet-4-20250514 --api-key sk-ant-xxx

  # GLM-4.7
  python acp_agent.py --provider glm --model glm-4.7 --api-key xxx.xxx
        """,
    )

    parser.add_argument("--provider", default="openai", choices=["openai", "claude", "glm"])
    parser.add_argument("--model", default="gpt-4o")
    parser.add_argument("--api-base", default="")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--system-prompt", default="You are a helpful AI assistant.")
    parser.add_argument("--port", type=int, default=int(os.getenv("AGENT_PORT", "8080")))
    parser.add_argument("--token", default=os.getenv("AGENT_TOKEN", ""))
    parser.add_argument("--name", default=os.getenv("AGENT_NAME", "ACP LLM Agent"))
    parser.add_argument("--agent-id", default=os.getenv("AGENT_ID", f"acp_agent_{uuid.uuid4().hex[:8]}"))
    parser.add_argument("--max-history", type=int, default=20)
    parser.add_argument("--no-interactive", action="store_true", default=False)
    parser.add_argument("--enable-mac-tools", action="store_true", default=True,
                        help="Enable Mac operation tools (shell, file, app, etc.)")
    parser.add_argument("--max-tool-rounds", type=int, default=10,
                        help="Maximum tool calling rounds per request (default: 10)")
    parser.add_argument("--model-routing", type=str, default="",
                        help='JSON string for per-modality model overrides, e.g. \'{"image":{"model":"gpt-4o"},"audio":{"model":"gpt-4o-audio-preview"}}\'')

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
            print("Continuing anyway (will fail on first request)...\n")

    interactive = not args.no_interactive
    system_prompt = args.system_prompt

    # Parse model routing
    model_routing = {}
    if args.model_routing:
        try:
            model_routing = json.loads(args.model_routing)
            if not isinstance(model_routing, dict):
                print(f"Warning: --model-routing must be a JSON object, ignoring.")
                model_routing = {}
        except json.JSONDecodeError as e:
            print(f"Warning: Invalid JSON in --model-routing: {e}, ignoring.")

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
        model_routing=model_routing,
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
    print("  ACP Agent Server (WebSocket)")
    print("=" * 60)
    print(f"  Agent ID:    {config.agent_id}")
    print(f"  Agent Name:  {config.agent_name}")
    print(f"  Provider:    {config.provider}")
    print(f"  Model:       {config.model}")
    print(f"  API Base:    {api_base}")
    print(f"  API Key:     {'***' + api_key[-4:] if len(api_key) > 4 else '(not set)'}")
    print(f"  Port:        {config.port}")
    print(f"  Auth:        {'Token required' if config.token else 'No auth'}")
    print(f"  History:     {config.max_history} turns per session")
    print(f"  Interactive: {'Enabled' if config.interactive else 'Disabled'}")
    print(f"  Mac Tools:   {'Enabled' if args.enable_mac_tools else 'Disabled'}")
    if args.enable_mac_tools:
        print(f"  Tool Rounds: {args.max_tool_rounds} max")
    print("-" * 60)
    print(f"  ACP WS:      ws://localhost:{config.port}/acp/ws")
    if config.token:
        print("-" * 60)
        print(f"  Token:       {config.token}")
    print("=" * 60)
    print(f"\nServer starting on port {config.port}... Press Ctrl+C to stop.\n")

    app = create_app(config, provider,
                     enable_mac_tools=args.enable_mac_tools,
                     max_tool_rounds=args.max_tool_rounds)
    web.run_app(app, host="0.0.0.0", port=config.port, print=None)


if __name__ == "__main__":
    main()
