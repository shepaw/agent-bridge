"""Channel Tunnel client for paw_acp_sdk.

Implements the ``tunnel-http`` / ``tunnel-ws`` protocol used by the Shepaw
Channel Service.  When enabled, the local ACP agent server is reachable from
the public internet via the Channel Service, in addition to the local network.

Usage::

    from paw_acp_sdk import ACPAgentServer, ChannelTunnelConfig

    class MyAgent(ACPAgentServer):
        async def on_chat(self, ctx, message, **kwargs):
            await ctx.send_text("Hello!")

    config = ChannelTunnelConfig(
        server_url="https://channel.example.com",
        channel_id="ch_abc123",
        secret="ch_sec_xyz",
    )
    MyAgent(name="My Agent").run_with_tunnel(tunnel_config=config, port=8080)

Protocol messages (JSON):
  request      - HTTP request forwarded from the Channel Service
  response     - HTTP response to send back
  ws_connect   - New WebSocket stream
  ws_data      - WebSocket frame (body is base64)
  ws_close     - Close a WebSocket stream
  ping         - Heartbeat from server
  pong         - Heartbeat reply
  close        - Server is closing the tunnel (e.g. secret rotated)
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import aiohttp

log = logging.getLogger(__name__)


# ── Configuration ─────────────────────────────────────────────────────────────


@dataclass
class ChannelTunnelConfig:
    """Configuration for the Channel Service tunnel.

    Parameters
    ----------
    server_url:
        HTTPS base URL of the Channel Service, e.g. ``https://channel.example.com``.
    channel_id:
        Unique channel identifier issued by the Channel Service.
    secret:
        Authentication secret for the channel.
    channel_endpoint:
        Optional short-name endpoint (used as ``/c/<endpoint>`` prefix). When
        not set, requests arrive under ``/proxy/<channel_id>``.
    auto_connect:
        Unused in the Python SDK; provided for config compatibility with the
        Shepaw Flutter app.
    """

    server_url: str
    channel_id: str
    secret: str
    channel_endpoint: str = ""
    auto_connect: bool = False

    def get_public_endpoint(
        self,
        token: str = "",
        agent_id: str = "",
    ) -> str:
        """Return the public WebSocket URL where the agent can be reached.

        Mirrors ``ChannelTunnelService.getPublicEndpoint`` in the Shepaw Flutter
        app.  Pass *token* and *agent_id* to include them as query parameters
        so the resulting URL can be pasted directly into the Shepaw app.

        Parameters
        ----------
        token:
            ACP authentication token.  Included as ``?token=<token>`` when set.
        agent_id:
            Agent ID.  Included as ``&agentId=<agent_id>`` when set.
        """
        base = self.server_url.rstrip("/")
        ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
        if self.channel_endpoint:
            url = f"{ws_base}/c/{self.channel_endpoint}/acp/ws"
        else:
            url = f"{ws_base}/proxy/{self.channel_id}/acp/ws"

        params: list[str] = []
        if token:
            params.append(f"token={token}")
        if agent_id:
            params.append(f"agentId={agent_id}")
        if params:
            url = f"{url}?{'&'.join(params)}"
        return url

    def to_dict(self) -> Dict[str, Any]:
        return {
            "server_url": self.server_url,
            "channel_id": self.channel_id,
            "secret": self.secret,
            "channel_endpoint": self.channel_endpoint,
            "auto_connect": self.auto_connect,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ChannelTunnelConfig":
        return cls(
            server_url=d["server_url"],
            channel_id=d["channel_id"],
            secret=d["secret"],
            channel_endpoint=d.get("channel_endpoint", ""),
            auto_connect=d.get("auto_connect", False),
        )


# ── Tunnel message ─────────────────────────────────────────────────────────────


@dataclass
class _TunnelMessage:
    """Internal representation of a tunnel protocol message."""

    type: str
    stream_id: int = 0
    method: str = ""
    path: str = ""
    headers: Dict[str, str] = field(default_factory=dict)
    status: int = 0
    body: str = ""          # base64-encoded bytes
    error: str = ""
    ws_msg_type: int = 0    # 1 = text, 2 = binary

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "_TunnelMessage":
        raw_headers = d.get("headers") or {}
        headers: Dict[str, str] = {str(k): str(v) for k, v in raw_headers.items()}
        return cls(
            type=d.get("type", ""),
            stream_id=int(d.get("stream_id", 0)),
            method=d.get("method", ""),
            path=d.get("path", ""),
            headers=headers,
            status=int(d.get("status", 0)),
            body=d.get("body", ""),
            error=d.get("error", ""),
            ws_msg_type=int(d.get("ws_msg_type", 0)),
        )

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"type": self.type}
        if self.stream_id:
            d["stream_id"] = self.stream_id
        if self.method:
            d["method"] = self.method
        if self.path:
            d["path"] = self.path
        if self.headers:
            d["headers"] = self.headers
        if self.status:
            d["status"] = self.status
        if self.body:
            d["body"] = self.body
        if self.error:
            d["error"] = self.error
        if self.ws_msg_type:
            d["ws_msg_type"] = self.ws_msg_type
        return d

    def dumps(self) -> str:
        return json.dumps(self.to_dict())


# ── TunnelClient ──────────────────────────────────────────────────────────────


class TunnelClient:
    """WebSocket tunnel client that connects to the Channel Service.

    Forwards HTTP requests and WebSocket streams from the Channel Service to
    the local ACP agent server.

    Parameters
    ----------
    config:
        :class:`ChannelTunnelConfig` with the Channel Service connection details.
    local_host:
        Hostname/IP of the local ACP server to forward requests to.
    local_port:
        Port of the local ACP server.
    """

    def __init__(
        self,
        config: ChannelTunnelConfig,
        local_host: str = "127.0.0.1",
        local_port: int = 8080,
    ) -> None:
        self.config = config
        self.local_host = local_host
        self.local_port = local_port

        self._running = False
        self._stop_requested = False
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._session: Optional[aiohttp.ClientSession] = None

        # per-stream queues: stream_id → asyncio.Queue
        self._ws_streams: Dict[int, asyncio.Queue] = {}

        self._loop_task: Optional[asyncio.Task] = None

    # ── Public interface ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the tunnel reconnect loop in the background."""
        if self._running:
            return
        self._running = True
        self._stop_requested = False
        self._loop_task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        """Stop the tunnel and close all connections."""
        self._stop_requested = True
        self._running = False
        await self._disconnect()
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        if self._session and not self._session.closed:
            await self._session.close()

    # ── Internal reconnect loop ──────────────────────────────────────────────

    async def _run_loop(self) -> None:
        backoff = 2.0
        max_backoff = 60.0

        # Lazy-create session (reused across reconnects)
        self._session = aiohttp.ClientSession()

        while self._running and not self._stop_requested:
            try:
                await self._connect()
                print(f"[Tunnel] Connected to {self.config.server_url}")
                backoff = 2.0  # reset on success
                await self._listen()
            except asyncio.CancelledError:
                break
            except Exception as e:
                if self._stop_requested:
                    break
                log.warning("[Tunnel] Connection error: %s", e)
                print(f"[Tunnel] Connection error: {e}")

            if self._stop_requested or not self._running:
                break

            print(f"[Tunnel] Reconnecting in {backoff:.0f}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)

        if self._session and not self._session.closed:
            await self._session.close()
        print("[Tunnel] Tunnel client stopped")

    # ── Connect / disconnect ─────────────────────────────────────────────────

    async def _connect(self) -> None:
        """Establish WebSocket connection to the Channel Service."""
        base = self.config.server_url.rstrip("/")
        ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
        channel_id = self.config.channel_id
        secret = self.config.secret

        # HMAC-SHA256 签名认证（密钥不上线）
        timestamp = str(int(time.time()))
        nonce = os.urandom(16).hex()
        signing_string = f"{channel_id}\n{timestamp}\n{nonce}"
        signature = hmac.new(
            secret.encode(), signing_string.encode(), hashlib.sha256
        ).hexdigest()

        ws_url = (
            f"{ws_base}/tunnel/connect"
            f"?channel_id={channel_id}"
            f"&timestamp={timestamp}"
            f"&nonce={nonce}"
            f"&signature={signature}"
        )
        log.debug("[Tunnel] Connecting to %s", ws_base + "/tunnel/connect")
        assert self._session is not None
        self._ws = await self._session.ws_connect(
            ws_url,
            heartbeat=30,
            receive_timeout=None,
        )

    async def _disconnect(self) -> None:
        """Close tunnel WebSocket and all proxy streams."""
        # Signal all active WS proxy loops to exit
        for stream_id, queue in list(self._ws_streams.items()):
            await queue.put(_TunnelMessage(type="ws_close", stream_id=stream_id))
        self._ws_streams.clear()

        if self._ws and not self._ws.closed:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None

    # ── Main listener ────────────────────────────────────────────────────────

    async def _listen(self) -> None:
        """Receive messages from the Channel Service and dispatch them."""
        assert self._ws is not None
        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    tm = _TunnelMessage.from_dict(data)
                except (json.JSONDecodeError, Exception) as e:
                    log.warning("[Tunnel] Failed to parse message: %s", e)
                    continue
                await self._dispatch(tm)
            elif msg.type == aiohttp.WSMsgType.BINARY:
                log.debug("[Tunnel] Unexpected binary message, ignored")
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING):
                log.info("[Tunnel] WebSocket closed by server")
                break
            elif msg.type == aiohttp.WSMsgType.ERROR:
                log.warning("[Tunnel] WebSocket error: %s", self._ws.exception())
                break

    async def _dispatch(self, msg: _TunnelMessage) -> None:
        """Route a tunnel message to the appropriate handler."""
        if msg.type == "ping":
            await self._send(_TunnelMessage(type="pong"))

        elif msg.type == "request":
            asyncio.create_task(
                self._forward_http(msg),
                name=f"tunnel-http-{msg.stream_id}",
            )

        elif msg.type == "ws_connect":
            asyncio.create_task(
                self._forward_ws_connect(msg),
                name=f"tunnel-ws-{msg.stream_id}",
            )

        elif msg.type in ("ws_data", "ws_close"):
            queue = self._ws_streams.get(msg.stream_id)
            if queue is not None:
                await queue.put(msg)

        elif msg.type == "close":
            log.warning("[Tunnel] Server closed tunnel (secret may have been rotated)")
            if self._ws and not self._ws.closed:
                await self._ws.close()

        else:
            log.debug("[Tunnel] Unknown message type: %s", msg.type)

    # ── HTTP forwarding ──────────────────────────────────────────────────────

    async def _forward_http(self, req: _TunnelMessage) -> None:
        """Forward an HTTP request from the tunnel to the local ACP server."""
        assert self._session is not None
        try:
            # Decode optional request body
            body_bytes: Optional[bytes] = None
            if req.body:
                body_bytes = base64.b64decode(req.body)

            # Build local URL
            local_url = (
                f"http://{self.local_host}:{self.local_port}{req.path}"
            )

            # Strip hop-by-hop / problematic headers
            _skip = {"host", "content-length", "transfer-encoding", "connection"}
            fwd_headers = {
                k: v for k, v in req.headers.items()
                if k.lower() not in _skip
            }

            async with self._session.request(
                method=req.method.upper() or "GET",
                url=local_url,
                headers=fwd_headers,
                data=body_bytes,
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                resp_body = await resp.read()

                # Collect response headers (skip hop-by-hop)
                resp_headers: Dict[str, str] = {}
                for k, v in resp.headers.items():
                    if k.lower() not in {"transfer-encoding", "connection"}:
                        resp_headers[k] = v

                await self._send(_TunnelMessage(
                    type="response",
                    stream_id=req.stream_id,
                    status=resp.status,
                    headers=resp_headers,
                    body=base64.b64encode(resp_body).decode(),
                ))

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("[Tunnel] HTTP forward error stream=%d: %s", req.stream_id, e)
            await self._send(_TunnelMessage(
                type="response",
                stream_id=req.stream_id,
                status=502,
                error=f"local request error: {e}",
            ))

    # ── WebSocket forwarding ─────────────────────────────────────────────────

    async def _forward_ws_connect(self, req: _TunnelMessage) -> None:
        """Establish a proxy WebSocket connection to the local ACP server."""
        assert self._session is not None

        # Strip path prefix: /proxy/<channel_id> or /c/<endpoint>
        stripped_path = req.path
        proxy_prefix = f"/proxy/{self.config.channel_id}"
        if stripped_path.startswith(proxy_prefix):
            stripped_path = stripped_path[len(proxy_prefix):]
        elif self.config.channel_endpoint:
            short_prefix = f"/c/{self.config.channel_endpoint}"
            if stripped_path.startswith(short_prefix):
                stripped_path = stripped_path[len(short_prefix):]

        local_ws_url = (
            f"ws://{self.local_host}:{self.local_port}{stripped_path}"
        )

        log.info(
            "[Tunnel] ws_connect stream=%d  '%s' → '%s'",
            req.stream_id, req.path, local_ws_url,
        )

        # Register per-stream message queue BEFORE connecting so we don't miss
        # ws_data messages that arrive while the connection is being established.
        queue: asyncio.Queue = asyncio.Queue()
        self._ws_streams[req.stream_id] = queue

        # Strip problematic headers for WebSocket upgrade
        _skip_ws = {"host", "upgrade", "connection", "sec-websocket-key",
                    "sec-websocket-version", "sec-websocket-extensions"}
        fwd_headers = {
            k: v for k, v in req.headers.items()
            if k.lower() not in _skip_ws
        }

        local_ws: Optional[aiohttp.ClientWebSocketResponse] = None
        try:
            local_ws = await self._session.ws_connect(
                local_ws_url,
                headers=fwd_headers,
                heartbeat=30,
                receive_timeout=None,
            )
        except Exception as e:
            log.warning("[Tunnel] WS connect to local failed (%s): %s", local_ws_url, e)
            await self._send(_TunnelMessage(type="ws_close", stream_id=req.stream_id))
            self._ws_streams.pop(req.stream_id, None)
            return

        log.debug("[Tunnel] WS proxy connected stream=%d -> %s", req.stream_id, local_ws_url)

        # Run both forwarding directions concurrently; stop when either side closes.
        done_event = asyncio.Event()

        async def _local_to_tunnel() -> None:
            """Forward frames from the local ACP server to the tunnel."""
            try:
                async for local_msg in local_ws:  # type: ignore[union-attr]
                    if local_msg.type == aiohttp.WSMsgType.TEXT:
                        body = base64.b64encode(local_msg.data.encode()).decode()
                        await self._send(_TunnelMessage(
                            type="ws_data",
                            stream_id=req.stream_id,
                            body=body,
                            ws_msg_type=1,
                        ))
                    elif local_msg.type == aiohttp.WSMsgType.BINARY:
                        body = base64.b64encode(local_msg.data).decode()
                        await self._send(_TunnelMessage(
                            type="ws_data",
                            stream_id=req.stream_id,
                            body=body,
                            ws_msg_type=2,
                        ))
                    elif local_msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING):
                        break
                    elif local_msg.type == aiohttp.WSMsgType.ERROR:
                        break
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log.debug("[Tunnel] local→tunnel error stream=%d: %s", req.stream_id, e)
            finally:
                await self._send(_TunnelMessage(type="ws_close", stream_id=req.stream_id))
                done_event.set()

        async def _tunnel_to_local() -> None:
            """Forward frames from the tunnel to the local ACP server."""
            try:
                while True:
                    tm = await queue.get()
                    if tm.type == "ws_close":
                        break
                    if tm.type == "ws_data":
                        raw = base64.b64decode(tm.body)
                        if tm.ws_msg_type == 1:
                            await local_ws.send_str(raw.decode())  # type: ignore[union-attr]
                        else:
                            await local_ws.send_bytes(raw)  # type: ignore[union-attr]
            except asyncio.CancelledError:
                pass
            except Exception as e:
                log.debug("[Tunnel] tunnel→local error stream=%d: %s", req.stream_id, e)
            finally:
                if local_ws and not local_ws.closed:
                    await local_ws.close()
                done_event.set()

        t2l_task = asyncio.create_task(_tunnel_to_local())
        l2t_task = asyncio.create_task(_local_to_tunnel())

        # Wait for either side to signal completion
        await done_event.wait()

        # Cancel the other task to avoid leaks
        for t in (t2l_task, l2t_task):
            if not t.done():
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

        # Clean up
        self._ws_streams.pop(req.stream_id, None)
        if local_ws and not local_ws.closed:
            await local_ws.close()

        log.debug("[Tunnel] WS proxy closed stream=%d", req.stream_id)

    # ── Send helper ──────────────────────────────────────────────────────────

    async def _send(self, msg: _TunnelMessage) -> None:
        """Send a tunnel message to the Channel Service."""
        if self._ws and not self._ws.closed:
            try:
                await self._ws.send_str(msg.dumps())
            except Exception as e:
                log.debug("[Tunnel] send failed: %s", e)
