"""WebSocket delivery for the in-process telemetry hub."""
from __future__ import annotations

import asyncio
import json
import queue
import threading
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlparse
import ssl

from .auth import AuthenticationError, TokenVerifier, authorize, extract_token
from .hub import TelemetryHub


@dataclass
class WebSocketServerHandle:
    host: str
    port: int
    _stop: threading.Event
    _thread: threading.Thread

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._thread.join(timeout=timeout)


def _request_path(websocket: Any) -> str:
    request = getattr(websocket, "request", None)
    if request is not None and getattr(request, "path", None):
        return request.path
    return getattr(websocket, "path", "/")


def _filters(websocket: Any) -> tuple[str | None, str | None]:
    query = parse_qs(urlparse(_request_path(websocket)).query)
    aircraft_id = query.get("aircraft_id", [None])[0]
    source = query.get("source", [None])[0]
    allowed_sources = {None, "simulated", "aircraft"}
    if source not in allowed_sources:
        raise ValueError("source must be simulated or aircraft")
    return aircraft_id, source


async def _handler(websocket: Any, hub: TelemetryHub, verifier: TokenVerifier | None) -> None:
    try:
        aircraft_id, source = _filters(websocket)
    except ValueError as error:
        await websocket.close(code=1008, reason=str(error))
        return
    if verifier is None:
        principal = None
    else:
        try:
            token = extract_token(websocket)
            if token is None:
                raise AuthenticationError("missing_token")
            principal = verifier.verify(token)
            authorize(principal, aircraft_id, source)
        except AuthenticationError:
            # Do not disclose whether the token was missing, invalid, expired,
            # or unauthorized to an unauthenticated peer.
            await websocket.close(code=1008, reason="authentication required")
            return

    subscription = hub.subscribe(aircraft_id=aircraft_id, source=source)
    sender = asyncio.create_task(_send_events(websocket, subscription))
    closer = asyncio.create_task(websocket.wait_closed())
    try:
        await websocket.send(json.dumps({
            "type": "hello",
            "protocol": "ucas.telemetry.v1",
            "aircraft_id": aircraft_id,
            "source": source,
            "authenticated_subject": principal.subject if principal else None,
            "recovery": "refetch_latest_and_history_on_stream_gap",
        }, separators=(",", ":")))
        await asyncio.wait({sender, closer}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        sender.cancel()
        closer.cancel()
        subscription.close()


async def _send_events(websocket: Any, subscription: Any) -> None:
    while True:
        try:
            event = subscription.events.get_nowait()
        except queue.Empty:
            # Avoid a blocking executor thread: cancellation must not leave a
            # non-daemon queue.get worker behind after a client disconnects.
            await asyncio.sleep(0.05)
            continue
        await websocket.send(json.dumps(event, separators=(",", ":")))


async def _serve(hub: TelemetryHub, host: str, port: int, stop: threading.Event, verifier: TokenVerifier | None, ssl_context: ssl.SSLContext | None) -> None:
    try:
        from websockets.asyncio.server import serve
    except ImportError:  # websockets 13 compatibility
        from websockets.server import serve

    async def handler(websocket: Any) -> None:
        await _handler(websocket, hub, verifier)

    async with serve(handler, host, port, ssl=ssl_context, ping_interval=20, ping_timeout=20, max_size=1_000_000):
        await asyncio.to_thread(stop.wait)


def start_background_server(
    hub: TelemetryHub,
    host: str = "127.0.0.1",
    port: int = 8765,
    verifier: TokenVerifier | None = None,
    ssl_context: ssl.SSLContext | None = None,
) -> WebSocketServerHandle:
    """Start WebSocket delivery in a daemon thread beside the HTTP API."""
    stop = threading.Event()

    def run() -> None:
        asyncio.run(_serve(hub, host, port, stop, verifier, ssl_context))

    thread = threading.Thread(target=run, name="ucas-telemetry-websocket", daemon=True)
    thread.start()
    return WebSocketServerHandle(host, port, stop, thread)
