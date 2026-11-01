from __future__ import annotations

import errno
import os
import pty
import select
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.aircraft_gateway import runner

serial = pytest.importorskip("serial")
mavutil = pytest.importorskip("pymavlink.mavutil")


def _pty():
    master, slave = pty.openpty()
    return master, os.ttyname(slave), slave


def _readable(master, timeout=0.1):
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return b""
    try:
        return os.read(master, 4096)
    except OSError as exc:
        if exc.errno in (errno.EIO, errno.EBADF):
            return b""
        raise


def _heartbeat():
    message = mavutil.mavlink.MAVLink_heartbeat_message(
        type=2, autopilot=12, base_mode=0, custom_mode=0, system_status=4, mavlink_version=3
    )
    message._header.srcSystem = 1
    message._header.srcComponent = 1
    return message


def test_real_serial_factory_opens_and_closes_pty_without_writing():
    master, device, slave = _pty()
    try:
        link = runner._default_connection_factory(device, 115200)
        assert link.port.is_open
        link.close()
        assert not link.port.is_open
        assert _readable(master) == b""
    finally:
        os.close(master)
        os.close(slave)


def test_pty_producer_reaches_runner_mapper_and_runner_is_receive_only(capsys):
    master, device, slave = _pty()
    args = runner.build_parser().parse_args(
        [
            "--connection", device, "--aircraft-id", "pty-drone", "--autopilot", "px4",
            "--system-id", "1", "--source", "simulated", "--stdout", "--max-samples", "1",
            "--interval", "0.01",
        ]
    )
    error = []

    def run_gateway():
        try:
            runner.run(args)
        except BaseException as exc:  # surface failures from the worker thread
            error.append(exc)

    thread = threading.Thread(target=run_gateway)
    thread.start()
    time.sleep(0.1)
    producer = mavutil.mavlink.MAVLink(None)
    producer.srcSystem = 1
    producer.srcComponent = 1
    os.write(master, _heartbeat().pack(producer))
    thread.join(timeout=3)
    try:
        assert not thread.is_alive(), "runner did not publish from PTY input"
        assert not error
        output = capsys.readouterr().out
        assert '"aircraft_id":"pty-drone"' in output
        assert '"autopilot":{"family":"px4"' in output
        assert _readable(master) == b""
    finally:
        if thread.is_alive():
            # The runner owns the slave and will be cleaned up when the test
            # process exits; closing the PTY master unblocks a real read.
            os.close(master)
        else:
            os.close(master)
        os.close(slave)


def test_stable_symlink_replug_can_reopen_real_serial_transport(tmp_path: Path):
    link_path = tmp_path / "aircraft-serial"
    master1, device1, slave1 = _pty()
    master2, device2, slave2 = _pty()
    try:
        link_path.symlink_to(device1)
        first = runner._default_connection_factory(str(link_path), 115200)
        first.close()
        link_path.unlink()
        link_path.symlink_to(device2)
        second = runner._default_connection_factory(str(link_path), 115200)
        assert second.port.is_open
        second.close()
        assert _readable(master1) == b""
        assert _readable(master2) == b""
    finally:
        for fd in (master1, slave1, master2, slave2):
            try:
                os.close(fd)
            except OSError:
                pass


def test_ipv6_connection_is_rejected_before_transport_creation():
    for value in ("tcp:[::1]:5760", "udpin:[2001:db8::1]:14550", "tcp:2001:db8::1:5760"):
        with pytest.raises(Exception, match="IPv6.*not supported"):
            runner._connection(value)
    assert runner._connection("tcp:localhost:5760") == "tcp:localhost:5760"
    assert runner._connection("udpin:127.0.0.1:14550") == "udpin:127.0.0.1:14550"


def test_runner_recovers_pty_unplug_with_new_session(tmp_path, monkeypatch):
    master1, device1, slave1 = _pty()
    master2, device2, slave2 = _pty()
    path = tmp_path / "stable-serial"
    path.symlink_to(device1)
    samples, errors = [], []
    first_sample = threading.Event()
    opened_again = threading.Event()
    deadline = time.monotonic() + 6
    opens = []

    class Sink:
        def preflight(self, aircraft_id):
            pass

        def post(self, sample):
            samples.append(sample)
            first_sample.set()
            return True

    monkeypatch.setattr(runner, "_Sink", lambda *a, **kw: Sink())
    args = runner.build_parser().parse_args([
        "--connection", device1, "--aircraft-id", "pty-recovery", "--autopilot", "px4",
        "--system-id", "1", "--source", "simulated", "--max-samples", "2",
        "--interval", "0.1", "--heartbeat-timeout", "0.2",
    ])

    def factory(connection, baud):
        link = runner._default_connection_factory(str(path), baud)
        opens.append(link)
        if len(opens) > 1:
            opened_again.set()
        return link

    def clock():
        now = time.monotonic()
        if now > deadline:
            raise TimeoutError("bounded PTY test deadline")
        return now

    def receive():
        try:
            runner.run(args, connection_factory=factory, clock=clock)
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(target=receive, daemon=True)
    worker.start()
    encoder = mavutil.mavlink.MAVLink(None, srcSystem=1, srcComponent=1)
    frame = _heartbeat().pack(encoder)
    try:
        until = time.monotonic() + 2
        while not first_sample.is_set() and time.monotonic() < until:
            os.write(master1, frame)
            first_sample.wait(.025)
        assert first_sample.is_set()
        # Master close creates a real pyserial read error, not a fake factory exception.
        os.close(master1)
        master1 = None
        os.close(slave1)
        slave1 = None
        path.unlink()
        path.symlink_to(device2)
        assert opened_again.wait(2)
        until = time.monotonic() + 2
        while worker.is_alive() and time.monotonic() < until:
            os.write(master2, frame)
            worker.join(.025)
        assert not worker.is_alive()
        assert not errors
        assert len(samples) == 2
        assert samples[0]["session_id"] != samples[1]["session_id"]
        assert all(sample["autopilot"]["armed"] is False for sample in samples)
        assert _readable(master2) == b""
    finally:
        for fd in (master1, slave1, master2, slave2):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        worker.join(timeout=7)
