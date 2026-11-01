"""Synthetic socket regressions only; not autopilot SITL or hardware validation."""
from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.aircraft_gateway import runner
from services.aircraft_gateway.mapper import TelemetryMapper


def test_real_tcp_orderly_close_reconnect_is_receive_only_and_stdout_is_jsonl():
    pytest.importorskip("pymavlink")
    mav = importlib.import_module("pymavlink.dialects.v20.common")
    encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    def heartbeat(mode):
        return mav.MAVLink_heartbeat_message(2, 12, 0, mode, 4, 3).pack(encoder)
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen(2)
        server.settimeout(5)
        process = subprocess.Popen([
            sys.executable, "-m", "services.aircraft_gateway",
            "--connection", f"tcp:127.0.0.1:{server.getsockname()[1]}",
            "--aircraft-id", "drone-1", "--autopilot", "px4", "--system-id", "1",
            "--source", "simulated", "--stdout", "--interval", "0.1", "--max-samples", "2",
        ], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with server.accept()[0] as first:
                first.sendall(heartbeat(11))
                assert select.select([process.stdout], [], [], 5)[0]
                sample1 = json.loads(process.stdout.readline())
                assert sample1["autopilot"]["custom_mode"] == 11
                # An orderly FIN, not an artificial EOFError from a fake.
                first.shutdown(socket.SHUT_WR)
                first.settimeout(2)
                assert first.recv(4096) == b""  # No outbound MAVLink.
            with server.accept()[0] as second:
                # Ordinary no-message timeouts must NOT be treated as EOF.
                second.settimeout(0.4)
                with pytest.raises(socket.timeout):
                    second.recv(4096)
                second.sendall(heartbeat(22))
                remaining, stderr = process.communicate(timeout=5)
            assert process.returncode == 0, stderr
            lines = remaining.splitlines()
            assert len(lines) == 1
            sample2 = json.loads(lines[0])
            assert sample2["autopilot"]["custom_mode"] == 22
            assert sample2["session_id"] != sample1["session_id"]
            assert sample2["sequence"] == 0
            assert "MAVLink connection lost (EOFError)" in stderr
            assert "EOF on TCP socket" not in remaining
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)


def test_slow_sink_does_not_delay_receive_or_refresh_expired_heartbeat(monkeypatch):
    pytest.importorskip("pymavlink")
    mav = importlib.import_module("pymavlink.dialects.v20.common")
    encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    heartbeat = mav.MAVLink_heartbeat_message(2, 12, 0, 7, 4, 3).pack(encoder)
    attitude = mav.MAVLink_attitude_message(1000, 0.1, 0.2, 0.3, 0, 0, 0).pack(encoder)
    entered, release, observed, connected = (threading.Event() for _ in range(4))
    samples, observations, result, errors = [], [], [], []

    class Mapper(TelemetryMapper):
        def accept(self, message, now=None):
            ok = super().accept(message, now=now)
            if message.get_type() == "ATTITUDE" and ok:
                observations.append(now)
                observed.set()
            return ok

    def post(_sink, sample):
        samples.append(sample)
        if len(samples) == 1:
            entered.set()
            assert release.wait(3)
        return True

    monkeypatch.setattr(runner._Sink, "preflight", lambda *_: None)
    monkeypatch.setattr(runner._Sink, "post", post)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    args = SimpleNamespace(connection=f"udpin:127.0.0.1:{port}", aircraft_id="drone-1",
                           autopilot="px4", system_id=1, component_id=1,
                           source="simulated", baud=115200, api_url="http://127.0.0.1:8000",
                           interval=0.01, heartbeat_timeout=0.2, field_timeout=0.15,
                           battery_id=0, stdout=False, max_samples=2)
    mapper = Mapper("drone-1", "px4", 1, heartbeat_timeout=0.2, field_timeout=0.15)
    def connect(*params):
        link = runner._default_connection_factory(*params)
        connected.set()
        return link
    def run():
        try:
            result.append(runner.run(args, connection_factory=connect, mapper_factory=lambda: mapper))
        except BaseException as exc:
            errors.append(exc)
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        assert connected.wait(3)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            sender.sendto(heartbeat, ("127.0.0.1", port))
            assert entered.wait(3)
            sent_at = time.monotonic()
            sender.sendto(heartbeat + attitude, ("127.0.0.1", port))
            # Receive must continue while the publisher is still blocked.
            assert observed.wait(0.4)
            assert observations[0] - sent_at < 0.2
            time.sleep(0.6)
            assert mapper.snapshot() is None  # 200 ms heartbeat expired during 600 ms stall.
            release.set()
            time.sleep(0.35)
            assert len(samples) == 1  # Coalesced request cannot replay a stale snapshot.
            sender.sendto(heartbeat, ("127.0.0.1", port))
            thread.join(timeout=3)
        assert not thread.is_alive()
        assert not errors
        assert result == [2]
        assert len(samples) == 2
        assert samples[1]["session_id"] != samples[0]["session_id"]
        assert "attitude" not in samples[1]  # Old sensors were not re-observed at post time.
    finally:
        release.set()


