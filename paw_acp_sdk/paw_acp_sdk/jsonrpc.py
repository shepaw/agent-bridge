"""JSON-RPC 2.0 message builders for the ACP protocol."""

import uuid
from typing import Any, Optional


def jsonrpc_response(id: Any, result: Any = None, error: Any = None) -> dict:
    """Build a JSON-RPC 2.0 response."""
    msg: dict = {"jsonrpc": "2.0", "id": id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result if result is not None else {}
    return msg


def jsonrpc_notification(method: str, params: Optional[dict] = None) -> dict:
    """Build a JSON-RPC 2.0 notification (no id)."""
    msg: dict = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def jsonrpc_request(method: str, params: Optional[dict] = None, id: Optional[str] = None) -> dict:
    """Build a JSON-RPC 2.0 request."""
    msg: dict = {"jsonrpc": "2.0", "method": method, "id": id or str(uuid.uuid4())}
    if params is not None:
        msg["params"] = params
    return msg
