#!/usr/bin/env python3
"""
Claude Code ACP Agent - Bridge Claude Code to mobile via ACP WebSocket protocol.

Uses claude-agent-sdk (Python SDK) to expose Claude Code's full engineering
capabilities (file editing, bash execution, code search, etc.) over ACP
(WebSocket JSON-RPC 2.0) so the Flutter app can remotely control Claude Code.

Architecture:
    Flutter App <--WebSocket ACP--> claude_code_agent.py <--SDK--> Claude Code

Usage:
    python claude_code_agent.py --cwd /path/to/project --port 8090

    # With authentication:
    python claude_code_agent.py --cwd . --port 8090 --token my-secret

    # Specify model and permission mode:
    python claude_code_agent.py --cwd . --port 8090 \\
        --model claude-sonnet-4-20250514 --permission-mode acceptEdits
"""

import asyncio
import json
import uuid
import argparse
import os
import sys
from datetime import datetime
from dataclasses import dataclass, field
from typing import AsyncIterator, Dict, List, Optional

try:
    from aiohttp import web
    import aiohttp
except ImportError:
    print("Error: aiohttp is required. Install it with: pip install aiohttp")
    sys.exit(1)

# Reuse ACP infrastructure from acp_agent.py
# Use importlib to load acp_agent without triggering its llm_agent dependency
def _import_acp_agent():
    """Import acp_agent.py, mocking its llm_agent dependency if needed."""
    import importlib
    import types

    # If llm_agent doesn't exist, create a stub so acp_agent can import
    if "llm_agent" not in sys.modules:
        try:
            import llm_agent  # noqa: F401
        except (ImportError, ModuleNotFoundError):
            stub = types.ModuleType("llm_agent")
            # Add stub classes/functions that acp_agent imports
            stub.AgentConfig = type("AgentConfig", (), {})
            stub.ConversationManager = type("ConversationManager", (), {})
            stub.LLMProvider = type("LLMProvider", (), {})
            stub.OpenAIProvider = type("OpenAIProvider", (), {})
            stub.ClaudeProvider = type("ClaudeProvider", (), {})
            stub.GLMProvider = type("GLMProvider", (), {})
            stub.verify_token = lambda *a, **k: None
            stub.resolve_api_key = lambda *a, **k: ""
            stub.resolve_api_base = lambda *a, **k: ""
            sys.modules["llm_agent"] = stub

    # Ensure demo directory is in path
    demo_dir = os.path.dirname(os.path.abspath(__file__))
    if demo_dir not in sys.path:
        sys.path.insert(0, demo_dir)

    import acp_agent
    return acp_agent

_acp = _import_acp_agent()
jsonrpc_response = _acp.jsonrpc_response
jsonrpc_notification = _acp.jsonrpc_notification
jsonrpc_request = _acp.jsonrpc_request
ACPDirectiveStreamParser = _acp.ACPDirectiveStreamParser
ACPTextChunk = _acp.ACPTextChunk
ACPDirective = _acp.ACPDirective
acp_directive_to_notification = _acp.acp_directive_to_notification
ACP_INTERACTIVE_SYSTEM_PROMPT = _acp.ACP_INTERACTIVE_SYSTEM_PROMPT
del _acp


# ==================== Configuration ====================

@dataclass
class ClaudeCodeConfig:
    """Configuration for the Claude Code ACP Agent."""
    cwd: str = "."
    permission_mode: str = "acceptEdits"  # default, acceptEdits, plan, bypassPermissions
    max_turns: Optional[int] = None
    allowed_tools: List[str] = field(default_factory=list)
    model: Optional[str] = None
    port: int = 8090
    token: str = ""
    agent_id: str = ""
    agent_name: str = "Claude Code Agent"
    system_prompt: str = ""
    interactive: bool = True
    max_history: int = 50


# ==================== SDK Backend ====================