def test_publisher_coalesces_backlog_and_snapshots_only_at_dispatch():
    entered, release = threading.Event(), threading.Event()
    calls = []
    state = {"value": 1}
    def snapshot():
        return dict(state)
    class Sink:
        def post(self, sample):
            calls.append(sample)
            if len(calls) == 1:
                entered.set()
                assert release.wait(3)
            return True
    publisher = runner._Publisher(snapshot, Sink(), False, 2)
    try:
        publisher.request()
        assert entered.wait(2)
        for value in range(2, 1002):
            state["value"] = value
            publisher.request()
        release.set()
        assert publisher.done.wait(2)
        assert publisher.error is None
        assert calls == [{"value": 1}, {"value": 1001}]
        assert publisher.emitted == 2
    finally:
        release.set()
        publisher.close()


@pytest.mark.skipif(os.name != "posix", reason="POSIX file protection contract")
@pytest.mark.parametrize("mode", [0o644, 0o640, 0o666, 0o400, 0o700])
def test_token_file_rejects_permissions_other_than_0600(tmp_path, mode):
    path = tmp_path / "publisher.token"
    path.write_text("T" * 32)
    path.chmod(mode)
    with pytest.raises(RuntimeError, match="mode 0600"):
        runner._read_publisher_token(path)


def test_token_file_accepts_owned_0600_and_rejects_symlink_and_wrong_owner(tmp_path, monkeypatch):
    path = tmp_path / "publisher.token"
    path.write_text("T" * 32 + "\n")
    path.chmod(0o600)
    assert runner._read_publisher_token(path) == "T" * 32
    link = tmp_path / "link"
    link.symlink_to(path)
    with pytest.raises(RuntimeError, match="could not be read"):
        runner._read_publisher_token(link)
    real_fstat = runner.os.fstat
    def other_owner(fd):
        info = real_fstat(fd)
        return SimpleNamespace(st_mode=info.st_mode, st_uid=info.st_uid + 1)
    monkeypatch.setattr(runner.os, "fstat", other_owner)
    with pytest.raises(RuntimeError, match="owned regular file"):
        runner._read_publisher_token(path)


def test_token_file_rejects_special_files_and_invalid_contents(tmp_path):
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo, 0o600)
    with pytest.raises(RuntimeError, match="regular file"):
        runner._read_publisher_token(fifo)
    path = tmp_path / "token"
    for token in ("short", "T" * 32 + " space", "é" * 32, "T" * 5000):
        path.write_text(token)
        path.chmod(0o600)
        with pytest.raises(RuntimeError, match="invalid"):
            runner._read_publisher_token(path)


def test_token_file_unsupported_platform_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.os, "name", "nt")
    with pytest.raises(RuntimeError, match="supported POSIX"):
        runner._read_publisher_token(tmp_path / "token")
