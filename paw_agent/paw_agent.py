#!/usr/bin/env python3
"""
PAW Agent — Multi-platform local OS control agent.

Uses paw_acp_sdk for all WebSocket/JSON-RPC communication.
Supports macOS, Linux, and Windows via platform-specific tool adapters.

Usage:
    python paw_agent.py --provider openai --model gpt-4o --api-key $OPENAI_API_KEY
    python paw_agent.py --provider claude --model claude-sonnet-4-20250514 --api-key $ANTHROPIC_API_KEY
    python paw_agent.py --provider glm --model glm-4.7 --api-key $GLM_API_KEY --token mytoken
"""

import asyncio
import json
import math
import os
import sys
import uuid
import argparse
from typing import Any, Dict, List, Optional

from aiohttp import web

# ── SDK imports ──────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "paw_acp_sdk"))

from paw_acp_sdk import (
    ACPAgentServer,
    TaskContext,
    ACPDirectiveStreamParser,
    ACPTextChunk,
    ACPDirective,
    acp_directive_to_notification,
    OpenAIProvider,
    ClaudeProvider,
    GLMProvider,
    LLMProvider,
    LLMToolCall,
    LLMStreamResult,
    jsonrpc_response,
    jsonrpc_notification,
)

# ── Tool imports ──────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))

from tools import (
    ALL_TOOL_DEFINITIONS,
    ALL_TOOL_DEFINITIONS_CLAUDE,
    RiskLevel,
    classify_risk,
    get_risk_description,
    run_tool,
    exec_send_file,
    get_served_file,
    cleanup_expired_files,
)


# ==================== HTTP File Serving ====================

async def handle_file_serve(request: web.Request) -> web.StreamResponse:
    """Serve a file registered by the send_file tool over HTTP."""
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


# ==================== PawAgent ====================

