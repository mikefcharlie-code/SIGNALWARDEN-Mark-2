"""Read-only MAVLink telemetry gateway.

The module deliberately does not send any MAVLink messages.  ``run`` accepts
factories and clocks so the receive loop can be tested without hardware.
"""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import logging
import math
import os
import re
import stat
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

LOG = logging.getLogger("aircraft_gateway")


def _connection(value: str) -> str:
    if value.startswith(("udpin:", "tcp:")):
        kind, rest = value.split(":", 1)
        if kind == "udpin" and rest.lower().startswith(("udpout:", "broadcast:")):
            raise argparse.ArgumentTypeError("outbound/broadcast UDP is not allowed")
        host, sep, port = rest.rpartition(":")
        if not sep or not host or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise argparse.ArgumentTypeError("connection must be udpin:host:port or tcp:host:port")
        # pymavlink's TCP/UDP transports do not provide an IPv6 implementation
        # here. Reject literal IPv6 early; hostnames remain supported.
        literal_host = host[1:-1] if host.startswith("[") and host.endswith("]") else host
        try:
            if ipaddress.ip_address(literal_host).version == 6:
                raise argparse.ArgumentTypeError(
                    "IPv6 connections are not supported; use IPv4 or a hostname"
                )
        except ValueError:
            pass
        return value
    if re.fullmatch(r"/dev/tty[A-Za-z0-9_.-]*|/dev/pts/[0-9]+|/dev/serial/by-id/[A-Za-z0-9_.:-]+", value) and ".." not in Path(value).parts:
        return value
    raise argparse.ArgumentTypeError("connection must be udpin:host:port, tcp:host:port, or a serial device")


def _bounded_int(name, low, high):
    def parse(value):
        try:
            value_i = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{name} must be an integer")
        if not low <= value_i <= high:
            raise argparse.ArgumentTypeError(f"{name} must be {low}..{high}")
        return value_i
    return parse