class ClaudeCodeSDKBackend:
    """Backend using claude-agent-sdk's query() async iterator."""

    def __init__(self, config: ClaudeCodeConfig):
        self.config = config
        self._sessions: Dict[str, str] = {}  # session_id -> sdk session_id

    @property
    def name(self) -> str:
        return "SDK"

    async def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
    ) -> AsyncIterator[dict]:
        """Stream Claude Code response as event dicts.

        Yields dicts with keys:
            - {"type": "text", "content": str}
            - {"type": "tool_use", "name": str, "input": dict, "id": str}
            - {"type": "tool_result", "tool_use_id": str, "content": str, "is_error": bool}
            - {"type": "result", "subtype": str, "cost": float, "turns": int, "session_id": str}
        """
        from claude_agent_sdk import (
            query,
            ClaudeAgentOptions,
            AssistantMessage,
            SystemMessage,
            ResultMessage,
            TextBlock,
            ToolUseBlock,
            ToolResultBlock,
        )

        options_kwargs = {
            "cwd": self.config.cwd,
            "permission_mode": self.config.permission_mode,
        }

        if self.config.model:
            options_kwargs["model"] = self.config.model

        if self.config.max_turns:
            options_kwargs["max_turns"] = self.config.max_turns

        if self.config.allowed_tools:
            options_kwargs["allowed_tools"] = self.config.allowed_tools

        if system_prompt:
            options_kwargs["system_prompt"] = system_prompt

        # Resume previous session if available
        sdk_session_id = self._sessions.get(session_id)
        if sdk_session_id:
            options_kwargs["resume"] = sdk_session_id

        options = ClaudeAgentOptions(**options_kwargs)

        async for message in query(prompt=prompt, options=options):
            if isinstance(message, SystemMessage):
                if hasattr(message, "session_id"):
                    self._sessions[session_id] = message.session_id

            elif isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        yield {"type": "text", "content": block.text}
                    elif isinstance(block, ToolUseBlock):
                        yield {
                            "type": "tool_use",
                            "name": block.name,
                            "input": block.input,
                            "id": block.id,
                        }
                    elif isinstance(block, ToolResultBlock):
                        content = block.content
                        if isinstance(content, list):
                            # Extract text from content blocks
                            content = "\n".join(
                                c.get("text", str(c))
                                for c in content
                                if isinstance(c, dict)
                            ) or str(content)
                        yield {
                            "type": "tool_result",
                            "tool_use_id": block.tool_use_id,
                            "content": str(content) if content else "",
                            "is_error": block.is_error or False,
                        }

            elif isinstance(message, ResultMessage):
                if hasattr(message, "session_id") and message.session_id:
                    self._sessions[session_id] = message.session_id
                yield {
                    "type": "result",
                    "subtype": getattr(message, "subtype", "success"),
                    "cost": getattr(message, "total_cost_usd", None),
                    "turns": getattr(message, "num_turns", 0),
                    "duration_ms": getattr(message, "duration_ms", 0),
                    "session_id": getattr(message, "session_id", ""),
                    "result_text": getattr(message, "result", None),
                }


# ==================== CLI Backend (Fallback) ====================

class ClaudeCodeCLIBackend:
    """Fallback backend using Claude Code CLI subprocess."""

    def __init__(self, config: ClaudeCodeConfig):
        self.config = config
        self._sessions: Dict[str, str] = {}

    @property
    def name(self) -> str:
        return "CLI"

    async def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
    ) -> AsyncIterator[dict]:
        """Stream Claude Code CLI response by parsing stdout JSON stream."""
        cmd = ["claude", "-p", prompt, "--output-format", "stream-json"]

        if self.config.model:
            cmd.extend(["--model", self.config.model])

        if self.config.max_turns:
            cmd.extend(["--max-turns", str(self.config.max_turns)])

        if self.config.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.config.allowed_tools)])

        if system_prompt:
            cmd.extend(["--system-prompt", system_prompt])

        # Resume session
        sdk_session_id = self._sessions.get(session_id)
        if sdk_session_id:
            cmd.extend(["--resume", sdk_session_id])

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.config.cwd,
        )

        try:
            buffer = ""
            while True:
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                # Process complete JSON lines
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    event_type = event.get("type", "")

                    if event_type == "assistant":
                        # Assistant message with content blocks
                        for block in event.get("message", {}).get("content", []):
                            block_type = block.get("type", "")
                            if block_type == "text":
                                yield {"type": "text", "content": block.get("text", "")}
                            elif block_type == "tool_use":
                                yield {
                                    "type": "tool_use",
                                    "name": block.get("name", ""),
                                    "input": block.get("input", {}),
                                    "id": block.get("id", ""),
                                }
                            elif block_type == "tool_result":
                                yield {
                                    "type": "tool_result",
                                    "tool_use_id": block.get("tool_use_id", ""),
                                    "content": str(block.get("content", "")),
                                    "is_error": block.get("is_error", False),
                                }

                    elif event_type == "result":
                        sid = event.get("session_id", "")
                        if sid:
                            self._sessions[session_id] = sid
                        yield {
                            "type": "result",
                            "subtype": event.get("subtype", "success"),
                            "cost": event.get("total_cost_usd"),
                            "turns": event.get("num_turns", 0),
                            "duration_ms": event.get("duration_ms", 0),
                            "session_id": sid,
                            "result_text": event.get("result"),
                        }

            await process.wait()
        except Exception:
            process.kill()
            await process.wait()
            raise