class PawAgent(ACPAgentServer):
    """Multi-platform local OS control agent.

    Extends :class:`ACPAgentServer` with:
    - Tool-calling loop (OS tools + optional UI components)
    - Model routing per attachment modality (image / audio / video / text)
    - UI component fetching from hub
    - File transfer via HTTP + binary WebSocket frames
    - Interactive confirmation for high-risk operations
    """

    def __init__(
        self,
        provider: LLMProvider,
        name: str = "PAW Agent",
        token: str = "",
        agent_id: Optional[str] = None,
        system_prompt: str = "You are a helpful AI assistant.",
        max_history: int = 20,
        enable_os_tools: bool = True,
        max_tool_rounds: int = 10,
        interactive: bool = True,
        model_routing: Optional[Dict] = None,
        # provider config kept for model routing fallback
        provider_type: str = "openai",
        model: str = "",
        api_base: str = "",
        api_key: str = "",
    ):
        super().__init__(
            name=name,
            token=token,
            agent_id=agent_id or f"paw_agent_{uuid.uuid4().hex[:8]}",
            system_prompt=system_prompt,
            max_history=max_history,
        )
        self.provider = provider
        self._enable_os_tools = enable_os_tools
        self._max_tool_rounds = max_tool_rounds
        self._interactive = interactive
        self._model_routing = model_routing or {}
        self._provider_type = provider_type
        self._model = model
        self._api_base = api_base
        self._api_key = api_key

        # UI component cache
        self._cached_component_version: Optional[str] = None
        self._cached_directive_prompt: Optional[str] = None
        self._cached_known_types: Optional[set] = None
        self._cached_component_method_map: Optional[Dict[str, str]] = None
        self._cached_ui_openai_tools: Optional[List[dict]] = None
        self._cached_ui_claude_tools: Optional[List[dict]] = None
        
        # Pre-fetch tracking: after first successful fetch, subsequent chats are fast
        self._ui_prefetch_attempted = False

    # ── SDK hooks ────────────────────────────────────────────────────────────

    def get_extra_routes(self) -> list:
        return [("GET", "/files/{file_id}", handle_file_serve)]

    async def on_request_file_data(self, ws, msg_id: Any, params: dict) -> None:
        """Handle agent.requestFileData — send file via binary WebSocket frames."""
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

        chunk_size = 65536  # 64 KB
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
            await ws.send_json(jsonrpc_response(msg_id, result=metadata))
            await ws.send_json(jsonrpc_notification("file.transferStart", metadata))

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

            await ws.send_json(jsonrpc_notification("file.transferComplete", {
                "file_id": file_id,
                "total_bytes": total_sent,
            }))
            print(f"  [FileTransfer] Sent {entry['filename']} ({total_sent} bytes) via {chunk_count} frames")

        except Exception as e:
            print(f"  [FileTransfer] Error sending {file_id}: {e}")
            try:
                await ws.send_json(jsonrpc_notification("file.transferError", {
                    "file_id": file_id,
                    "error": str(e),
                }))
            except Exception:
                pass

    # ── Main on_chat entry point ─────────────────────────────────────────────

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        attachments = kwargs.get("attachments")
        ui_component_version = kwargs.get("ui_component_version")
        system_prompt_override = kwargs.get("system_prompt") if kwargs.get("system_prompt") != self.system_prompt else None
        messages = list(kwargs.get("messages", []))

        # Build multimodal messages if images present
        if attachments and isinstance(attachments, list):
            messages = self._build_multimodal_messages(messages, attachments)

        resolved_provider = self._resolve_provider(attachments)

        system_prompt = await self._build_system_prompt(ctx, ui_component_version, system_prompt_override)

        if self._enable_os_tools:
            await self._stream_with_tools(ctx, messages, system_prompt, resolved_provider)
        else:
            await self._stream_plain(ctx, messages, system_prompt, resolved_provider)

        # Save reply to history (done inside each stream method)

    # ── Plain streaming (no tools) ───────────────────────────────────────────

    async def _stream_plain(self, ctx: TaskContext, messages: list, system_prompt: str, provider: LLMProvider):
        """Stream LLM response without tool calling."""
        full_reply = ""
        use_parser = self._interactive
        parser = ACPDirectiveStreamParser(known_types=self._cached_known_types) if use_parser else None
        component_method_map = self._cached_component_method_map

        async for chunk in provider.stream_chat(messages, system_prompt):
            full_reply += chunk

            if parser:
                for evt in parser.feed(chunk):
                    if isinstance(evt, ACPTextChunk) and evt.content:
                        await ctx.send_text(evt.content)
                    elif isinstance(evt, ACPDirective):
                        notification = acp_directive_to_notification(evt, ctx.task_id, component_method_map)
                        await ctx.ws.send_json(notification)
            else:
                await ctx.send_text(chunk)

        if parser:
            for evt in parser.flush():
                if isinstance(evt, ACPTextChunk) and evt.content:
                    await ctx.send_text(evt.content)
                elif isinstance(evt, ACPDirective):
                    notification = acp_directive_to_notification(evt, ctx.task_id, component_method_map)
                    await ctx.ws.send_json(notification)

        if full_reply:
            self.save_reply_to_history(ctx.session_id, full_reply)

    # ── Tool-calling streaming loop ──────────────────────────────────────────

    async def _stream_with_tools(self, ctx: TaskContext, messages: list, system_prompt: str, provider: LLMProvider):
        """Multi-round tool-calling loop."""
        full_text_reply = ""

        is_claude = isinstance(provider, ClaudeProvider)
        tools = ALL_TOOL_DEFINITIONS_CLAUDE if is_claude else ALL_TOOL_DEFINITIONS

        # Build OS tools system prompt addendum
        platform_name = {"darwin": "macOS", "linux": "Linux", "win32": "Windows"}.get(sys.platform, sys.platform)
        os_tools_prompt = (
            f"\n\n## Local OS Tools ({platform_name})\n\n"
            f"You are an AI agent running directly on the user's {platform_name} machine. "
            "You have FULL ACCESS to the local system through function-calling tools. "
            "These tools allow you to run shell commands, read/write files, manage processes, "
            "take screenshots, access the clipboard, query system info, and more.\n\n"
            "**CRITICAL: You CAN and MUST directly operate the system. You are NOT a cloud-based "
            "assistant without computer access. NEVER say you cannot access the computer, run commands, "
            "or check system info. Instead, USE the provided tools.**\n\n"
            "**Important rules:**\n"
            "- When the user asks you to perform ANY operation on the local machine, call the appropriate tool.\n"
            "- Do NOT output tool invocations as text — call the actual function.\n"
            "- **File/Image Transfer**: Use `send_file` to share files or images. "
            "Do NOT use `file_read` for binary files — use `send_file` instead.\n"
            "- Before calling a tool, briefly explain what you are about to do.\n"
            "- After receiving tool results, summarize the output clearly.\n"
            "- Some operations require user confirmation before execution. "
            "The system handles the confirmation flow automatically.\n"
        )

        if self._cached_component_method_map:
            os_tools_prompt += (
                "\n\n## App UI Components\n\n"
                "You can also send interactive UI components to the user's app:\n"
                "- `action_confirmation`: Present action buttons\n"
                "- `single_select`: Single-choice list\n"
                "- `multi_select`: Multi-choice list\n"
                "- `file_upload`: Request file uploads\n"
                "- `form`: Structured form\n\n"
                "Use these UI tools for user confirmation and choices instead of platform dialogs.\n"
            )
            ui_tools = self._get_ui_component_tools(is_claude)
            if ui_tools:
                tools = list(tools) + ui_tools
                print(f"  Merged {len(ui_tools)} UI component tools into tool list")

        effective_system_prompt = system_prompt.rstrip() + os_tools_prompt

        loop_messages = list(messages)

        async def on_text_chunk(chunk: str):
            nonlocal full_text_reply
            full_text_reply += chunk
            await ctx.send_text(chunk)

        for round_num in range(self._max_tool_rounds):
            print(f"  [Tool Round {round_num + 1}/{self._max_tool_rounds}]")

            result: LLMStreamResult = await provider.stream_chat_with_tools(
                loop_messages, effective_system_prompt, tools, on_text_chunk
            )

            if not result.tool_calls:
                print(f"  No tool calls in round {round_num + 1}, finishing")
                break

            tool_results = []
            sent_ui_component = False

            for tc in result.tool_calls:
                # UI component tool call
                if tc.name in (self._cached_component_method_map or {}):
                    tool_result = await self._handle_ui_component_tool_call(ctx, tc)
                    tool_results.append((tc, tool_result))
                    sent_ui_component = True
                    continue

                # send_file: serve file and send ui.fileMessage
                if tc.name == "send_file":
                    tool_result = await self._handle_send_file_tool_call(ctx, tc)
                    tool_results.append((tc, tool_result))
                    continue

                risk = classify_risk(tc.name, tc.arguments)
                description = get_risk_description(risk, tc.name, tc.arguments)
                print(f"  Tool: {tc.name} | Risk: {risk.value} | {description[:80]}")

                if risk == RiskLevel.SAFE:
                    tool_result = await run_tool(tc.name, tc.arguments)

                elif risk == RiskLevel.LOW_RISK:
                    tool_result = await run_tool(tc.name, tc.arguments)
                    await ctx.send_text(f"\n> Executed: {description}\n")

                elif risk == RiskLevel.HIGH_RISK:
                    tool_result = await self._request_confirmation_and_execute(ctx, tc, description)

                else:
                    tool_result = {"success": False, "error": "Unknown risk level"}

                tool_results.append((tc, tool_result))

            if sent_ui_component:
                print("  UI component sent, ending task")
                break

            if is_claude:
                loop_messages = self._append_tool_round_claude(loop_messages, result, tool_results)
            else:
                loop_messages = self._append_tool_round_openai(loop_messages, result, tool_results)

        if full_text_reply:
            self.save_reply_to_history(ctx.session_id, full_text_reply)

    # ── Confirmation flow ────────────────────────────────────────────────────

    async def _request_confirmation_and_execute(self, ctx: TaskContext, tool_call: LLMToolCall, description: str) -> dict:
        """Send confirmation UI and wait for user approval."""
        confirmation_id = f"paw_tool_{uuid.uuid4().hex[:8]}"

        await ctx.send_action_confirmation(
            prompt=f"Allow this operation?\n\n{description}",
            actions=[
                {"id": "approve", "label": "Approve", "style": "primary"},
                {"id": "reject", "label": "Reject", "style": "danger"},
            ],
            confirmation_id=confirmation_id,
            confirmation_context="paw_tool",
        )
        await ctx.send_text(f"\n⚠️ **Waiting for confirmation:** {description}\n")

        try:
            response_data = await ctx.wait_for_response(confirmation_id, timeout=300)
            selected_action = response_data.get("selected_action_id", "")

            if selected_action == "approve":
                print(f"  Confirmation {confirmation_id}: APPROVED")
                await ctx.send_text("\n✅ Approved. Executing...\n")
                return await run_tool(tool_call.name, tool_call.arguments)
            else:
                print(f"  Confirmation {confirmation_id}: REJECTED")
                await ctx.send_text("\n❌ Operation rejected by user.\n")
                return {"success": False, "error": "Operation rejected by user"}

        except asyncio.TimeoutError:
            print(f"  Confirmation {confirmation_id}: TIMED OUT")
            await ctx.send_text("\n⏰ Confirmation timed out.\n")
            return {"success": False, "error": "Confirmation timed out (300s)"}

    # ── UI component tool call handling ──────────────────────────────────────

    async def _handle_ui_component_tool_call(self, ctx: TaskContext, tool_call: LLMToolCall) -> dict:
        """Convert a UI component tool call into an ACP ui.* notification."""
        method = (self._cached_component_method_map or {}).get(tool_call.name)
        if not method:
            return {"success": False, "error": f"Unknown UI component: {tool_call.name}"}

        params = dict(tool_call.arguments) if tool_call.arguments else {}
        params["task_id"] = ctx.task_id

        if tool_call.name == "file_message":
            url = params.get("url", "")
            if url and not url.startswith(("http://", "https://")):
                send_result = await exec_send_file(
                    path=url,
                    filename=params.get("filename"),
                    mime_type=params.get("mime_type"),
                )
                if send_result.get("success"):
                    file_id = send_result["file_id"]
                    host = self._ws_host or f"localhost:{self._port}"
                    params["url"] = f"http://{host}/files/{file_id}"
                    if not params.get("size"):
                        params["size"] = send_result.get("size", 0)
                    if not params.get("filename"):
                        params["filename"] = send_result.get("filename", "file")
                    if not params.get("mime_type"):
                        params["mime_type"] = send_result.get("mime_type", "application/octet-stream")
            if not params.get("size"):
                local_url = params.get("url", "")
                if local_url and not local_url.startswith(("http://", "https://")):
                    try:
                        params["size"] = os.path.getsize(local_url)
                    except OSError:
                        params["size"] = 0

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
        await ctx.ws.send_json(jsonrpc_notification(method, params))

        return {
            "success": True,
            "message": (
                f"UI component '{tool_call.name}' has been sent to the user. "
                "The current task is now complete. The user's response will arrive as a new message."
            ),
        }

    # ── send_file tool call handling ─────────────────────────────────────────

    async def _handle_send_file_tool_call(self, ctx: TaskContext, tool_call: LLMToolCall) -> dict:
        """Execute send_file, serve it over HTTP, and notify the app."""
        args = tool_call.arguments or {}
        result = await exec_send_file(
            path=args.get("path", ""),
            filename=args.get("filename"),
            mime_type=args.get("mime_type"),
        )

        if not result.get("success"):
            return result

        file_id = result["file_id"]
        host = self._ws_host or f"localhost:{self._port}"
        file_url = f"http://{host}/files/{file_id}"
        result["url"] = file_url

        file_message_params: Dict[str, Any] = {
            "task_id": ctx.task_id,
            "url": file_url,
            "filename": result["filename"],
            "mime_type": result["mime_type"],
            "size": result["size"],
        }
        if result.get("thumbnail_base64"):
            file_message_params["thumbnail_base64"] = result["thumbnail_base64"]

        await ctx.send_file_message(
            url=file_url,
            filename=result["filename"],
            mime_type=result["mime_type"],
            size=result["size"],
            thumbnail_base64=result.get("thumbnail_base64"),
        )

        print(f"  send_file: {result['filename']} ({result['size']} bytes) -> {file_url}")

        return {
            "success": True,
            "message": f"File '{result['filename']}' has been sent to the user.",
            "url": file_url,
            "filename": result["filename"],
            "mime_type": result["mime_type"],
            "size": result["size"],
        }

    # ── System prompt building ────────────────────────────────────────────────

    async def _build_system_prompt(self, ctx: TaskContext, ui_component_version: Optional[str], override: Optional[str]) -> str:
        """Build effective system prompt, fetching UI component templates if needed.
        
        Non-blocking: if UI components not yet cached, continues without them.
        Fetching happens asynchronously in background after first attempt.
        """
        base = override if override else self.system_prompt

        if self._interactive:
            # Check if version changed - if so, we MUST fetch (blocking)
            if ui_component_version and ui_component_version != self._cached_component_version:
                print(f"  UI component version changed: {self._cached_component_version} -> {ui_component_version}")
                await self._fetch_ui_components(ctx, timeout=5.0)
            # First time: try to fetch non-blocking. If not ready, continue anyway.
            elif self._cached_directive_prompt is None and not self._ui_prefetch_attempted:
                print("  First chat: attempting to fetch UI components (non-blocking)...")
                try:
                    # Very short timeout for first fetch - don't block chat
                    await asyncio.wait_for(
                        self._fetch_ui_components(ctx, timeout=2.0),
                        timeout=3.0
                    )
                except asyncio.TimeoutError:
                    print("  UI component fetch timed out (non-blocking), continuing...")
                self._ui_prefetch_attempted = True

            # In tools mode, directive prompt is NOT appended (tools are used instead).
            # In plain mode, append it to teach the LLM directive syntax.
            if self._cached_directive_prompt and not self._enable_os_tools:
                base = base.rstrip() + "\n\n" + self._cached_directive_prompt

        return base

    async def _fetch_ui_components(self, ctx: TaskContext, timeout: float = 10.0) -> bool:
        """Fetch UI component templates from the app via hub.getUIComponentTemplates.
        
        Parameters:
            timeout: Maximum time to wait for hub response (default 10s).
                     Use lower values (2-3s) for non-blocking first attempts.
        """
        try:
            result = await ctx.hub_request("hub.getUIComponentTemplates", timeout=timeout)
            if not result or not isinstance(result, dict):
                print("[PAW] hub.getUIComponentTemplates returned empty/invalid result")
                return False

            version = result.get("version")
            prompt_templates = result.get("prompt_templates", {})
            directive_prompt = prompt_templates.get("acp_directive_prompt")
            components = result.get("components", [])

            if not directive_prompt:
                print("[PAW] hub.getUIComponentTemplates: no acp_directive_prompt in response")
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

            schemas = result.get("schemas", {})
            self._cached_ui_openai_tools = schemas.get("openai_tools")
            self._cached_ui_claude_tools = schemas.get("claude_tools")

            if self._cached_ui_openai_tools:
                print(f"[PAW] Cached {len(self._cached_ui_openai_tools)} UI OpenAI tool schemas")
            if self._cached_ui_claude_tools:
                print(f"[PAW] Cached {len(self._cached_ui_claude_tools)} UI Claude tool schemas")

            print(f"[PAW] Cached UI components version={version}, types={known_types}")
            return True

        except asyncio.TimeoutError:
            print("[PAW] hub.getUIComponentTemplates timed out")
            return False
        except Exception as e:
            print(f"[PAW] hub.getUIComponentTemplates failed: {e}")
            return False

    def _get_ui_component_tools(self, is_claude: bool) -> List[dict]:
        if is_claude:
            return list(self._cached_ui_claude_tools) if self._cached_ui_claude_tools else []
        return list(self._cached_ui_openai_tools) if self._cached_ui_openai_tools else []

    # ── Model routing ────────────────────────────────────────────────────────

    def _detect_modality(self, attachments: Optional[list]) -> str:
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

    def _resolve_provider(self, attachments: Optional[list]) -> LLMProvider:
        if not self._model_routing:
            return self.provider

        modality = self._detect_modality(attachments)
        route = self._model_routing.get(modality)
        if not route or not isinstance(route, dict):
            return self.provider

        provider_type = route.get("provider") or self._provider_type
        model = route.get("model") or self._model
        api_base = route.get("api_base") or self._api_base
        api_key = route.get("api_key") or self._api_key

        if (provider_type == self._provider_type and model == self._model
                and api_base == self._api_base and api_key == self._api_key):
            return self.provider

        print(f"  Model routing: modality={modality} -> provider={provider_type}, model={model}")

        if provider_type == "claude":
            return ClaudeProvider(api_base, api_key, model)
        elif provider_type == "glm":
            return GLMProvider(api_base, api_key, model)
        else:
            return OpenAIProvider(api_base, api_key, model)

    # ── Multimodal message building ──────────────────────────────────────────

    def _build_multimodal_messages(self, messages: list, attachments: list) -> list:
        """Replace the last user message with a multimodal version if images present."""
        if not messages:
            return messages

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

    # ── Tool round helpers ───────────────────────────────────────────────────

    def _append_tool_round_openai(self, messages: list, result: LLMStreamResult,
                                   tool_results: list) -> list:
        assistant_msg: Dict[str, Any] = {
            "role": "assistant",
            "content": result.text_content or None,
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                    },
                }
                for tc, _ in tool_results
            ],
        }
        messages = list(messages)
        messages.append(assistant_msg)

        for tc, tr in tool_results:
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(tr, ensure_ascii=False),
            })

        return messages

    def _append_tool_round_claude(self, messages: list, result: LLMStreamResult,
                                   tool_results: list) -> list:
        content_blocks: List[Dict[str, Any]] = []
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

        result_blocks = [
            {
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": json.dumps(tr, ensure_ascii=False),
            }
            for tc, tr in tool_results
        ]
        messages.append({"role": "user", "content": result_blocks})

        return messages

    # ── Agent card ───────────────────────────────────────────────────────────

    def get_agent_card(self):
        from paw_acp_sdk import AgentCard
        platform_name = {"darwin": "macOS", "linux": "Linux", "win32": "Windows"}.get(sys.platform, sys.platform)
        capabilities = ["chat", "streaming"]
        if self._interactive:
            capabilities.append("interactive_messages")
        if self._enable_os_tools:
            capabilities.append(f"os_tools_{platform_name.lower()}")
        return AgentCard(
            agent_id=self.agent_id,
            name=self.name,
            description=f"PAW Agent — {platform_name} local OS control",
            capabilities=capabilities,
        )

    # ── run() override: also start file cleanup ───────────────────────────────

    def create_app(self):
        app = super().create_app()

        async def _start_file_cleanup(application):
            async def _cleanup_loop():
                while True:
                    await asyncio.sleep(600)
                    removed = cleanup_expired_files()
                    if removed:
                        print(f"[Cleanup] Removed {removed} expired served files")
            application["_file_cleanup_task"] = asyncio.create_task(_cleanup_loop())

        async def _stop_file_cleanup(application):
            task = application.get("_file_cleanup_task")
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        app.on_startup.append(_start_file_cleanup)
        app.on_cleanup.append(_stop_file_cleanup)
        return app


