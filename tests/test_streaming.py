import asyncio
import json
import socket
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.telemetry_stream import TelemetryHub, TokenVerifier, build_stream_event
from services.telemetry_stream.auth import AuthenticationError
from services.telemetry_stream.server import start_background_server


def result(aircraft_id="sim-ucas-001", source="simulated", status="accepted", sequence=1):
    return {
        "aircraft_id": aircraft_id,
        "source": source,
        "source_id": "test-source",
        "sequence": sequence,
        "sampled_at": "2026-01-01T00:00:00Z",
        "received_at": "2026-01-01T00:00:01Z",
        "status": status,
    }


SECRET = "test-secret-with-at-least-32-characters-long"


def token(**overrides):
    now = datetime.now(timezone.utc)
    claims = {
        "sub": "operator-1",
        "scope": "telemetry:read",
        "iss": "ucas-management",
        "aud": "ucas-telemetry",
        "iat": now,
        "nbf": now,
        "exp": now + timedelta(minutes=5),
    }
    claims.update(overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_token_verifier_requires_scope_and_enforces_resource_claims():
    verifier = TokenVerifier(SECRET, "ucas-management", "ucas-telemetry")
    principal = verifier.verify(token(aircraft_ids=["sim-ucas-001"], sources=["simulated"]))
    assert principal.subject == "operator-1"
    assert principal.can_read("sim-ucas-001", "simulated")
    assert not principal.can_read("other-001", "simulated")
    assert not principal.can_read("sim-ucas-001", "aircraft")
    with pytest.raises(AuthenticationError, match="insufficient_scope"):
        verifier.verify(token(scope="telemetry:write"))


def test_token_verifier_rejects_wrong_signature_and_expired_token():
    verifier = TokenVerifier(SECRET, "ucas-management", "ucas-telemetry")
    with pytest.raises(AuthenticationError):
        invalid = token()[:-1] + "x"
        verifier.verify(invalid)
    with pytest.raises(AuthenticationError):
        verifier.verify(token(exp=datetime.now(timezone.utc) - timedelta(minutes=1)))


def test_hub_filters_by_aircraft_and_source():
    hub = TelemetryHub()
    with hub.subscribe(aircraft_id="sim-ucas-001", source="simulated") as subscription:
        hub.publish(build_stream_event(result()))
        hub.publish(build_stream_event(result(aircraft_id="other-001")))
        hub.publish(build_stream_event(result(source="aircraft")))
        event = subscription.events.get_nowait()
        assert event["aircraft_id"] == "sim-ucas-001"
        assert subscription.events.empty()
        assert hub.metrics()["published"] == 3
        assert hub.metrics()["delivered"] == 1


def test_hub_emits_gap_when_subscriber_queue_overflows():
    hub = TelemetryHub()
    with hub.subscribe(max_queue=2) as subscription:
        for sequence in range(1, 5):
            hub.publish(build_stream_event(result(sequence=sequence)))
        queued = [subscription.events.get_nowait(), subscription.events.get_nowait()]
        assert any(event["type"] == "stream_gap" for event in queued)
        assert hub.metrics()["dropped"] >= 1


def test_websocket_delivers_hello_and_filtered_event():
    websockets = pytest.importorskip("websockets")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    hub = TelemetryHub()
    server = start_background_server(hub, port=port)

    async def scenario():
        uri = f"ws://127.0.0.1:{port}/ws?aircraft_id=sim-ucas-001&source=simulated"
        last_error = None
        for _ in range(30):
            try:
                async with websockets.connect(uri) as client:
                    hello = json.loads(await asyncio.wait_for(client.recv(), timeout=2))
                    assert hello["type"] == "hello"
                    assert hello["protocol"] == "ucas.telemetry.v1"
                    hub.publish(build_stream_event(result()))
                    event = json.loads(await asyncio.wait_for(client.recv(), timeout=2))
                    assert event["type"] == "telemetry"
                    assert event["sequence"] == 1
                    return
            except (OSError, ConnectionRefusedError) as exc:
                last_error = exc
                await asyncio.sleep(0.05)
        raise AssertionError(f"WebSocket server did not become ready: {last_error}")

    try:
        asyncio.run(scenario())
    finally:
        server.stop()


def test_authenticated_websocket_requires_token_and_delivers_authorized_stream():
    websockets = pytest.importorskip("websockets")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    hub = TelemetryHub()
    verifier = TokenVerifier(SECRET, "ucas-management", "ucas-telemetry")
    server = start_background_server(hub, port=port, verifier=verifier)

    async def scenario():
        uri = f"ws://127.0.0.1:{port}/ws?aircraft_id=sim-ucas-001&source=simulated"
        for _ in range(30):
            try:
                with pytest.raises(websockets.exceptions.ConnectionClosedError):
                    async with websockets.connect(uri) as client:
                        await client.recv()
                break
            except (OSError, ConnectionRefusedError):
                await asyncio.sleep(0.05)
        access_token = token(aircraft_ids=["sim-ucas-001"], sources=["simulated"])
        headers = {"Authorization": f"Bearer {access_token}"}
        async with websockets.connect(uri, additional_headers=headers) as client:
            hello = json.loads(await asyncio.wait_for(client.recv(), timeout=2))
            assert hello["authenticated_subject"] == "operator-1"
            hub.publish(build_stream_event(result()))
            event = json.loads(await asyncio.wait_for(client.recv(), timeout=2))
            assert event["type"] == "telemetry"

    try:
        asyncio.run(scenario())
    finally:
        server.stop()


def test_tls_context_requires_certificate_and_key_files(tmp_path):
    from services.telemetry_stream.tls import build_tls_context

    with pytest.raises(FileNotFoundError):
        build_tls_context(str(tmp_path / "missing.crt"), str(tmp_path / "missing.key"))
