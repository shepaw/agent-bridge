"""OpenClaw Gateway Channel for paw_acp_sdk.

Connects a paw_acp_sdk ACP agent to a running OpenClaw Gateway, so that users
can chat with your Python agent through any platform supported by OpenClaw
(Discord, Telegram, Slack, iMessage, etc.) **and** through the Shepaw app.

The bridge works as follows:

  Shepaw App  ←→  ACPAgentServer  ←→  OpenClawChannel  ←→  OpenClaw Gateway
                  (WebSocket/ACP)                          (WebSocket/Gateway Protocol)

When a Shepaw user sends a message, :class:`ACPAgentServer` calls
:meth:`on_chat`. Instead of generating a reply itself, the agent can delegate
the message to OpenClaw using :meth:`OpenClawChannel.send_and_stream`.  The
channel forwards the message to the configured OpenClaw Gateway session via the
``chat.send`` Gateway method, then streams the reply text back chunk by chunk.

Usage::

    import asyncio
    from paw_acp_sdk import ACPAgentServer, TaskContext
    from paw_acp_sdk.openclaw_channel import OpenClawChannel, OpenClawChannelConfig

    config = OpenClawChannelConfig(
        gateway_url="ws://127.0.0.1:18789",
        gateway_token="my-openclaw-token",
        session_key="acp:shepaw-bridge",
    )

    class OpenClawBridgeAgent(ACPAgentServer):
        def __init__(self):
            super().__init__(name="OpenClaw Bridge")
            self.openclaw = OpenClawChannel(config)

        async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
            async for chunk in self.openclaw.send_and_stream(message):
                await ctx.send_text(chunk)

    agent = OpenClawBridgeAgent()
    agent.run(port=8080)

OpenClaw Gateway protocol overview:
  1. WebSocket open
  2. Server sends: {type: "event", event: "connect.challenge", payload: {nonce: "..."}}
  3. Client sends: {type: "req", id: "<uuid>", method: "connect", params: ConnectParams}
     - ConnectParams.auth.token = gateway_token
     - ConnectParams.minProtocol / maxProtocol = 3
  4. Server sends: {type: "res", id: "<uuid>", ok: true, payload: HelloOk}  → connected
  5. Client sends: {type: "req", id: "<uuid>", method: "chat.send", params: {
         sessionKey, message, idempotencyKey }}
  6. Server streams: {type: "event", event: "chat", payload: {
         state: "delta"|"final", message: {content: [{type: "text", text: "..."}]} }}
  7. state=="final"  → stream complete

"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator, Optional

import aiohttp

log = logging.getLogger(__name__)

# OpenClaw Gateway protocol version
_PROTOCOL_VERSION = 3

# Sentinel session key format (matches OpenClaw's acp:<uuid> pattern)
_DEFAULT_SESSION_KEY_PREFIX = "acp:shepaw"


# ── Configuration ──────────────────────────────────────────────────────────────


@dataclass
class OpenClawChannelConfig:
    """Configuration for connecting to an OpenClaw Gateway.

    Parameters
    ----------
    gateway_url:
        WebSocket URL of the OpenClaw Gateway.
        Default: ``ws://127.0.0.1:18789`` (local gateway).
    gateway_token:
        Authentication token for the OpenClaw Gateway.
        If empty string, attempts unauthenticated connection (only works
        when gateway has no auth configured).
    session_key:
        OpenClaw session key to send messages to.
        If empty string, a new session key is auto-generated per connection
        using the format ``acp:shepaw-<8hex>``.
    client_id:
        Client identifier sent to the gateway during handshake.
        Defaults to ``"cli"`` (same as OpenClaw CLI client).
    client_mode:
        Client mode sent during handshake. Defaults to ``"cli"``.
    client_version:
        Client version string. Defaults to ``"paw-acp-sdk"``.
    connect_timeout:
        Seconds to wait for initial connection handshake. Default: 10.
    request_timeout:
        Seconds to wait for ``chat.send`` acknowledgement. Default: 30.
    reply_timeout:
        Seconds to wait for a complete reply (``state=final``). Set to
        ``None`` to wait indefinitely. Default: 300.
    """

    gateway_url: str = "ws://127.0.0.1:18789"
    gateway_token: str = ""
    session_key: str = ""
    client_id: str = "cli"
    client_mode: str = "cli"
    client_version: str = "paw-acp-sdk"
    connect_timeout: float = 10.0
    request_timeout: float = 30.0
    reply_timeout: Optional[float] = 300.0

    def get_session_key(self) -> str:
        """Return the configured session key, or generate a default one."""
        if self.session_key:
            return self.session_key
        return f"{_DEFAULT_SESSION_KEY_PREFIX}-{uuid.uuid4().hex[:8]}"


# ── Internal frame types ───────────────────────────────────────────────────────


def _req_frame(method: str, params: dict, req_id: Optional[str] = None) -> str:
    """Serialize a Gateway request frame to JSON."""
    return json.dumps({
        "type": "req",
        "id": req_id or uuid.uuid4().hex,
        "method": method,
        "params": params,
    })


# ── OpenClawChannel ────────────────────────────────────────────────────────────


class OpenClawChannel:
    """Bridge between a paw_acp_sdk agent and an OpenClaw Gateway.

    This class maintains a persistent WebSocket connection to the OpenClaw
    Gateway.  Messages are forwarded via ``chat.send`` and streamed replies
    are returned as async iterators of text chunks.

    The connection is established lazily on the first call to
    :meth:`send_and_stream` and automatically reconnected on failure.

    Parameters
    ----------
    config:
        :class:`OpenClawChannelConfig` with Gateway connection details.
    """

    def __init__(self, config: OpenClawChannelConfig) -> None:
        self.config = config
        self._session_key = config.get_session_key()

        # aiohttp session (reused across reconnects)
        self._http_session: Optional[aiohttp.ClientSession] = None

        # Active WebSocket connection to the Gateway
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None

        # Connection state
        self._connected = False
        self._connecting = False
        self._connect_lock = asyncio.Lock()

        # Pending request futures: req_id → (Future, expect_final flag)
        self._pending: dict[str, tuple[asyncio.Future, bool]] = {}

        # Chat event subscribers: session_key → asyncio.Queue of event payloads
        self._chat_queues: dict[str, asyncio.Queue] = {}

        # Background task reading from WebSocket
        self._recv_task: Optional[asyncio.Task] = None

    # ── Public interface ──────────────────────────────────────────────────────

    async def send_and_stream(self, message: str) -> AsyncIterator[str]:
        """Send *message* to OpenClaw and yield text chunks as they arrive.

        Automatically establishes or reconnects the Gateway connection as
        needed.

        Parameters
        ----------
        message:
            The user's message text to forward to OpenClaw.

        Yields
        ------
        str
            Incremental text chunks from the assistant's reply.
        """
        await self._ensure_connected()

        session_key = self._session_key
        run_id = uuid.uuid4().hex

        # Register a queue to collect chat events for this session
        event_queue: asyncio.Queue = asyncio.Queue()
        self._chat_queues[session_key] = event_queue

        try:
            # Send the message to OpenClaw Gateway
            req_id = uuid.uuid4().hex
            req_future: asyncio.Future = asyncio.get_event_loop().create_future()
            # expect_final=True: the first response has {status: "started"}; we
            # should ignore it and wait for the actual final response (which
            # comes after all the streaming chat events).  However, because we
            # derive the reply from streaming "chat" events (not the final res
            # frame), we only need the initial ack to confirm the request was
            # accepted.  We therefore use expect_final=False and resolve on the
            # first non-error response (the "started" ack is enough for us).
            self._pending[req_id] = (req_future, False)

            frame = _req_frame(
                "chat.send",
                {
                    "sessionKey": session_key,
                    "message": message,
                    "idempotencyKey": run_id,
                },
                req_id=req_id,
            )

            assert self._ws is not None
            await self._ws.send_str(frame)
            log.debug("[OpenClaw] chat.send sent (session=%s run=%s)", session_key, run_id)

            # Wait for the "accepted" ack from the Gateway
            try:
                ack = await asyncio.wait_for(req_future, timeout=self.config.request_timeout)
                log.debug("[OpenClaw] chat.send ack: %s", ack)
            except asyncio.TimeoutError:
                self._pending.pop(req_id, None)
                raise RuntimeError(
                    f"OpenClaw Gateway did not acknowledge chat.send within "
                    f"{self.config.request_timeout}s"
                )

            # Stream reply chunks until state=="final"
            sent_length = 0
            reply_timeout = self.config.reply_timeout

            while True:
                try:
                    evt_payload = await asyncio.wait_for(
                        event_queue.get(),
                        timeout=reply_timeout,
                    )
                except asyncio.TimeoutError:
                    raise RuntimeError(
                        f"OpenClaw reply timed out after {reply_timeout}s"
                    )

                state = evt_payload.get("state")
                message_data = evt_payload.get("message") or {}

                if state in ("delta", "final"):
                    # Extract text content from the message snapshot
                    content_blocks = message_data.get("content") or []
                    full_text = "\n".join(
                        block.get("text", "")
                        for block in content_blocks
                        if isinstance(block, dict) and block.get("type") == "text"
                    ).rstrip()

                    if full_text and len(full_text) > sent_length:
                        chunk = full_text[sent_length:]
                        sent_length = len(full_text)
                        yield chunk

                if state == "final":
                    log.debug("[OpenClaw] reply complete (session=%s)", session_key)
                    break
                elif state == "aborted":
                    log.info("[OpenClaw] reply aborted (session=%s)", session_key)
                    break
                elif state == "error":
                    error_msg = evt_payload.get("errorMessage", "unknown error")
                    raise RuntimeError(f"OpenClaw replied with error: {error_msg}")

        finally:
            self._chat_queues.pop(session_key, None)

    async def close(self) -> None:
        """Close the Gateway connection and clean up resources."""
        self._connected = False
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        if self._ws and not self._ws.closed:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        self._ws = None
        self._http_session = None
        log.info("[OpenClaw] Channel closed")

    # ── Connection management ─────────────────────────────────────────────────

    async def _ensure_connected(self) -> None:
        """Ensure a live WebSocket connection to the Gateway exists."""
        if self._connected and self._ws and not self._ws.closed:
            return

        async with self._connect_lock:
            # Double-check after acquiring lock
            if self._connected and self._ws and not self._ws.closed:
                return
            await self._connect()

    async def _connect(self) -> None:
        """Establish a WebSocket connection and complete the handshake."""
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession()

        log.info("[OpenClaw] Connecting to %s", self.config.gateway_url)

        try:
            self._ws = await self._http_session.ws_connect(
                self.config.gateway_url,
                heartbeat=30,
                receive_timeout=None,
                timeout=aiohttp.ClientTimeout(
                    connect=self.config.connect_timeout,
                    total=None,
                ),
            )
        except Exception as e:
            raise ConnectionError(
                f"Failed to connect to OpenClaw Gateway at "
                f"{self.config.gateway_url}: {e}"
            ) from e

        # Complete the connect challenge / handshake
        await self._handshake()

        # Start background message reader
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
        self._recv_task = asyncio.create_task(
            self._recv_loop(),
            name="openclaw-recv",
        )

        self._connected = True
        log.info("[OpenClaw] Connected (session_key=%s)", self._session_key)

    async def _handshake(self) -> None:
        """Wait for the connect.challenge event and send the connect request."""
        assert self._ws is not None

        # Step 1: wait for connect.challenge
        nonce = await self._wait_for_challenge()

        # Step 2: send connect request
        req_id = uuid.uuid4().hex
        auth: dict = {}
        if self.config.gateway_token:
            auth["token"] = self.config.gateway_token

        connect_params: dict = {
            "minProtocol": _PROTOCOL_VERSION,
            "maxProtocol": _PROTOCOL_VERSION,
            "client": {
                "id": self.config.client_id,
                "displayName": "PAW ACP SDK Bridge",
                "version": self.config.client_version,
                "platform": "linux",
                "mode": self.config.client_mode,
            },
            "caps": [],
            "role": "operator",
            "scopes": ["operator.admin"],
        }
        if auth:
            connect_params["auth"] = auth

        # Note: we don't use device-key signing – simple token auth only.
        # The nonce is only needed for device-key signing; with token auth
        # the gateway accepts the connect request without verifying the nonce.
        _ = nonce  # kept for documentation; not used in simple token flow

        frame = _req_frame("connect", connect_params, req_id=req_id)

        # Register a future for the connect response
        hello_future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = (hello_future, False)

        await self._ws.send_str(frame)

        # Wait for hello-ok response
        try:
            hello = await asyncio.wait_for(
                hello_future,
                timeout=self.config.connect_timeout,
            )
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise ConnectionError(
                f"OpenClaw Gateway did not respond to connect within "
                f"{self.config.connect_timeout}s"
            )

        log.debug("[OpenClaw] Handshake complete: %s", hello)

    async def _wait_for_challenge(self) -> str:
        """Read frames until the connect.challenge event arrives.

        Returns the nonce string from the challenge.
        """
        assert self._ws is not None

        deadline = asyncio.get_event_loop().time() + self.config.connect_timeout

        async for msg in self._ws:
            if asyncio.get_event_loop().time() > deadline:
                raise ConnectionError("Timed out waiting for connect.challenge")

            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                if (
                    data.get("type") == "event"
                    and data.get("event") == "connect.challenge"
                ):
                    payload = data.get("payload") or {}
                    nonce = payload.get("nonce", "")
                    if nonce:
                        log.debug("[OpenClaw] Got connect.challenge (nonce=%s)", nonce)
                        return nonce
                    raise ConnectionError(
                        "OpenClaw connect.challenge missing nonce"
                    )

                # Buffer any other frames that arrive before the challenge;
                # dispatch them so pending futures aren't starved.
                self._dispatch_frame(data)

            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING):
                raise ConnectionError("Gateway closed before sending connect.challenge")
            elif msg.type == aiohttp.WSMsgType.ERROR:
                raise ConnectionError(
                    f"WebSocket error during handshake: {self._ws.exception()}"
                )

        raise ConnectionError("WebSocket closed while waiting for connect.challenge")

    # ── Background receiver ───────────────────────────────────────────────────

    async def _recv_loop(self) -> None:
        """Continuously receive and dispatch frames from the Gateway."""
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        log.warning("[OpenClaw] Failed to parse frame: %.120s", msg.data)
                        continue
                    self._dispatch_frame(data)

                elif msg.type == aiohttp.WSMsgType.BINARY:
                    log.debug("[OpenClaw] Unexpected binary frame, ignored")

                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING):
                    log.info("[OpenClaw] Gateway WebSocket closed")
                    break

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    log.warning("[OpenClaw] WebSocket error: %s", self._ws.exception())
                    break

        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.warning("[OpenClaw] recv_loop error: %s", e)
        finally:
            self._connected = False
            # Fail all pending requests
            err = ConnectionError("OpenClaw Gateway connection lost")
            for fut, _ in self._pending.values():
                if not fut.done():
                    fut.set_exception(err)
            self._pending.clear()
            # Notify all chat queues
            sentinel = {"state": "error", "errorMessage": "Gateway connection lost"}
            for q in self._chat_queues.values():
                await q.put(sentinel)
            log.info("[OpenClaw] recv_loop exited")

    # ── Frame dispatch ────────────────────────────────────────────────────────

    def _dispatch_frame(self, data: dict) -> None:
        """Route an incoming Gateway frame to the appropriate handler."""
        frame_type = data.get("type")

        if frame_type == "res":
            # Response to one of our requests
            req_id = data.get("id")
            if not req_id:
                return
            entry = self._pending.get(req_id)
            if entry is None:
                return
            future, expect_final = entry
            if future.done():
                return

            payload = data.get("payload") or {}
            status = payload.get("status") if isinstance(payload, dict) else None

            # OpenClaw Gateway sends an initial ack with {status: "started"} or
            # {status: "in_flight"} for chat.send requests that are accepted but
            # not yet finished.  The actual final response (with {ok: true,
            # aborted: ..., runIds: ...}) comes later.
            #
            # For our streaming use case we only need the initial ack (we read
            # the reply from "chat" events), so we do NOT treat "started" /
            # "in_flight" responses as errors – just resolve the future early.
            if not data.get("ok"):
                self._pending.pop(req_id, None)
                err_info = data.get("error") or {}
                msg = err_info.get("message", "unknown gateway error")
                future.set_exception(RuntimeError(f"Gateway error: {msg}"))
                return

            # If expect_final and this is just an intermediate status ack,
            # keep waiting for the final response frame.
            if expect_final and status in ("started", "in_flight", "accepted"):
                log.debug("[OpenClaw] intermediate ack (status=%s, req=%s)", status, req_id)
                return

            self._pending.pop(req_id, None)
            future.set_result(payload)

        elif frame_type == "event":
            evt = data.get("event")
            payload = data.get("payload") or {}

            if evt == "chat":
                # Streaming chat reply
                # Try exact session_key match first; fall back to the only
                # active queue when the gateway omits sessionKey in the payload.
                session_key = payload.get("sessionKey", "")
                queue = self._chat_queues.get(session_key)
                if queue is None and self._chat_queues:
                    if len(self._chat_queues) == 1:
                        queue = next(iter(self._chat_queues.values()))
                        log.debug(
                            "[OpenClaw] chat event sessionKey=%r not matched, "
                            "routing to sole active queue",
                            session_key,
                        )
                    else:
                        log.warning(
                            "[OpenClaw] chat event sessionKey=%r not matched "
                            "among %d queues: %s",
                            session_key,
                            len(self._chat_queues),
                            list(self._chat_queues.keys()),
                        )
                if queue is not None:
                    queue.put_nowait(payload)
                else:
                    log.warning(
                        "[OpenClaw] chat event dropped — no active queue "
                        "(sessionKey=%r, payload keys=%s)",
                        session_key,
                        list(payload.keys()),
                    )

            elif evt == "tick":
                # Heartbeat – nothing to do
                pass

            elif evt == "connect.challenge":
                # Received after reconnect; should be handled by _handshake
                log.debug("[OpenClaw] Unexpected connect.challenge in recv_loop")

            else:
                log.debug("[OpenClaw] Unhandled event: %s payload=%r", evt, payload)

        else:
            log.debug("[OpenClaw] Unknown frame type: %s", frame_type)
