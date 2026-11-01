"""Receive-only signing policy. Never provisions keys or sends MAVLink packets."""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import stat
import tempfile
import time
from collections import Counter
from pathlib import Path

EPOCH = 1420070400
WINDOW = 6_000_000  # one minute in MAVLink's 10 microsecond ticks


def read_private(path, limit):
    """Validate the opened descriptor, not a raceable path; never report contents."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600):
                raise RuntimeError("security file must be an owned regular file with mode 0600")
            value = stream.read(limit + 1)
        if len(value) > limit:
            raise RuntimeError("security file is too large")
        return value
    except OSError as exc:
        raise RuntimeError("security file could not be read safely") from exc


class ReplayStore:
    """Single-writer, atomic, fsynced high-water marks, committed BEFORE acceptance.

    Keep this dedicated 0700 directory on durable local storage. Missing state
    is created only with explicit initialization; deleting/rolling back state
    requires an operator-controlled key rotation, not automatic recovery.
    """

    def __init__(self, path, binding, initialize=False):
        self.path = Path(path).absolute()
        parent = self.path.parent
        try:
            info = parent.lstat()
        except OSError:
            raise RuntimeError("signing state directory is unavailable") from None
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise RuntimeError("signing state requires an owned mode 0700 directory")
        self.binding = binding
        self.lock_fd = None
        try:
            self.lock_fd = os.open(str(self.path) + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            lock_info = os.fstat(self.lock_fd)
            if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid()
                    or stat.S_IMODE(lock_info.st_mode) != 0o600):
                raise RuntimeError("invalid signing state lock permissions")
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists() or self.path.is_symlink():
                if initialize:
                    raise RuntimeError("refusing to reinitialize existing signing state")
                try:
                    document = json.loads(read_private(self.path, 65536))
                    self.streams = document["streams"]
                    if document["binding"] != binding or not isinstance(self.streams, dict):
                        raise ValueError()
                    if len(self.streams) > 256 or any(
                        not str(k).isdigit() or not 0 <= int(k) <= 255
                        or type(v) is not int or not 0 <= v < 2**48
                        for k, v in self.streams.items()
                    ):
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    raise RuntimeError("invalid or mismatched signing replay state") from None
            elif initialize:
                self.streams = {}
                self.save()
            else:
                raise RuntimeError("signing replay state missing; explicitly initialize a new deployment")
        except OSError:
            self.close()
            raise RuntimeError("signing replay state could not be opened or exclusively locked") from None
        except Exception:
            self.close()
            raise

    def save(self):
        name = None
        try:
            fd, name = tempfile.mkstemp(prefix=".replay-", dir=self.path.parent)
            with os.fdopen(fd, "w") as stream:
                json.dump({"binding": self.binding, "streams": self.streams}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            raise RuntimeError("unable to persist signing replay state; receiver stopped") from None
        finally:
            if name and os.path.exists(name):
                os.unlink(name)

    def close(self):
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None


class IngressSecurity:
    def __init__(self, args, wall_clock=None):
        self.clock = wall_clock or time.time
        self.policy = getattr(args, "ingress_policy", None) or (
            "required-signed" if args.source == "aircraft" else "unauthenticated")
        self.system_id, self.component_id = args.system_id, args.component_id
        self.counters = Counter()
        self.store = None
        self.key = None
        key_file = getattr(args, "signing_key_file", None)
        state_file = getattr(args, "signing_state_file", None)
        initialize = getattr(args, "initialize_signing_state", False)
        reference = getattr(args, "secure_transport_reference", None)
        if self.policy not in {"required-signed", "secure-transport", "unauthenticated"}:
            raise RuntimeError("invalid ingress policy")
        connection = getattr(args, "connection", "")
        if self.policy == "unauthenticated" and connection.startswith(("udpin:", "tcp:")):
            host = connection.split(":", 1)[1].rpartition(":")[0]
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                loopback = host.lower() == "localhost"
            if not loopback:
                raise RuntimeError("unauthenticated network ingress is restricted to isolated loopback")
        if self.policy == "required-signed":
            if not key_file or not state_file:
                raise RuntimeError("required-signed ingress requires signing-key-file and signing-state-file")
            self.key = read_private(key_file, 32)
            if len(self.key) != 32 or not any(self.key):
                raise RuntimeError("signing key must contain exactly 32 bytes and must not be all zero")
            binding = {"key_sha256": hashlib.sha256(self.key).hexdigest(),
                       "system_id": self.system_id, "component_id": self.component_id,
                       "aircraft_id": getattr(args, "aircraft_id", None),
                       "autopilot": getattr(args, "autopilot", None), "source": args.source,
                       "connection": getattr(args, "connection", None)}
            self.store = ReplayStore(state_file, binding, initialize)
            if reference:
                self.close()
                raise RuntimeError("secure-transport-reference requires secure-transport policy")
        else:
            if key_file or state_file or initialize:
                raise RuntimeError("signing files require required-signed ingress")
            if self.policy == "secure-transport" and (not reference or not reference.strip()):
                raise RuntimeError("secure-transport requires a deployment configuration reference")
            if reference and self.policy != "secure-transport":
                raise RuntimeError("secure-transport-reference requires secure-transport policy")

    def attach(self, connection):
        if self.policy != "required-signed":
            return
        # Force a v2-capable parser in the connection factory before attaching.
        # Version auto-switch otherwise replaces the configured signing object.
        if getattr(connection, "WIRE_PROTOCOL_VERSION", None) != "2.0":
            raise RuntimeError("required-signed ingress requires a MAVLink 2 parser")
        connection.setup_signing(self.key, sign_outgoing=False,
                                 allow_unsigned_callback=self._reject_unsigned,
                                 initial_timestamp=self.ticks(), link_id=0)
        # Pinned pymavlink 2.4.50 mutates stream_timestamps BEFORE checking
        # the MAC. Replace only its verification hook; retain its framing/CRC,
        # signed status, strict unsigned policy, and parser rejection behavior.
        connection.mav.check_signature = self.check_signature

    def ticks(self):
        now = self.clock()
        if not isinstance(now, (float, int)) or not EPOCH <= now < EPOCH + (2**48 / 100000):
            raise RuntimeError("trusted wall clock is required for signed ingress")
        return int((now - EPOCH) * 100000)

    def _reject_unsigned(self, _parser, _message_id):
        self.counters["parser_rejected"] += 1
        return False  # includes HEARTBEAT; no discovery or invalid-signature exception

    def check_signature(self, frame, system_id, component_id):
        if (system_id, component_id) != (self.system_id, self.component_id):
            self.counters["wrong_identity"] += 1
            return False
        if not hmac.compare_digest(hashlib.sha256(self.key + bytes(frame[:-6])).digest()[:6], bytes(frame[-6:])):
            self.counters["bad_signature"] += 1
            return False
        stamp = int.from_bytes(frame[-12:-6], "little")
        now = self.ticks()
        # Apply freshness to EVERY packet, not only a previously unseen stream.
        # Bound future signed timestamps too: a misclocked peer cannot poison
        # durable state indefinitely. This is stricter than base MAVLink.
        if abs(stamp - now) > WINDOW:
            self.counters["timestamp_rejected"] += 1
            return False
        link = str(frame[-13])
        if stamp <= self.store.streams.get(link, -1):
            self.counters["replay_rejected"] += 1
            return False
        self.store.streams[link] = stamp
        self.store.save()
        self.counters["signature_verified"] += 1
        return True

    def accept(self, message):
        if message.get_type() == "BAD_DATA":
            self.counters["malformed"] += 1
            return False
        if self.policy == "required-signed" and not message.get_signed():
            # Defense against parser replacement/unknown-message bypasses.
            self.counters["unsigned_rejected"] += 1
            return False
        return True

    def status(self):
        trust = {"required-signed": "signature-verified", "secure-transport": "transport-asserted",
                 "unauthenticated": "untrusted"}[self.policy]
        if self.policy == "required-signed" and not self.counters["signature_verified"]:
            trust = "untrusted"
        return {"policy": self.policy, "telemetry_trust": trust,
                "flight_ready": False, "counters": dict(self.counters)}

    def close(self):
        if self.store:
            self.store.close()