# ==================== CLI ====================

def _resolve_api_key(args) -> str:
    if args.api_key:
        return args.api_key
    for env_var in ("LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GLM_API_KEY"):
        val = os.getenv(env_var, "")
        if val:
            return val
    return ""


def _resolve_api_base(args) -> str:
    if args.api_base:
        return args.api_base
    defaults = {
        "openai": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
        "claude": os.getenv("ANTHROPIC_API_BASE", "https://api.anthropic.com"),
        "glm": os.getenv("GLM_API_BASE", "https://open.bigmodel.cn/api/paas/v4"),
    }
    return defaults.get(args.provider, "https://api.openai.com/v1")


def parse_args():
    parser = argparse.ArgumentParser(
        description="PAW Agent — Multi-platform local OS control agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python paw_agent.py --provider openai --model gpt-4o --api-key sk-xxx
  python paw_agent.py --provider claude --model claude-sonnet-4-20250514 --api-key sk-ant-xxx
  python paw_agent.py --provider glm --model glm-4.7 --api-key xxx.xxx --token mytoken
        """,
    )
    parser.add_argument("--provider", default="openai", choices=["openai", "claude", "glm"])
    parser.add_argument("--model", default="gpt-4o")
    parser.add_argument("--api-base", default="")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--system-prompt", default="You are a helpful AI assistant.")
    parser.add_argument("--port", type=int, default=int(os.getenv("AGENT_PORT", "8080")))
    parser.add_argument("--token", default=os.getenv("AGENT_TOKEN", ""))
    parser.add_argument("--name", default=os.getenv("AGENT_NAME", "PAW Agent"))
    parser.add_argument("--agent-id", default=os.getenv("AGENT_ID", ""))
    parser.add_argument("--max-history", type=int, default=20)
    parser.add_argument("--no-interactive", action="store_true", default=False)
    parser.add_argument("--no-os-tools", action="store_true", default=False,
                        help="Disable OS operation tools (plain LLM mode)")
    parser.add_argument("--max-tool-rounds", type=int, default=10,
                        help="Maximum tool calling rounds per request (default: 10)")
    parser.add_argument("--model-routing", type=str, default="",
                        help='JSON: per-modality model overrides e.g. \'{"image":{"model":"gpt-4o"}}\'')
    return parser.parse_args()


def main():
    args = parse_args()

    api_key = _resolve_api_key(args)
    api_base = _resolve_api_base(args)

    if args.provider in ("openai", "claude", "glm") and not api_key:
        is_local = any(h in api_base for h in ["localhost", "127.0.0.1", "0.0.0.0"])
        if not is_local:
            print(f"Warning: No API key provided for {args.provider}. Will fail on first request.\n")

    model_routing = {}
    if args.model_routing:
        try:
            model_routing = json.loads(args.model_routing)
            if not isinstance(model_routing, dict):
                print("Warning: --model-routing must be a JSON object, ignoring.")
                model_routing = {}
        except json.JSONDecodeError as e:
            print(f"Warning: Invalid JSON in --model-routing: {e}, ignoring.")

    if args.provider == "claude":
        provider = ClaudeProvider(api_base, api_key, args.model)
    elif args.provider == "glm":
        provider = GLMProvider(api_base, api_key, args.model)
    else:
        provider = OpenAIProvider(api_base, api_key, args.model)

    platform_name = {"darwin": "macOS", "linux": "Linux", "win32": "Windows"}.get(sys.platform, sys.platform)

    agent = PawAgent(
        provider=provider,
        name=args.name,
        token=args.token,
        agent_id=args.agent_id or None,
        system_prompt=args.system_prompt,
        max_history=args.max_history,
        enable_os_tools=not args.no_os_tools,
        max_tool_rounds=args.max_tool_rounds,
        interactive=not args.no_interactive,
        model_routing=model_routing,
        provider_type=args.provider,
        model=args.model,
        api_base=api_base,
        api_key=api_key,
    )

    print("=" * 60)
    print(f"  {args.name} (PAW Agent)")
    print("=" * 60)
    print(f"  Agent ID:    {agent.agent_id}")
    print(f"  Platform:    {platform_name}")
    print(f"  Provider:    {args.provider}")
    print(f"  Model:       {args.model}")
    print(f"  API Base:    {api_base}")
    print(f"  API Key:     {'***' + api_key[-4:] if len(api_key) > 4 else '(not set)'}")
    print(f"  Port:        {args.port}")
    print(f"  Auth:        {'Token required' if args.token else 'No auth'}")
    print(f"  History:     {args.max_history} turns per session")
    print(f"  Interactive: {'Enabled' if not args.no_interactive else 'Disabled'}")
    print(f"  OS Tools:    {'Enabled' if not args.no_os_tools else 'Disabled'}")
    if not args.no_os_tools:
        print(f"  Tool Rounds: {args.max_tool_rounds} max")
        print(f"  Tools:       {len(ALL_TOOL_DEFINITIONS)} ({platform_name} + base)")
    print("-" * 60)
    print(f"  ACP WS:      ws://localhost:{args.port}/acp/ws")
    print(f"  Files:       http://localhost:{args.port}/files/{{file_id}}")
    if args.token:
        print(f"  Token:       {args.token}")
    print("=" * 60)
    print(f"\nServer starting on port {args.port}... Press Ctrl+C to stop.\n")

    agent.run(host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