def _positive(name):
    def parse(value):
        try:
            result = float(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{name} must be a number")
        if not math.isfinite(result) or result <= 0:
            raise argparse.ArgumentTypeError(f"{name} must be greater than zero")
        return result
    return parse


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Read-only PX4/ArduPilot MAVLink telemetry gateway")
    p.add_argument("--connection", required=True, type=_connection)
    p.add_argument("--aircraft-id", required=True)
    p.add_argument("--autopilot", required=True, choices=("px4", "ardupilot"))
    p.add_argument("--system-id", required=True, type=_bounded_int("system-id", 1, 255))
    p.add_argument("--component-id", type=_bounded_int("component-id", 1, 255), default=1)
    p.add_argument("--source", required=True, choices=("simulated", "aircraft"))
    p.add_argument("--baud", type=_bounded_int("baud", 1, 10_000_000), default=115200)
    p.add_argument("--api-url", default="http://127.0.0.1:8000")
    p.add_argument("--interval", type=_positive("interval"), default=1.0)
    p.add_argument("--heartbeat-timeout", type=_positive("heartbeat-timeout"), default=5.0)
    p.add_argument("--field-timeout", type=_positive("field-timeout"), default=5.0)
    p.add_argument("--battery-id", type=_bounded_int("battery-id", 0, 255), default=0)
    p.add_argument("--stdout", action="store_true", help="write samples as JSON lines instead of posting")
    p.add_argument("--max-samples", type=_bounded_int("max-samples", 1, 2**31 - 1))
    p.add_argument("--publisher-id", type=_publisher_id)
    p.add_argument("--publisher-token-file")
    p.add_argument("--ingress-policy", choices=("required-signed", "secure-transport", "unauthenticated"),
                   help="default: required-signed for aircraft, unauthenticated for simulation")
    p.add_argument("--signing-key-file", help="owned 0600 file containing exactly 32 binary key bytes")
    p.add_argument("--signing-state-file", help="durable replay ledger in a dedicated owned 0700 directory")
    p.add_argument("--initialize-signing-state", action="store_true", help="initialize a NEW ledger only")
    p.add_argument("--secure-transport-reference", help="operator-reviewed VPN/link deployment configuration reference")
    return p


def _loopback_api(url: str):
    """Return parsed URL, rejecting anything that could escape the local API."""
    parsed = urlsplit(url)
    if parsed.scheme != "http" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("--api-url must be an HTTP loopback URL without userinfo")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("--api-url must not contain a path, query, or fragment")
    host = parsed.hostname
    if not host:
        raise ValueError("--api-url must name a loopback host")
    try:
        address = ipaddress.ip_address(host)
        ok = address.is_loopback
    except ValueError:
        ok = host.lower() == "localhost"
    if not ok:
        raise ValueError("--api-url must use localhost or a literal loopback IP")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("--api-url has an invalid port") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("--api-url has an invalid port")
    return parsed


# Public spelling useful to callers validating configuration without starting
# the gateway; retained separately from the CLI's argparse validators.
validate_api_url = _loopback_api


@dataclass
class _Sink:
    parsed: object
    source_id: str
    token: str | None = None
    timeout: float = 3.0

    def _request(self, method, path, body=None):
        host = self.parsed.hostname
        port = self.parsed.port or 80
        conn = http.client.HTTPConnection(host, port, timeout=self.timeout)
        try:
            headers = {"Accept": "application/json", "X-Source-ID": self.source_id}
            if self.token is not None:
                headers["Authorization"] = "Bearer " + self.token
            if body is not None:
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            raw = response.read(1_000_000)
            return response.status, raw
        finally:
            conn.close()

    def preflight(self, aircraft_id):
        import urllib.parse
        try:
            status, _ = self._request("GET", "/api/v1/aircraft/" + urllib.parse.quote(aircraft_id, safe=""))
        except (OSError, http.client.HTTPException) as exc:
            raise RuntimeError("aircraft preflight is unavailable") from exc
        if status != 200:
            raise RuntimeError(f"aircraft preflight failed (HTTP {status})")

    def post(self, sample):
        body = json.dumps(sample, separators=(",", ":"), allow_nan=False).encode()
        # At most one bounded retry: never retain an unbounded stale queue.
        for attempt in range(2):
            try:
                status, raw = self._request("POST", "/api/v1/telemetry/ingest", body)
                if 200 <= status < 300:
                    return True
                if status < 500:
                    raise RuntimeError(f"telemetry sink rejected sample (HTTP {status})")
                if attempt:
                    LOG.warning("telemetry sink unavailable (%s)", "HTTPServerError")
            except (OSError, http.client.HTTPException) as exc:
                if attempt:
                    LOG.warning("telemetry sink unavailable (%s)", type(exc).__name__)
            if attempt == 0:
                time.sleep(0.1)
        return False


def _default_connection_factory(connection, baud):
    try:
        # Start with a v2-capable parser (also decodes v1). Auto-upgrading from
        # v1 on the first packet would silently replace signing configuration.
        os.environ["MAVLINK20"] = "1"
        import serial
        from pymavlink import mavutil
        mavutil.set_dialect("common")
    except ImportError as exc:
        raise RuntimeError(
            "pymavlink and pyserial are required; install requirements-aircraft.txt"
        ) from exc
    try:
        link = mavutil.mavlink_connection(connection, dialect="common", autoreconnect=False,
                                          baud=baud, retries=1)
    except serial.SerialException as exc:
        # Preserve the receive loop's recovery contract without masking other
        # programming errors.
        raise OSError(f"unable to open serial connection {connection}") from exc
    if connection.startswith("tcp:"):
        # pymavlink otherwise prints EOF repeatedly and returns no message while
        # keeping a dead socket with autoreconnect=False. Do not confuse an idle
        # recv_match timeout (also None) with EOF. Let our runner own recovery.
        def disconnected():
            raise EOFError("MAVLink TCP peer closed")
        link.handle_eof = disconnected
        link.handle_disconnect = disconnected
    return link


def _publisher_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise argparse.ArgumentTypeError("publisher-id must be a simple identifier")
    return value


def _read_publisher_token(path):
    if os.name != "posix":
        raise RuntimeError("publisher token permissions require a supported POSIX platform")
    try:
        # Open once, refusing symlinks; validate the actual descriptor rather
        # than racing a path stat against a separate read. Reject special files.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise RuntimeError("publisher token must be an owned regular file with mode 0600")
            token = stream.read(4097).strip()
    except (OSError, UnicodeError) as exc:
        raise RuntimeError("publisher token file could not be read") from exc
    if not 32 <= len(token) <= 4096 or not token.isascii() or any(character.isspace() for character in token):
        raise RuntimeError("publisher token is invalid")
    return token


class _Publisher:
    """One in-flight write plus one coalesced wakeup; never a sample backlog.

    Snapshot at dispatch, not enqueue: slow sinks cannot retimestamp queued
    packets or replay queued snapshots. Only the receiver mutates the mapper.
    """

    def __init__(self, snapshot, sink, stdout, max_samples):
        self.snapshot, self.sink, self.stdout = snapshot, sink, stdout
        self.max_samples = max_samples
        self.pending = threading.Event()
        self.stopping = threading.Event()
        self.done = threading.Event()
        self.emitted = 0
        self.error = None
        self.thread = threading.Thread(target=self._run, name="telemetry-publisher", daemon=True)
        self.thread.start()

    def request(self):
        self.pending.set()

    def _run(self):
        try:
            while not self.stopping.is_set():
                self.pending.wait()
                self.pending.clear()
                if self.stopping.is_set():
                    break
                sample = self.snapshot()
                if sample is None:
                    continue
                if self.stdout:
                    print(json.dumps(sample, separators=(",", ":"), allow_nan=False), flush=True)
                    ok = True
                else:
                    ok = self.sink.post(sample)
                if ok:
                    self.emitted += 1
                    if self.max_samples is not None and self.emitted >= self.max_samples:
                        break
        except Exception as exc:
            self.error = exc
        finally:
            self.done.set()

    def close(self):
        self.stopping.set()
        self.pending.set()
        # HTTP requests have a 3 s socket timeout and at most two attempts.
        # A broken stdout consumer must not keep the receiver alive forever.
        self.thread.join(timeout=7)


def run(args, connection_factory=None, mapper_factory=None, clock=None, sleep_fn=None):
    """Receive continuously until interrupted or max publications; reconnect EOF."""
    from .mapper import TelemetryMapper
    clock = clock or time.monotonic
    sleep_fn = sleep_fn or time.sleep
    connection_factory = connection_factory or _default_connection_factory
    mapper_factory = mapper_factory or (lambda: TelemetryMapper(
        args.aircraft_id, args.autopilot, args.system_id, component_id=args.component_id,
        source=args.source, heartbeat_timeout=args.heartbeat_timeout,
        field_timeout=args.field_timeout, battery_id=args.battery_id))
    # Construct the mapper first: this validates aircraft_id and all mapping
    # configuration before any API request or MAVLink connection is attempted.
    mapper = mapper_factory()
    parsed = None
    sink = None
    if not args.stdout:
        publisher_id = getattr(args, "publisher_id", None)
        publisher_token_file = getattr(args, "publisher_token_file", None)
        if bool(publisher_id) != bool(publisher_token_file):
            raise RuntimeError("publisher-id and publisher-token-file must be supplied together")
        if args.source == "aircraft" and not publisher_id:
            raise RuntimeError("real-aircraft API publishing requires publisher authentication")
        try:
            parsed = _loopback_api(args.api_url)
        except ValueError as exc:
            raise SystemExit(str(exc))
        token = _read_publisher_token(publisher_token_file) if publisher_token_file else None
        source_id = publisher_id or ("mavlink-" + uuid.uuid4().hex)
        sink = _Sink(parsed, source_id, token=token)
        sink.preflight(args.aircraft_id)
    from .security import IngressSecurity
    security = IngressSecurity(args)
    LOG.warning("MAVLink ingress policy=%s trust=%s flight_ready=false",
                security.policy, security.status()["telemetry_trust"])
    connection = None
    mapper_lock = threading.Lock()

    def snapshot():
        with mapper_lock:
            sample = mapper.snapshot(now=clock())
            if sample is not None:
                sample["ingress_security"] = security.status()
            return sample

    publisher = _Publisher(snapshot, sink, args.stdout, args.max_samples)
    next_emit = clock()
    retry_delay = 0.1
    try:
        while not publisher.done.is_set():
            if connection is None:
                try:
                    connection = connection_factory(args.connection, args.baud)
                    security.attach(connection)
                    retry_delay = 0.1
                except (OSError, EOFError) as exc:
                    LOG.warning("MAVLink connection unavailable (%s)", type(exc).__name__)
                    sleep_fn(retry_delay)
                    retry_delay = min(2.0, retry_delay * 2)
                    continue
            try:
                message = connection.recv_match(blocking=True, timeout=0.25)
                if message is not None and security.accept(message):
                    observed_at = clock()
                    with mapper_lock:
                        mapper.accept(message, now=observed_at)
                now = clock()
                if now >= next_emit:
                    next_emit = now + args.interval
                    publisher.request()
            except (OSError, EOFError) as exc:
                LOG.warning("MAVLink connection lost (%s)", type(exc).__name__)
                try:
                    connection.close()
                except Exception:
                    pass
                connection = None
                with mapper_lock:
                    mapper = mapper_factory()
                sleep_fn(retry_delay)
                retry_delay = min(2.0, retry_delay * 2)
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        publisher.close()
        LOG.warning("MAVLink ingress final status: %s", json.dumps(security.status(), sort_keys=True))
        security.close()
    if publisher.error is not None:
        raise publisher.error
    return publisher.emitted


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        run(args)
        return 0
    except KeyboardInterrupt:
        LOG.info("stopping telemetry gateway")
        return 0
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    main()
