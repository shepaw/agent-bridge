"""Utility helpers for the ACP protocol."""

from typing import Dict, Optional

from .jsonrpc import jsonrpc_notification
from .types import ACPDirective


def acp_directive_to_notification(
    directive: ACPDirective,
    task_id: str,
    component_method_map: Optional[Dict[str, str]] = None,
) -> dict:
    """Convert an :class:`ACPDirective` into a JSON-RPC ``ui.*`` notification.

    Uses *component_method_map* (directive type → ACP notification method)
    fetched from the app via ``hub.getUIComponentTemplates`` so that new
    component types added on the app side are automatically supported without
    modifying agent code.

    The LLM's directive payload is forwarded as-is (with *task_id* injected),
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
