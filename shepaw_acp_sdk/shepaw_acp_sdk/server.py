"""ACP Agent Server base class.

Subclass :class:`ACPAgentServer` and override :meth:`on_chat` to build
an agent.  Everything else (WebSocket routing, authentication, heartbeat,
task lifecycle, conversation history, hub request tracking) is handled
automatically.

Minimal example::

    from paw_acp_sdk import ACPAgentServer, TaskContext

    class EchoAgent(ACPAgentServer):
        async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
            await ctx.send_text(f"You said: {message}")

    agent = EchoAgent(name="Echo Agent", token="secret")
    agent.run(port=8080)
"""

import asyncio
import json
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp
from aiohttp import web

from .conversation import ConversationManager
from .jsonrpc import jsonrpc_notification, jsonrpc_request, jsonrpc_response
from .task_context import TaskContext
from .tunnel import ChannelTunnelConfig, TunnelClient
from .openclaw_channel import OpenClawChannel, OpenClawChannelConfig
from .types import AgentCard


# ── Conversation history cleanup ─────────────────────────────────────

_ACP_DIRECTIVE_BLOCK_RE = re.compile(
    r"<<<directive\s*\n(.*?)\n>>>",
    re.DOTALL,
)


def _clean_reply_for_history(full_reply: str) -> str:
    """Replace ``<<<directive ... >>>`` blocks with human-readable summaries."""

    def _summarise(m: re.Match) -> str:
        body = m.group(1).strip()
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            return m.group(0)

        dtype = payload.get("type", "unknown")
        parts: list[str] = []

        for key in ("prompt", "title", "reason"):
            val = payload.get(key)
            if val and isinstance(val, str):
                parts.append(val)
                break

        for key in ("actions", "options", "fields"):
            items = payload.get(key)
            if isinstance(items, list) and items:
                labels = [item.get("label", "?") for item in items if isinstance(item, dict)]
                if labels:
                    parts.append(", ".join(labels))
                break

        filename = payload.get("filename")
        if filename:
            parts.append(filename)

        detail = ": " + " | ".join(parts) if parts else ""
        return f"[Directive {dtype}{detail}]"

    return _ACP_DIRECTIVE_BLOCK_RE.sub(_summarise, full_reply)


# ── ACPAgentServer ───────────────────────────────────────────────────


