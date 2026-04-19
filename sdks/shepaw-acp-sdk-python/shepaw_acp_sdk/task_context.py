"""Per-task helper that wraps the raw WebSocket with high-level ACP methods."""

import asyncio
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from aiohttp import web

from .jsonrpc import jsonrpc_notification, jsonrpc_request


class TaskContext:
    """High-level per-task helper for sending ACP messages.

    An instance is created for each ``agent.chat`` invocation and passed to
    :meth:`ACPAgentServer.on_chat`.  It provides convenient methods so that
    subclass authors never have to build JSON-RPC envelopes by hand.

    Usage inside ``on_chat``::

        async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
            await ctx.send_text("Thinking...")
            result = do_something()
            await ctx.send_text(result)
    """

    def __init__(
        self,
        ws: web.WebSocketResponse,
        task_id: str,
        session_id: str,
        *,
        pending_hub_requests: Dict[str, asyncio.Future],
        pending_responses: Dict[str, asyncio.Future],
    ):
        self.ws = ws
        self.task_id = task_id
        self.session_id = session_id
        self._pending_hub_requests = pending_hub_requests
        self._pending_responses = pending_responses

    # ── Streaming text ──────────────────────────────────────────────

    async def send_text(self, content: str) -> None:
        """Send a streaming text chunk to the App."""
        await self.ws.send_json(jsonrpc_notification("ui.textContent", {
            "task_id": self.task_id,
            "content": content,
            "is_final": False,
        }))

    async def send_text_final(self) -> None:
        """Send the final (empty) text marker. Called automatically by the server."""
        await self.ws.send_json(jsonrpc_notification("ui.textContent", {
            "task_id": self.task_id,
            "content": "",
            "is_final": True,
        }))

    # ── Task lifecycle ──────────────────────────────────────────────

    async def started(self) -> None:
        """Send ``task.started``. Called automatically by the server."""
        await self.ws.send_json(jsonrpc_notification("task.started", {
            "task_id": self.task_id,
            "started_at": datetime.now().isoformat(),
        }))

    async def completed(self) -> None:
        """Send ``task.completed``. Called automatically by the server."""
        await self.ws.send_json(jsonrpc_notification("task.completed", {
            "task_id": self.task_id,
            "status": "success",
            "completed_at": datetime.now().isoformat(),
        }))

    async def error(self, message: str, code: int = -32603) -> None:
        """Send ``task.error``."""
        await self.ws.send_json(jsonrpc_notification("task.error", {
            "task_id": self.task_id,
            "message": message,
            "code": code,
        }))

    # ── UI Interactive Components ───────────────────────────────────

    async def send_action_confirmation(
        self,
        prompt: str,
        actions: List[Dict[str, str]],
        confirmation_id: Optional[str] = None,
        **extra,
    ) -> None:
        """Send a ``ui.actionConfirmation`` notification."""
        cid = confirmation_id or f"confirm_{uuid.uuid4().hex[:8]}"
        params: Dict[str, Any] = {
            "task_id": self.task_id,
            "confirmation_id": cid,
            "prompt": prompt,
            "actions": actions,
            **extra,
        }
        await self.ws.send_json(jsonrpc_notification("ui.actionConfirmation", params))

    async def send_single_select(
        self,
        prompt: str,
        options: List[Dict[str, str]],
        select_id: Optional[str] = None,
        **extra,
    ) -> None:
        """Send a single-choice prompt (deprecated wrapper around
        :meth:`send_form`).

        .. deprecated::
            Use :meth:`send_form` with a ``radio_group`` field instead.
            This method is kept for backward compatibility and now
            internally forwards to ``send_form``.
        """
        await self.send_form(
            title=prompt,
            fields=[
                {
                    "name": "choice",
                    "label": prompt,
                    "type": "radio_group",
                    "required": True,
                    "options": options,
                }
            ],
            form_id=select_id,
            **extra,
        )

    async def send_multi_select(
        self,
        prompt: str,
        options: List[Dict[str, str]],
        select_id: Optional[str] = None,
        min_select: int = 1,
        max_select: Optional[int] = None,
        **extra,
    ) -> None:
        """Send a multi-choice prompt (deprecated wrapper around
        :meth:`send_form`).

        .. deprecated::
            Use :meth:`send_form` with a ``checkbox_group`` field instead.
            This method is kept for backward compatibility and now
            internally forwards to ``send_form``. The ``min_select`` /
            ``max_select`` bounds are dropped on the wire but recorded in
            the form field as ``required``.
        """
        await self.send_form(
            title=prompt,
            fields=[
                {
                    "name": "choices",
                    "label": prompt,
                    "type": "checkbox_group",
                    "required": min_select > 0,
                    "options": options,
                }
            ],
            form_id=select_id,
            **extra,
        )

    async def send_file_upload(
        self,
        prompt: str,
        upload_id: Optional[str] = None,
        accept_types: Optional[List[str]] = None,
        max_files: int = 5,
        max_size_mb: int = 20,
        **extra,
    ) -> None:
        """Send a ``ui.fileUpload`` notification."""
        uid = upload_id or f"upload_{uuid.uuid4().hex[:8]}"
        params: Dict[str, Any] = {
            "task_id": self.task_id,
            "upload_id": uid,
            "prompt": prompt,
            "accept_types": accept_types or [],
            "max_files": max_files,
            "max_size_mb": max_size_mb,
            **extra,
        }
        await self.ws.send_json(jsonrpc_notification("ui.fileUpload", params))

    async def send_form(
        self,
        title: str,
        fields: List[Dict],
        form_id: Optional[str] = None,
        description: str = "",
        **extra,
    ) -> None:
        """Send a ``ui.form`` notification."""
        fid = form_id or f"form_{uuid.uuid4().hex[:8]}"
        params: Dict[str, Any] = {
            "task_id": self.task_id,
            "form_id": fid,
            "title": title,
            "description": description,
            "fields": fields,
            **extra,
        }
        await self.ws.send_json(jsonrpc_notification("ui.form", params))

    async def send_file_message(
        self,
        url: str,
        filename: str,
        mime_type: str = "application/octet-stream",
        size: int = 0,
        thumbnail_base64: Optional[str] = None,
        **extra,
    ) -> None:
        """Send a ``ui.fileMessage`` notification."""
        params: Dict[str, Any] = {
            "task_id": self.task_id,
            "url": url,
            "filename": filename,
            "mime_type": mime_type,
            "size": size,
            **extra,
        }
        if thumbnail_base64:
            params["thumbnail_base64"] = thumbnail_base64
        await self.ws.send_json(jsonrpc_notification("ui.fileMessage", params))

    async def send_message_metadata(
        self,
        collapsible: bool = True,
        collapsible_title: str = "Details",
        auto_collapse: bool = True,
        **extra,
    ) -> None:
        """Send a ``ui.messageMetadata`` notification."""
        params: Dict[str, Any] = {
            "task_id": self.task_id,
            "collapsible": collapsible,
            "collapsible_title": collapsible_title,
            "auto_collapse": auto_collapse,
            **extra,
        }
        await self.ws.send_json(jsonrpc_notification("ui.messageMetadata", params))

    # ── Hub requests (Agent → App) ──────────────────────────────────

    async def hub_request(self, method: str, params: Optional[dict] = None, timeout: float = 10.0) -> Any:
        """Send a JSON-RPC request to the App and wait for the response.

        Returns the ``result`` dict on success, raises on error or timeout.
        """
        req_id = str(uuid.uuid4())
        req = jsonrpc_request(method, params, id=req_id)
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_hub_requests[req_id] = future
        try:
            await self.ws.send_json(req)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_hub_requests.pop(req_id, None)
            raise
        except Exception:
            self._pending_hub_requests.pop(req_id, None)
            raise

    async def wait_for_response(self, component_id: str, timeout: float = 300.0) -> dict:
        """Wait for a user interactive response (button click, form submit, etc.).

        *component_id* should match the ``confirmation_id``, ``select_id``,
        ``upload_id`` or ``form_id`` sent in the corresponding UI notification.
        """
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_responses[component_id] = future
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_responses.pop(component_id, None)
            raise