# ==================== Provider (auto-detect backend) ====================

class ClaudeCodeProvider:
    """Auto-detects available backend: SDK first, then CLI fallback."""

    def __init__(self, config: ClaudeCodeConfig):
        self.config = config
        self.backend = self._detect_backend()

    def _detect_backend(self):
        # Try SDK first
        try:
            import claude_agent_sdk  # noqa: F401
            backend = ClaudeCodeSDKBackend(self.config)
            print(f"  Backend:   SDK (claude-agent-sdk)")
            return backend
        except ImportError:
            pass

        # Fallback to CLI
        import shutil
        if shutil.which("claude"):
            backend = ClaudeCodeCLIBackend(self.config)
            print(f"  Backend:   CLI (claude subprocess)")
            return backend

        raise RuntimeError(
            "Neither claude-agent-sdk nor claude CLI found.\n"
            "Install SDK: pip install claude-agent-sdk\n"
            "Or install CLI: npm install -g @anthropic-ai/claude-code"
        )

    @property
    def backend_name(self) -> str:
        return self.backend.name

    def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
    ) -> AsyncIterator[dict]:
        return self.backend.stream_response(prompt, session_id, system_prompt)


# ==================== ACP Server for Claude Code ====================

class ACPClaudeCodeServer:
    """ACP WebSocket server that bridges Claude Code to the Flutter app."""

    def __init__(self, config: ClaudeCodeConfig, provider: ClaudeCodeProvider):
        self.config = config
        self.provider = provider
        self._active_tasks: Dict[str, asyncio.Task] = {}

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        """Handle incoming WebSocket connection."""
        ws = web.WebSocketResponse()
        await ws.prepare(request)

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

                    if msg_id is not None and method is not None:
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
                        elif method == "agent.getCard":
                            await self._handle_get_card(ws, msg_id)
                        else:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32601, "message": f"Method not found: {method}"},
                            ))

                    elif msg_id is not None and method is None:
                        # Response to our request
                        pass

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    print(f"[ACP] WebSocket error: {ws.exception()}")

        except Exception as e:
            print(f"[ACP] Connection error: {e}")
        finally:
            for task_id, task in self._active_tasks.items():
                task.cancel()
            self._active_tasks.clear()
            print(f"[ACP] WebSocket connection closed")

        return ws

    def _handle_auth(self, msg_id, params: dict) -> tuple:
        """Handle auth.authenticate request."""
        token = params.get("token", "")

        if not self.config.token:
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

    async def _handle_chat(self, ws, msg_id, params: dict):
        """Handle agent.chat - stream Claude Code response via notifications."""
        task_id = params.get("task_id", str(uuid.uuid4()))
        session_id = params.get("session_id", task_id)
        message = params.get("message", "")
        system_prompt_override = params.get("system_prompt")

        if not message:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32602, "message": "Missing 'message' parameter"},
            ))
            return

        print(f"\n{'='*60}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Claude Code - Task {task_id}")
        print(f"  Session: {session_id}")
        print(f"  Input:   {message[:120]}{'...' if len(message) > 120 else ''}")
        print(f"{'='*60}")

        # Acknowledge the request
        await ws.send_json(jsonrpc_response(msg_id, result={
            "task_id": task_id,
            "status": "accepted",
        }))

        # Send task.started
        await ws.send_json(jsonrpc_notification("task.started", {
            "task_id": task_id,
            "started_at": datetime.now().isoformat(),
        }))

        async def _stream_task():
            text_buffer = ""
            parser = ACPDirectiveStreamParser() if self.config.interactive else None

            try:
                async for event in self.provider.stream_response(
                    prompt=message,
                    session_id=session_id,
                    system_prompt=system_prompt_override if system_prompt_override else self.config.system_prompt,
                ):
                    event_type = event.get("type", "")

                    if event_type == "text":
                        content = event.get("content", "")
                        text_buffer += content

                        if parser:
                            for evt in parser.feed(content):
                                if isinstance(evt, ACPTextChunk) and evt.content:
                                    await ws.send_json(jsonrpc_notification(
                                        "ui.textContent", {
                                            "task_id": task_id,
                                            "content": evt.content,
                                            "is_final": False,
                                        }
                                    ))
                                elif isinstance(evt, ACPDirective):
                                    notification = acp_directive_to_notification(evt, task_id)
                                    await ws.send_json(notification)
                        else:
                            await ws.send_json(jsonrpc_notification(
                                "ui.textContent", {
                                    "task_id": task_id,
                                    "content": content,
                                    "is_final": False,
                                }
                            ))

                    elif event_type == "tool_use":
                        # Send tool use as collapsible metadata block
                        tool_name = event.get("name", "unknown")
                        tool_input = event.get("input", {})

                        # Build a concise summary of tool input
                        input_summary = _summarize_tool_input(tool_name, tool_input)

                        await ws.send_json(jsonrpc_notification(
                            "ui.messageMetadata", {
                                "task_id": task_id,
                                "metadata": {
                                    "collapsible": True,
                                    "collapsible_title": f"Tool: {tool_name}",
                                    "auto_collapse": True,
                                },
                            }
                        ))
                        # Send the tool details as text
                        await ws.send_json(jsonrpc_notification(
                            "ui.textContent", {
                                "task_id": task_id,
                                "content": f"\n`{tool_name}`: {input_summary}\n",
                                "is_final": False,
                            }
                        ))

                    elif event_type == "tool_result":
                        tool_content = event.get("content", "")
                        is_error = event.get("is_error", False)
                        status = "Error" if is_error else "Done"

                        # Send compact result notification
                        if tool_content:
                            # Truncate long results for display
                            display = tool_content[:500]
                            if len(tool_content) > 500:
                                display += f"\n... ({len(tool_content)} chars total)"

                            await ws.send_json(jsonrpc_notification(
                                "ui.messageMetadata", {
                                    "task_id": task_id,
                                    "metadata": {
                                        "collapsible": True,
                                        "collapsible_title": f"Result ({status})",
                                        "auto_collapse": True,
                                    },
                                }
                            ))
                            await ws.send_json(jsonrpc_notification(
                                "ui.textContent", {
                                    "task_id": task_id,
                                    "content": f"\n```\n{display}\n```\n",
                                    "is_final": False,
                                }
                            ))

                    elif event_type == "result":
                        # Final result from Claude Code
                        cost = event.get("cost")
                        turns = event.get("turns", 0)
                        duration = event.get("duration_ms", 0)
                        result_text = event.get("result_text")

                        # Send result text if present and no text was streamed
                        if result_text and not text_buffer:
                            if parser:
                                for evt in parser.feed(result_text):
                                    if isinstance(evt, ACPTextChunk) and evt.content:
                                        await ws.send_json(jsonrpc_notification(
                                            "ui.textContent", {
                                                "task_id": task_id,
                                                "content": evt.content,
                                                "is_final": False,
                                            }
                                        ))
                                    elif isinstance(evt, ACPDirective):
                                        notification = acp_directive_to_notification(evt, task_id)
                                        await ws.send_json(notification)

                        # Log stats
                        stats = []
                        if turns:
                            stats.append(f"turns={turns}")
                        if cost is not None:
                            stats.append(f"cost=${cost:.4f}")
                        if duration:
                            stats.append(f"duration={duration}ms")
                        if stats:
                            print(f"  Stats:   {', '.join(stats)}")

                # Flush parser
                if parser:
                    for evt in parser.flush():
                        if isinstance(evt, ACPTextChunk) and evt.content:
                            await ws.send_json(jsonrpc_notification(
                                "ui.textContent", {
                                    "task_id": task_id,
                                    "content": evt.content,
                                    "is_final": False,
                                }
                            ))
                        elif isinstance(evt, ACPDirective):
                            notification = acp_directive_to_notification(evt, task_id)
                            await ws.send_json(notification)

                # Send final text marker
                await ws.send_json(jsonrpc_notification("ui.textContent", {
                    "task_id": task_id,
                    "content": "",
                    "is_final": True,
                }))

                # Send task.completed
                await ws.send_json(jsonrpc_notification("task.completed", {
                    "task_id": task_id,
                    "status": "success",
                    "completed_at": datetime.now().isoformat(),
                }))

                print(f"  Reply:   {text_buffer[:120]}{'...' if len(text_buffer) > 120 else ''}")
                print(f"  Length:  {len(text_buffer)} chars")

            except asyncio.CancelledError:
                print(f"  Task {task_id} cancelled")
                await ws.send_json(jsonrpc_notification("task.error", {
                    "task_id": task_id,
                    "message": "Task cancelled",
                    "code": -32008,
                }))
            except Exception as e:
                print(f"  Task {task_id} error: {e}")
                import traceback
                traceback.print_exc()
                await ws.send_json(jsonrpc_notification("task.error", {
                    "task_id": task_id,
                    "message": str(e),
                    "code": -32603,
                }))
            finally:
                self._active_tasks.pop(task_id, None)

        task = asyncio.create_task(_stream_task())
        self._active_tasks[task_id] = task

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

    async def _handle_get_card(self, ws, msg_id):
        """Handle agent.getCard request."""
        capabilities = ["chat", "streaming", "code_editing", "file_operations", "bash_execution"]
        if self.config.interactive:
            capabilities.append("interactive_messages")

        await ws.send_json(jsonrpc_response(msg_id, result={
            "agent_id": self.config.agent_id,
            "name": self.config.agent_name,
            "description": f"Claude Code Agent ({self.provider.backend_name}) - cwd: {self.config.cwd}",
            "version": "1.0.0",
            "capabilities": capabilities,
            "supported_protocols": ["acp"],
        }))