class ACPAgentServer:
    """Base class for ACP agents.

    Subclass and implement :meth:`on_chat` to handle user messages.  The
    server manages the full WebSocket lifecycle automatically:

    * Authentication (``auth.authenticate``)
    * Heartbeat (``ping`` / ``pong``)
    * Chat dispatch (``agent.chat``)
    * Task cancel (``agent.cancelTask``)
    * Interactive response routing (``agent.submitResponse``)
    * Session rollback (``agent.rollback``)
    * Agent card (``agent.getCard``)
    * Hub request / response tracking
    * Conversation history management

    Parameters
    ----------
    name : str
        Human-readable agent name.
    token : str
        Authentication token (empty string = no auth required).
    agent_id : str or None
        Unique agent identifier. Auto-generated if not provided.
    description : str
        Agent description for the agent card.
    system_prompt : str
        Default system prompt (subclasses may override).
    max_history : int
        Maximum conversation turns to keep per session.
    clean_directives_in_history : bool
        If True, ``<<<directive>>>`` blocks in assistant replies are replaced
        with human-readable summaries before saving to history.
    """

    def __init__(
        self,
        name: str = "ACP Agent",
        token: str = "",
        agent_id: Optional[str] = None,
        description: str = "",
        system_prompt: str = "You are a helpful AI assistant.",
        max_history: int = 20,
        clean_directives_in_history: bool = True,
        tunnel_config: Optional[ChannelTunnelConfig] = None,
        openclaw_channel_config: Optional[OpenClawChannelConfig] = None,
    ):
        self.name = name
        self.token = token
        self.agent_id = agent_id or f"acp_agent_{uuid.uuid4().hex[:8]}"
        self.description = description or f"ACP Agent: {name}"
        self.system_prompt = system_prompt
        self.clean_directives_in_history = clean_directives_in_history
        self.tunnel_config = tunnel_config
        self.openclaw_channel_config = openclaw_channel_config

        self.conv_mgr = ConversationManager(max_history=max_history)

        # Per-connection state (reset on each WebSocket connection)
        self._active_tasks: Dict[str, asyncio.Task] = {}
        self._pending_hub_requests: Dict[str, asyncio.Future] = {}
        self._pending_responses: Dict[str, asyncio.Future] = {}

        # Host/port derived from the WebSocket connection (for building URLs)
        self._ws_host: Optional[str] = None
        self._port: int = 8080

        # Tunnel client (set when tunnel is active)
        self._tunnel_client: Optional[TunnelClient] = None

        # OpenClaw channel (set when openclaw_channel_config is provided)
        self._openclaw_channel: Optional[OpenClawChannel] = None
        if openclaw_channel_config is not None:
            self._openclaw_channel = OpenClawChannel(openclaw_channel_config)

    # ── Override point ───────────────────────────────────────────

    async def on_chat(self, ctx: TaskContext, message: str, **kwargs) -> None:
        """Handle an incoming chat message.

        Override this method with your agent logic.  Use *ctx* to send
        text, UI components, or query the hub.

        The base-class lifecycle is::

            ctx.started()        # automatic
            await self.on_chat(ctx, message, ...)
            ctx.send_text_final()  # automatic
            ctx.completed()      # automatic

        If ``on_chat`` raises, ``ctx.error(...)`` is sent instead.

        Parameters
        ----------
        ctx : TaskContext
            Per-task helper for sending messages.
        message : str
            The user's message text.
        **kwargs
            All other ``agent.chat`` params (``session_id``, ``history``,
            ``attachments``, ``system_prompt``, ``group_context``, etc.).
        """
        await ctx.send_text(f"Echo: {message}")

    # ── WebSocket handler ────────────────────────────────────────

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        """Handle an incoming WebSocket connection."""
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        # Capture host for building reachable file URLs
        host_header = request.headers.get("Host")
        if host_header:
            self._ws_host = host_header
        else:
            self._ws_host = f"localhost:{self._port}"

        print(f"[ACP] New WebSocket connection from {request.remote}")
        
        # Try to authenticate from HTTP Authorization header
        # (Shepaw sends Authorization: Bearer <token> instead of auth.authenticate message)
        authenticated = False
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]  # Strip "Bearer " prefix
            if self.token and token == self.token:
                print(f"[ACP] Pre-authenticated via Authorization header")
                authenticated = True
            elif not self.token:
                print(f"[ACP] No token required (server token is empty)")
                authenticated = True
            else:
                print(f"[ACP] Authorization header token mismatch")

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
                        # Request from App
                        if method == "auth.authenticate":
                            # Handle both: fresh auth or double-check from already-authenticated client
                            new_auth, response = self._handle_auth(msg_id, params)
                            if new_auth:
                                authenticated = True
                            await ws.send_json(response)
                        elif method == "ping":
                            await ws.send_json(jsonrpc_response(msg_id, result={"pong": True}))
                        elif not authenticated:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32000, "message": "Not authenticated"},
                            ))
                        elif method == "agent.chat":
                            await self._handle_chat_dispatch(ws, msg_id, params)
                        elif method == "agent.cancelTask":
                            await self._handle_cancel_task(ws, msg_id, params)
                        elif method == "agent.submitResponse":
                            await self._handle_submit_response(ws, msg_id, params)
                        elif method == "agent.rollback":
                            await self._handle_rollback(ws, msg_id, params)
                        elif method == "agent.getCard":
                            await self._handle_get_card(ws, msg_id)
                        elif method == "agent.requestFileData":
                            await self.on_request_file_data(ws, msg_id, params)
                        else:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32601, "message": f"Method not found: {method}"},
                            ))

                    elif msg_id is not None and method is None:
                        # Response to our request (hub.* responses)
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
            for task_id, task in self._active_tasks.items():
                task.cancel()
            self._active_tasks.clear()
            for req_id, future in self._pending_hub_requests.items():
                if not future.done():
                    future.cancel()
            self._pending_hub_requests.clear()
            for cid, future in self._pending_responses.items():
                if not future.done():
                    future.cancel()
            self._pending_responses.clear()
            print("[ACP] WebSocket connection closed")

        return ws

    # ── Auth ─────────────────────────────────────────────────────

    def _handle_auth(self, msg_id: Any, params: dict) -> tuple:
        token = params.get("token", "")
        if not self.token:
            return True, jsonrpc_response(msg_id, result={"status": "authenticated"})
        if token == self.token:
            print("[ACP] Authentication successful")
            return True, jsonrpc_response(msg_id, result={"status": "authenticated"})
        print("[ACP] Authentication failed")
        return False, jsonrpc_response(
            msg_id,
            error={"code": -32000, "message": "Authentication failed"},
        )

    # ── Chat dispatch ────────────────────────────────────────────

    async def _handle_chat_dispatch(self, ws: web.WebSocketResponse, msg_id: Any, params: dict):
        task_id = params.get("task_id", str(uuid.uuid4()))
        session_id = params.get("session_id", task_id)
        message = params.get("message", "")
        is_history_supplement = params.get("history_supplement", False)

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

        # Acknowledge
        await ws.send_json(jsonrpc_response(msg_id, result={
            "task_id": task_id,
            "status": "accepted",
        }))

        # Create TaskContext
        ctx = TaskContext(
            ws=ws,
            task_id=task_id,
            session_id=session_id,
            pending_hub_requests=self._pending_hub_requests,
            pending_responses=self._pending_responses,
        )

        # Spawn the chat task
        task = asyncio.create_task(
            self._run_chat_task(ctx, params)
        )
        self._active_tasks[task_id] = task

    async def _run_chat_task(self, ctx: TaskContext, params: dict):
        """Run the full chat lifecycle: started → on_chat → final → completed."""
        task_id = ctx.task_id
        session_id = ctx.session_id
        message = params.get("message", "")
        print(f"[ACP] _run_chat_task started: task_id={task_id}, msg_len={len(message)}")
        history = params.get("history")
        is_history_supplement = params.get("history_supplement", False)
        additional_history = params.get("additional_history")

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

        # Handle history supplement
        if is_history_supplement:
            if additional_history and isinstance(additional_history, list):
                valid_additional = [
                    {"role": m["role"], "content": m["content"]}
                    for m in additional_history
                    if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content")
                ]
                if valid_additional:
                    self.conv_mgr.prepend_history(session_id, valid_additional)
                    print(f"  Prepended {len(valid_additional)} older messages")

            msgs = self.conv_mgr.get_messages(session_id)
            if msgs and msgs[-1]["role"] == "assistant":
                msgs.pop()
        else:
            if message:
                self.conv_mgr.add_user_message(session_id, message)

        try:
            # task.started
            print(f"[ACP] Sending task.started for task_id={task_id}")
            await ctx.started()

            # Call the user's on_chat implementation
            print(f"[ACP] Calling on_chat for task_id={task_id}")
            await self.on_chat(
                ctx,
                message,
                session_id=session_id,
                history=history,
                messages=self.conv_mgr.get_messages(session_id),
                attachments=params.get("attachments"),
                system_prompt=params.get("system_prompt") or self.system_prompt,
                group_context=params.get("group_context"),
                ui_component_version=params.get("ui_component_version"),
                user_id=params.get("user_id", ""),
                message_id=params.get("message_id", ""),
                is_history_supplement=is_history_supplement,
                params=params,
            )

            # Send final text marker
            print(f"[ACP] Sending final text for task_id={task_id}")
            await ctx.send_text_final()

            # task.completed
            print(f"[ACP] Sending task.completed for task_id={task_id}")
            await ctx.completed()

            print(f"[ACP] Task {task_id} completed successfully")

        except asyncio.CancelledError:
            print(f"  Task {task_id} cancelled")
            await ctx.error("Task cancelled", code=-32008)
        except Exception as e:
            print(f"  Task {task_id} error: {e}")
            await ctx.error(str(e), code=-32603)
        finally:
            self._active_tasks.pop(task_id, None)

    # ── Cancel ───────────────────────────────────────────────────

    async def _handle_cancel_task(self, ws: web.WebSocketResponse, msg_id: Any, params: dict):
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

    # ── Submit response ──────────────────────────────────────────

    async def _handle_submit_response(self, ws: web.WebSocketResponse, msg_id: Any, params: dict):
        task_id = params.get("task_id", "")
        response_data = params.get("response_data", {})

        print(f"[ACP] Submit response: type={params.get('response_type', '')} task={task_id}")

        await ws.send_json(jsonrpc_response(msg_id, result={
            "task_id": task_id,
            "status": "received",
        }))

        for id_key in ("confirmation_id", "select_id", "upload_id", "form_id"):
            component_id = response_data.get(id_key, "")
            if component_id:
                future = self._pending_responses.pop(component_id, None)
                if future and not future.done():
                    future.set_result(response_data)
                    print(f"[ACP] Resolved UI component {id_key}={component_id}")
                    break

    # ── Rollback ─────────────────────────────────────────────────

    async def _handle_rollback(self, ws: web.WebSocketResponse, msg_id: Any, params: dict):
        session_id = params.get("session_id", "")
        message_id = params.get("message_id", "")

        removed = self.conv_mgr.rollback(session_id)
        print(f"[ACP] Rollback session={session_id} message={message_id} removed={removed}")

        await ws.send_json(jsonrpc_response(msg_id, result={
            "status": "ok",
            "message_id": message_id,
        }))

    # ── Agent card ───────────────────────────────────────────────

    async def _handle_get_card(self, ws: web.WebSocketResponse, msg_id: Any):
        card = self.get_agent_card()
        await ws.send_json(jsonrpc_response(msg_id, result={
            "agent_id": card.agent_id,
            "name": card.name,
            "description": card.description,
            "version": card.version,
            "capabilities": card.capabilities,
            "supported_protocols": card.supported_protocols,
        }))

    def get_agent_card(self) -> AgentCard:
        """Return the agent card. Override to customise."""
        return AgentCard(
            agent_id=self.agent_id,
            name=self.name,
            description=self.description,
        )

    # ── File transfer hook ────────────────────────────────────────

    async def on_request_file_data(self, ws: web.WebSocketResponse, msg_id: Any, params: dict) -> None:
        """Handle ``agent.requestFileData``.

        Override in subclasses to implement binary file transfer via WebSocket.
        The default implementation returns a "not supported" error.
        """
        await ws.send_json(jsonrpc_response(
            msg_id,
            error={"code": -32601, "message": "requestFileData not supported by this agent"},
        ))

    # ── Extra routes hook ─────────────────────────────────────────

    def get_extra_routes(self) -> list:
        """Return extra HTTP routes to register on the aiohttp application.

        Each item should be a ``(method, path, handler)`` tuple, e.g.::

            def get_extra_routes(self):
                return [("GET", "/files/{file_id}", self.handle_file_serve)]
        """
        return []

    # ── Convenience: save reply to history ───────────────────────

    def save_reply_to_history(self, session_id: str, reply: str) -> None:
        """Save an assistant reply to conversation history.

        If *clean_directives_in_history* is enabled, directive blocks are
        replaced with summaries first.
        """
        if not reply:
            return
        cleaned = _clean_reply_for_history(reply) if self.clean_directives_in_history else reply
        self.conv_mgr.add_assistant_message(session_id, cleaned)

    # ── App launcher ─────────────────────────────────────────────

    def run(self, host: str = "0.0.0.0", port: int = 8080) -> None:
        """Start the agent server (blocking).

        Creates an aiohttp :class:`web.Application` with the WebSocket
        route at ``/acp/ws`` and runs it.

        If *tunnel_config* was supplied (via the constructor or
        :meth:`run_with_tunnel`), a :class:`TunnelClient` is also started so
        the agent is reachable via the Channel Service.
        """
        self._port = port
        app = self.create_app()

        self._print_startup_banner(host, port)

        if self.tunnel_config:
            asyncio.run(self._run_async(app, host, port))
        else:
            web.run_app(app, host=host, port=port)

    def run_with_tunnel(
        self,
        tunnel_config: ChannelTunnelConfig,
        host: str = "0.0.0.0",
        port: int = 8080,
    ) -> None:
        """Start the agent server **and** the Channel Service tunnel.

        Convenience wrapper that sets *tunnel_config* and calls :meth:`run`.

        Parameters
        ----------
        tunnel_config:
            Tunnel configuration returned by or built from
            :class:`ChannelTunnelConfig`.
        host:
            Local bind address.
        port:
            Local port to listen on.
        """
        self.tunnel_config = tunnel_config
        self.run(host=host, port=port)

    def run_with_openclaw_channel(
        self,
        openclaw_channel_config: Optional[OpenClawChannelConfig] = None,
        host: str = "0.0.0.0",
        port: int = 8080,
    ) -> None:
        """Start the agent server with an OpenClaw Gateway channel.

        Convenience wrapper that sets *openclaw_channel_config* and calls
        :meth:`run`.  On startup the :class:`OpenClawChannel` is created and
        made accessible via :attr:`openclaw_channel`.

        The ``openclaw_channel_config`` can also be provided via environment
        variables (all optional):

        - ``OPENCLAW_GATEWAY_URL``  – Gateway WebSocket URL
          (default: ``ws://127.0.0.1:18789``)
        - ``OPENCLAW_GATEWAY_TOKEN``  – authentication token
        - ``OPENCLAW_SESSION_KEY``  – target session key

        If *openclaw_channel_config* is ``None``, these environment variables
        are used to build the configuration automatically.

        Parameters
        ----------
        openclaw_channel_config:
            :class:`OpenClawChannelConfig` with Gateway connection details.
            If ``None``, configuration is read from environment variables.
        host:
            Local bind address.
        port:
            Local port to listen on.

        Example::

            import os
            from paw_acp_sdk import ACPAgentServer, TaskContext
            from paw_acp_sdk.openclaw_channel import OpenClawChannelConfig

            class BridgeAgent(ACPAgentServer):
                async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
                    async for chunk in self.openclaw_channel.send_and_stream(message):
                        await ctx.send_text(chunk)

            config = OpenClawChannelConfig(
                gateway_url=os.getenv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789"),
                gateway_token=os.getenv("OPENCLAW_GATEWAY_TOKEN", ""),
                session_key=os.getenv("OPENCLAW_SESSION_KEY", ""),
            )
            BridgeAgent(name="OpenClaw Bridge").run_with_openclaw_channel(config, port=8080)
        """
        import os as _os

        if openclaw_channel_config is None:
            openclaw_channel_config = OpenClawChannelConfig(
                gateway_url=_os.getenv(
                    "OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789"
                ),
                gateway_token=_os.getenv("OPENCLAW_GATEWAY_TOKEN", ""),
                session_key=_os.getenv("OPENCLAW_SESSION_KEY", ""),
            )

        self.openclaw_channel_config = openclaw_channel_config
        self._openclaw_channel = OpenClawChannel(openclaw_channel_config)
        self.run(host=host, port=port)

    @property
    def openclaw_channel(self) -> Optional["OpenClawChannel"]:
        """The :class:`OpenClawChannel` instance, if one was configured.

        Use this inside :meth:`on_chat` to forward messages to OpenClaw::

            async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
                async for chunk in self.openclaw_channel.send_and_stream(message):
                    await ctx.send_text(chunk)
        """
        return self._openclaw_channel

    async def _run_async(self, app: web.Application, host: str, port: int) -> None:
        """Run the aiohttp app and tunnel client concurrently."""
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        await site.start()

        # Local address for the tunnel client
        local_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host

        assert self.tunnel_config is not None
        self._tunnel_client = TunnelClient(
            config=self.tunnel_config,
            local_host=local_host,
            local_port=port,
        )
        await self._tunnel_client.start()

        public_url = self.tunnel_config.get_public_endpoint(
            token=self.token,
            agent_id=self.agent_id,
        )
        print(f"  Public WS: {public_url}")
        print("=" * 60)
        print(f"\nServer running on port {port} with tunnel. Press Ctrl+C to stop.\n")

        try:
            # Block until interrupted
            await asyncio.Event().wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            await self._tunnel_client.stop()
            await runner.cleanup()

    def _print_startup_banner(self, host: str, port: int) -> None:
        """Print a startup banner to stdout."""
        print("=" * 60)
        print(f"  {self.name} (ACP Agent Server)")
        print("=" * 60)
        print(f"  Agent ID:  {self.agent_id}")
        print(f"  Auth:      {'Token required' if self.token else 'No auth'}")
        print(f"  History:   {self.conv_mgr.max_history} turns per session")
        print("-" * 60)
        print(f"  ACP WS:    ws://localhost:{port}/acp/ws")
        print(f"  ACP WSURL: ws://localhost:{port}/acp/ws?token={self.token}&agent_id={self.agent_id}")
        if self.token:
            print(f"  Token:     {self.token}")
        if self.tunnel_config:
            print(f"  Channel:   {self.tunnel_config.server_url}")
            print(f"  Chan ID:   {self.tunnel_config.channel_id}")
            # Public endpoint printed after tunnel connects (in _run_async)
        elif self._openclaw_channel:
            cfg = self._openclaw_channel.config
            print(f"  OpenClaw:  {cfg.gateway_url}")
            print(f"  Session:   {self._openclaw_channel._session_key}")
            print("=" * 60)
            print(f"\nServer starting on port {port} with OpenClaw channel... Press Ctrl+C to stop.\n")
        else:
            print("=" * 60)
            print(f"\nServer starting on port {port}... Press Ctrl+C to stop.\n")

    def create_app(self) -> web.Application:
        """Create and return the aiohttp :class:`web.Application`.

        Useful if you need to customise routes or middleware before running.
        Extra routes returned by :meth:`get_extra_routes` are registered here.
        """
        app = web.Application()
        app.router.add_get("/acp/ws", self.handle_websocket)
        app.router.add_get("/health", self._handle_health)

        for method, path, handler in self.get_extra_routes():
            app.router.add_route(method, path, handler)

        # Periodic session cleanup
        async def _start_cleanup(app: web.Application):
            async def _cleanup_loop():
                while True:
                    await asyncio.sleep(600)
                    self.conv_mgr.cleanup_expired(max_age_seconds=259200)
            app["_cleanup_task"] = asyncio.create_task(_cleanup_loop())

        async def _stop_cleanup(app: web.Application):
            task = app.get("_cleanup_task")
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        app.on_startup.append(_start_cleanup)
        app.on_cleanup.append(_stop_cleanup)

        return app

    async def _handle_health(self, request: web.Request) -> web.Response:
        """Simple health-check endpoint (``GET /health``)."""
        return web.Response(text="ok")
