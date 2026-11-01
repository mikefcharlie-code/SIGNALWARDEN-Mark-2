from __future__ import annotations

import json
import math
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.aircraft_gateway import runner


def test_positive_requires_finite_positive_values():
    parse = runner._positive("interval")
    assert parse("0.5") == 0.5
    for value in ("0", "-1", "nan", "inf", "-inf"):
        with pytest.raises(Exception):
            parse(value)


def test_required_args_and_system_id_range():
    with pytest.raises(SystemExit):
        runner.build_parser().parse_args([])
    base = ["--connection", "tcp:localhost:5760", "--aircraft-id", "drone-1",
            "--autopilot", "px4", "--source", "simulated"]
    with pytest.raises(SystemExit):
        runner.build_parser().parse_args(base)
    for value in ("0", "256"):
        with pytest.raises(SystemExit):
            runner.build_parser().parse_args(base + ["--system-id", value])
    args = runner.build_parser().parse_args(base + ["--system-id", "1"])
    assert args.system_id == 1


@pytest.mark.parametrize("value", ["udpout:127.0.0.1:14550", "udpin:127.0.0.1:0",
                                    "tcp:127.0.0.1:65536", "tcp::1", "http://x"])
def test_connection_validation_rejects_unsafe_or_malformed_values(value):
    with pytest.raises(Exception):
        runner._connection(value)


def test_loopback_api_accepts_local_urls_and_rejects_paths_credentials_redirects():
    for value in ("http://127.0.0.1", "http://localhost:8080", "http://[::1]:8080"):
        assert runner.validate_api_url(value).scheme == "http"
    for value in ("https://127.0.0.1", "http://example.com", "http://127.0.0.1/x",
                  "http://user:pass@127.0.0.1", "http://127.0.0.1/?x=1"):
        with pytest.raises(ValueError):
            runner.validate_api_url(value)


def _server(handler):
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


class _RedirectHandler(BaseHTTPRequestHandler):
    seen = []
    def do_GET(self):
        self.__class__.seen.append(self.path)
        self.send_response(302)
        self.send_header("Location", "/redirected")
        self.end_headers()
    def log_message(self, *_):
        pass


def test_sink_does_not_follow_redirects():
    _RedirectHandler.seen = []
    server, thread = _server(_RedirectHandler)
    try:
        sink = runner._Sink(runner.validate_api_url(f"http://127.0.0.1:{server.server_port}"), "source")
        with pytest.raises(RuntimeError, match="HTTP 302"):
            sink.preflight("drone-1")
        assert _RedirectHandler.seen == ["/api/v1/aircraft/drone-1"]
    finally:
        server.shutdown(); thread.join()


def test_sink_permanent_rejection_is_not_retried_and_transient_retries_once(monkeypatch):
    sink = runner._Sink(runner.validate_api_url("http://127.0.0.1:1"), "source")
    calls = []
    monkeypatch.setattr(sink, "_request", lambda *args: (400, b"bad") if not calls.append(1) else (400, b"bad"))
    with pytest.raises(RuntimeError, match="HTTP 400"):
        sink.post({"value": 1})
    assert len(calls) == 1

    calls.clear()
    responses = iter([(503, b"bad"), (201, b"ok")])
    monkeypatch.setattr(sink, "_request", lambda *args: (calls.append(1) or next(responses)))
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    assert sink.post({"value": 1}) is True
    assert len(calls) == 2


def test_sink_serialization_rejects_nan(monkeypatch):
    sink = runner._Sink(runner.validate_api_url("http://127.0.0.1:1"), "source")
    with pytest.raises(ValueError):
        sink.post({"value": math.nan})


class _FakeConnection:
    def __init__(self):
        self.closed = False
    def recv_match(self, **kwargs):
        raise EOFError("connection ended")
    def close(self):
        self.closed = True


class _FakeMapper:
    def __init__(self, aircraft_id="drone-1"):
        self.aircraft_id = aircraft_id
    def accept(self, *_args, **_kwargs):
        return False
    def snapshot(self, **_kwargs):
        return None


def _args(**kwargs):
    defaults = dict(connection="tcp:127.0.0.1:5760", aircraft_id="drone-1", autopilot="px4",
                    system_id=1, component_id=1, source="simulated", baud=115200,
                    api_url="http://127.0.0.1:8000", interval=1.0, heartbeat_timeout=5.0,
                    field_timeout=5.0, battery_id=0, stdout=False, max_samples=1)
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def test_stdout_run_sends_none_and_closes_connection(monkeypatch, capsys):
    connection = _FakeConnection()
    calls = []
    def connect(*_):
        calls.append(1)
        if len(calls) > 1:
            raise KeyboardInterrupt()
        return connection
    with pytest.raises(KeyboardInterrupt):
        runner.run(_args(stdout=True), connection_factory=connect,
                           mapper_factory=lambda: _FakeMapper(), sleep_fn=lambda _: None)
    assert calls == [1, 1]
    assert connection.closed
    assert capsys.readouterr().out == ""


def test_mapper_is_constructed_before_preflight_and_invalid_aircraft_skips_network():
    events = []
    def mapper_factory():
        events.append("mapper")
        raise ValueError("invalid aircraft_id")
    with pytest.raises(ValueError):
        runner.run(_args(stdout=False), connection_factory=lambda *_: events.append("connection"),
                   mapper_factory=mapper_factory)
    assert events == ["mapper"]


def test_real_aircraft_api_requires_publisher_pair(tmp_path):
    with pytest.raises(RuntimeError, match="authentication"):
        runner.run(_args(source="aircraft"), mapper_factory=lambda: _FakeMapper())
    with pytest.raises(RuntimeError, match="together"):
        runner.run(_args(publisher_id="publisher-1"), mapper_factory=lambda: _FakeMapper())


def test_bearer_is_forwarded_and_token_is_not_stdout(monkeypatch, capsys, tmp_path):
    token = "T" * 32
    token_file = tmp_path / "token"
    token_file.write_text(token + "\n")
    captured = {}

    class Connection:
        def __init__(self, *_args, **_kwargs): pass
        def request(self, method, path, body=None, headers=None):
            captured.update(method=method, path=path, headers=headers, body=body)
        def getresponse(self):
            return SimpleNamespace(status=200, read=lambda _limit: b"{}")
        def close(self): pass

    monkeypatch.setattr(runner.http.client, "HTTPConnection", Connection)
    sink = runner._Sink(runner.validate_api_url("http://127.0.0.1:8000"), "publisher-1", token=token)
    assert sink.post({"aircraft_id": "drone-1"})
    assert captured["headers"]["Authorization"] == "Bearer " + token
    assert token not in capsys.readouterr().out


def test_reconnect_uses_fresh_mapper():
    class Conn:
        def __init__(self, n): self.n, self.closed = n, False
        def recv_match(self, **_):
            if self.n == 1: raise EOFError()
            return None
        def close(self): self.closed = True
    connections = []
    mappers = []
    def factory():
        mappers.append(_FakeMapper())
        return mappers[-1]
    def connect(*_):
        c = Conn(len(connections) + 1); connections.append(c); return c
    clock_values = iter([0, 0, 0, 0, 0, 0])
    # max_samples remains unmet, so stop after the second connection raises KeyboardInterrupt.
    def connect2(*_):
        if len(connections) >= 1: raise KeyboardInterrupt()
        return connect(*_)
    with pytest.raises(KeyboardInterrupt):
        runner.run(_args(stdout=True, max_samples=1), connection_factory=connect2,
                   mapper_factory=factory, sleep_fn=lambda _: None)
    assert len(mappers) == 2
    assert connections[0].closed