# ==================== Helpers ====================

def _summarize_tool_input(tool_name: str, tool_input: dict) -> str:
    """Create a concise summary of tool input for display."""
    if tool_name == "Read":
        return tool_input.get("file_path", "")
    elif tool_name == "Write":
        path = tool_input.get("file_path", "")
        content = tool_input.get("content", "")
        return f"{path} ({len(content)} chars)"
    elif tool_name == "Edit":
        path = tool_input.get("file_path", "")
        old = tool_input.get("old_string", "")
        return f"{path} (replacing {len(old)} chars)"
    elif tool_name == "Bash":
        cmd = tool_input.get("command", "")
        if len(cmd) > 100:
            cmd = cmd[:100] + "..."
        return cmd
    elif tool_name == "Glob":
        return tool_input.get("pattern", "")
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern", "")
        path = tool_input.get("path", "")
        return f"/{pattern}/ in {path}" if path else f"/{pattern}/"
    elif tool_name == "WebSearch":
        return tool_input.get("query", "")
    elif tool_name == "WebFetch":
        return tool_input.get("url", "")
    elif tool_name == "Task":
        return tool_input.get("description", "")
    else:
        # Generic: show first key-value pair
        for k, v in tool_input.items():
            v_str = str(v)
            if len(v_str) > 80:
                v_str = v_str[:80] + "..."
            return f"{k}={v_str}"
        return ""


# ==================== App Factory ====================

def create_app(config: ClaudeCodeConfig, provider: ClaudeCodeProvider) -> web.Application:
    """Create the web application with ACP WebSocket route."""
    app = web.Application()

    app["config"] = config
    app["provider"] = provider

    server = ACPClaudeCodeServer(config, provider)
    app.router.add_get("/acp/ws", server.handle_websocket)

    return app


# ==================== CLI ====================

def parse_args():
    parser = argparse.ArgumentParser(
        description="Claude Code ACP Agent - Bridge Claude Code to mobile via WebSocket",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic usage with current directory
  python claude_code_agent.py --cwd . --port 8090

  # With authentication and specific model
  python claude_code_agent.py --cwd /path/to/project \\
      --port 8090 --token my-secret --model claude-sonnet-4-20250514

  # With permission mode and tool restrictions
  python claude_code_agent.py --cwd . --port 8090 \\
      --permission-mode acceptEdits \\
      --allowed-tools Read,Glob,Grep,Edit,Bash

  # Limit max turns
  python claude_code_agent.py --cwd . --port 8090 --max-turns 20

Flutter app: Add ACP agent at ws://<IP>:8090/acp/ws
        """,
    )

    parser.add_argument(
        "--cwd", default=".",
        help="Working directory for Claude Code (default: current directory)",
    )
    parser.add_argument(
        "--port", type=int, default=int(os.getenv("AGENT_PORT", "8090")),
        help="Server port (default: 8090, or AGENT_PORT env var)",
    )
    parser.add_argument(
        "--token", default=os.getenv("AGENT_TOKEN", ""),
        help="Authentication token (default: AGENT_TOKEN env var)",
    )
    parser.add_argument(
        "--model", default=os.getenv("CLAUDE_MODEL", ""),
        help="Claude model to use (default: SDK/CLI default)",
    )
    parser.add_argument(
        "--permission-mode", default="acceptEdits",
        choices=["default", "acceptEdits", "plan", "bypassPermissions"],
        help="Permission mode for Claude Code (default: acceptEdits)",
    )
    parser.add_argument(
        "--max-turns", type=int, default=None,
        help="Maximum number of agentic turns (default: unlimited)",
    )
    parser.add_argument(
        "--allowed-tools", default="",
        help="Comma-separated list of allowed tools (default: all)",
    )
    parser.add_argument(
        "--name", default=os.getenv("AGENT_NAME", "Claude Code Agent"),
        help="Agent display name",
    )
    parser.add_argument(
        "--agent-id", default=os.getenv("AGENT_ID", ""),
        help="Agent ID (default: auto-generated)",
    )
    parser.add_argument(
        "--system-prompt", default="",
        help="Additional system prompt to prepend",
    )
    parser.add_argument(
        "--no-interactive", action="store_true", default=False,
        help="Disable interactive directive parsing",
    )

    return parser.parse_args()


def main():
    args = parse_args()

    # Resolve cwd to absolute path
    cwd = os.path.abspath(args.cwd)
    if not os.path.isdir(cwd):
        print(f"Error: --cwd directory does not exist: {cwd}")
        sys.exit(1)

    interactive = not args.no_interactive

    # Build system prompt
    system_prompt = args.system_prompt or ""
    if interactive:
        if system_prompt:
            system_prompt = system_prompt.rstrip() + "\n\n" + ACP_INTERACTIVE_SYSTEM_PROMPT
        else:
            system_prompt = ACP_INTERACTIVE_SYSTEM_PROMPT

    allowed_tools = [t.strip() for t in args.allowed_tools.split(",") if t.strip()] if args.allowed_tools else []

    config = ClaudeCodeConfig(
        cwd=cwd,
        permission_mode=args.permission_mode,
        max_turns=args.max_turns,
        allowed_tools=allowed_tools,
        model=args.model or None,
        port=args.port,
        token=args.token,
        agent_id=args.agent_id or f"claude_code_{uuid.uuid4().hex[:8]}",
        agent_name=args.name,
        system_prompt=system_prompt,
        interactive=interactive,
    )

    # Print startup info
    print("=" * 60)
    print("  Claude Code ACP Agent")
    print("=" * 60)
    print(f"  Agent ID:    {config.agent_id}")
    print(f"  Agent Name:  {config.agent_name}")
    print(f"  CWD:         {config.cwd}")
    print(f"  Model:       {config.model or '(default)'}")
    print(f"  Permission:  {config.permission_mode}")
    print(f"  Max Turns:   {config.max_turns or '(unlimited)'}")
    print(f"  Tools:       {', '.join(config.allowed_tools) if config.allowed_tools else '(all)'}")
    print(f"  Port:        {config.port}")
    print(f"  Auth:        {'Token required' if config.token else 'No auth'}")
    print(f"  Interactive: {'Enabled' if config.interactive else 'Disabled'}")

    # Detect and create provider (prints backend info)
    try:
        provider = ClaudeCodeProvider(config)
    except RuntimeError as e:
        print(f"\nError: {e}")
        sys.exit(1)

    print("-" * 60)
    print(f"  ACP WS:      ws://localhost:{config.port}/acp/ws")
    if config.token:
        print("-" * 60)
        print(f"  Token:       {config.token}")
    print("=" * 60)
    print(f"\nServer starting on port {config.port}... Press Ctrl+C to stop.\n")

    app = create_app(config, provider)
    web.run_app(app, host="0.0.0.0", port=config.port, print=None)


if __name__ == "__main__":
    main()
