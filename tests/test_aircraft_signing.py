from __future__ import annotations

import json
import os
import sys
import stat
import threading
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault("MAVLINK20", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pymavlink import mavutil

from services.aircraft_gateway import runner
from services.aircraft_gateway.security import EPOCH, IngressSecurity


KEY = os.urandom(32)  # ephemeral synthetic key; never printed or retained
NOW = EPOCH + 1_000.0


def args(tmp_path, **overrides):
    values = dict(source="aircraft", system_id=42, component_id=7,
                  signing_key_file=str(tmp_path / "key"),
                  signing_state_file=str(tmp_path / "state"),
                  initialize_signing_state=True, ingress_policy=None,
                  secure_transport_reference=None)
    values.update(overrides)
    return SimpleNamespace(**values)


def make_key(path, value=KEY, mode=0o600):
    path.write_bytes(value)
    path.chmod(mode)
    return path


def security(tmp_path, **overrides):
    key = tmp_path / "key"
    state = tmp_path / "state"
    make_key(key)
    state.parent.mkdir(mode=0o700, exist_ok=True)
    os.chmod(state.parent, 0o700)
    return IngressSecurity(args(tmp_path, **overrides), wall_clock=lambda: NOW)


class Link:
    """Small real pymavlink connection-shaped wrapper used by attach()."""
    WIRE_PROTOCOL_VERSION = "2.0"

    def __init__(self):
        self.mav = mavutil.mavlink.MAVLink(BytesIO(), srcSystem=42, srcComponent=7)

    def setup_signing(self, key, sign_outgoing=False, allow_unsigned_callback=None,
                      initial_timestamp=None, link_id=0):
        signing = self.mav.signing
        signing.secret_key = key
        signing.sign_outgoing = sign_outgoing
        signing.allow_unsigned_callback = allow_unsigned_callback
        signing.timestamp = initial_timestamp
        signing.link_id = link_id


def frame(*, timestamp, link_id=0, system_id=42, component_id=7,
          signed=True, force_v1=False):
    encoder = mavutil.mavlink.MAVLink(BytesIO(), srcSystem=system_id,
                                      srcComponent=component_id)
    encoder.signing.secret_key = KEY
    encoder.signing.sign_outgoing = signed
    encoder.signing.timestamp = timestamp
    encoder.signing.link_id = link_id
    message = encoder.heartbeat_encode(1, 2, 0, 0, 4, 3)
    return message.pack(encoder, force_mavlink1=force_v1)


def parse(link, packet):
    return link.mav.parse_char(packet)


def test_binary_key_requires_owned_regular_0600_and_exact_nonzero_32_bytes(tmp_path):
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    key = tmp_path / "key"
    for value, mode in ((b"x" * 32, 0o644), (b"x" * 31, 0o600),
                        (b"\0" * 32, 0o600)):
        make_key(key, value, mode)
        with pytest.raises(RuntimeError):
            IngressSecurity(args(tmp_path, initialize_signing_state=True), wall_clock=lambda: NOW)
    real = tmp_path / "real"
    make_key(real)
    key.unlink()
    key.symlink_to(real)
    with pytest.raises(RuntimeError):
        IngressSecurity(args(tmp_path, initialize_signing_state=True), wall_clock=lambda: NOW)


def test_defaults_and_transport_trust_are_explicit(tmp_path):
    sim = args(tmp_path, source="simulated", ingress_policy=None,
               signing_key_file=None, signing_state_file=None,
               initialize_signing_state=False)
    unauth = IngressSecurity(sim)
    assert unauth.policy == "unauthenticated"
    assert unauth.status()["telemetry_trust"] == "untrusted"
    transport = IngressSecurity(args(tmp_path, ingress_policy="secure-transport",
                                      signing_key_file=None, signing_state_file=None,
                                      initialize_signing_state=False,
                                      secure_transport_reference="operator-vpn-1"))
    assert transport.status()["telemetry_trust"] == "transport-asserted"
    with pytest.raises(RuntimeError):
        IngressSecurity(args(tmp_path, ingress_policy="secure-transport",
                             signing_key_file=None, signing_state_file=None))
    with pytest.raises(RuntimeError):
        IngressSecurity(args(tmp_path, ingress_policy=None, signing_key_file=None,
                             signing_state_file=None))


def test_aircraft_default_required_signed_needs_configuration(tmp_path):
    with pytest.raises(RuntimeError, match="required-signed"):
        IngressSecurity(args(tmp_path, signing_key_file=None, signing_state_file=None))


def test_attach_real_signed_and_unsigned_heartbeat_and_v1_rejection(tmp_path):
    sec = security(tmp_path)
    link = Link()
    sec.attach(link)
    signed = parse(link, frame(timestamp=sec.ticks() + 1))
    assert signed is not None and sec.accept(signed)
    with pytest.raises(Exception):
        parse(link, frame(timestamp=sec.ticks() + 2, signed=False))
    v1 = frame(timestamp=sec.ticks() + 3, force_v1=True)
    with pytest.raises(Exception):
        parse(link, v1)
    assert sec.counters["parser_rejected"] >= 1
    sec.close()


def test_accept_rejects_bad_data_and_unsigned_message_defense(tmp_path):
    sec = security(tmp_path)
    class Bad:
        def get_type(self): return "BAD_DATA"
    class Unsigned:
        def get_type(self): return "HEARTBEAT"
        def get_signed(self): return False
    assert not sec.accept(Bad())
    assert not sec.accept(Unsigned())
    sec.close()


@pytest.mark.parametrize("kind", ["bad_mac", "wrong_system", "wrong_component"])
def test_bad_mac_or_identity_is_rejected_without_advancing_replay_watermark(tmp_path, kind):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    packet = bytearray(frame(timestamp=sec.ticks() + 10))
    if kind == "bad_mac":
        packet[-1] ^= 0x01
    elif kind == "wrong_system":
        packet = frame(timestamp=sec.ticks() + 10, system_id=99)
    else:
        packet = frame(timestamp=sec.ticks() + 10, component_id=99)
    with pytest.raises(Exception):
        parse(link, bytes(packet))
    assert sec.store.streams == {}
    assert link.mav.signing.stream_timestamps == {}
    valid = parse(link, frame(timestamp=sec.ticks() + 10))
    assert valid is not None and sec.accept(valid)
    sec.close()


def test_duplicate_out_of_order_and_future_or_stale_frames_rejected(tmp_path):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    first = frame(timestamp=sec.ticks() + 20)
    assert sec.accept(parse(link, first))
    for packet in (first, frame(timestamp=sec.ticks() + 19),
                   frame(timestamp=sec.ticks() + 20 + 6_000_001)):
        with pytest.raises(Exception):
            parse(link, packet)
    assert sec.store.streams["0"] == sec.ticks() + 20
    sec.close()


def test_identity_link_ids_and_reconnect_parser_share_durable_ledger(tmp_path):
    sec = security(tmp_path)
    first = Link(); sec.attach(first)
    assert sec.accept(parse(first, frame(timestamp=sec.ticks() + 30, link_id=0)))
    assert sec.accept(parse(first, frame(timestamp=sec.ticks() + 1, link_id=1)))
    with pytest.raises(Exception):
        parse(first, frame(timestamp=sec.ticks() + 30, link_id=0))
    with pytest.raises(Exception):
        parse(first, frame(timestamp=sec.ticks() + 30, system_id=43))
    sec.close()
    resumed = IngressSecurity(args(tmp_path, initialize_signing_state=False), wall_clock=lambda: NOW)
    second = Link(); resumed.attach(second)
    with pytest.raises(Exception):
        parse(second, frame(timestamp=resumed.ticks() + 30, link_id=0))
    assert resumed.accept(parse(second, frame(timestamp=resumed.ticks() + 31, link_id=0)))
    resumed.close()


def test_process_reinstantiation_retains_duplicate_rejection(tmp_path):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    packet = frame(timestamp=sec.ticks() + 40, link_id=2)
    assert sec.accept(parse(link, packet)); sec.close()
    sec2 = IngressSecurity(args(tmp_path, initialize_signing_state=False), wall_clock=lambda: NOW)
    link2 = Link(); sec2.attach(link2)
    with pytest.raises(Exception):
        parse(link2, packet)
    sec2.close()


def test_malformed_frame_rejected(tmp_path):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    assert parse(link, b"\xfd\x01\x00") is None
    assert sec.counters["malformed"] == 0  # parser emits no message for truncated bytes
    class Malformed:
        def get_type(self): return "BAD_DATA"
    assert not sec.accept(Malformed())
    assert sec.counters["malformed"] == 1
    sec.close()


def test_ledger_missing_corrupt_or_wrong_binding_rejected_and_init_refuses_existing(tmp_path):
    sec = security(tmp_path); sec.close()
    with pytest.raises(RuntimeError, match="reinitialize"):
        IngressSecurity(args(tmp_path, initialize_signing_state=True), wall_clock=lambda: NOW)
    state = tmp_path / "state"
    state.write_text("not json")
    with pytest.raises(RuntimeError, match="invalid"):
        IngressSecurity(args(tmp_path, initialize_signing_state=False), wall_clock=lambda: NOW)
    state.write_text(json.dumps({"binding": {"wrong": 1}, "streams": {}}))
    with pytest.raises(RuntimeError, match="invalid"):
        IngressSecurity(args(tmp_path, initialize_signing_state=False), wall_clock=lambda: NOW)
    state.unlink()
    with pytest.raises(RuntimeError, match="missing"):
        IngressSecurity(args(tmp_path, initialize_signing_state=False), wall_clock=lambda: NOW)


def test_ledger_initialization_refuses_concurrent_lock(tmp_path):
    sec = security(tmp_path)
    with pytest.raises(RuntimeError, match="lock"):
        IngressSecurity(args(tmp_path, initialize_signing_state=False), wall_clock=lambda: NOW)
    sec.close()


def test_attach_requires_v2_parser(tmp_path):
    sec = security(tmp_path)
    bad = Link(); bad.WIRE_PROTOCOL_VERSION = "1.0"
    with pytest.raises(RuntimeError, match="MAVLink 2"):
        sec.attach(bad)
    sec.close()


@pytest.mark.parametrize("offset,accepted", [(-6_000_000, True), (-6_000_001, False),
                                              (6_000_000, True), (6_000_001, False)])
def test_every_signed_packet_obeys_inclusive_clock_window(tmp_path, offset, accepted):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    packet = frame(timestamp=sec.ticks() + offset)
    if accepted:
        assert sec.accept(parse(link, packet))
    else:
        with pytest.raises(Exception):
            parse(link, packet)
        assert not sec.store.streams
    sec.close()


def test_existing_stream_does_not_bypass_wall_clock_staleness(tmp_path):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    original = sec.ticks()
    assert sec.accept(parse(link, frame(timestamp=original)))
    sec.clock = lambda: NOW + 61
    with pytest.raises(Exception):
        parse(link, frame(timestamp=original + 1))
    assert sec.counters["timestamp_rejected"] == 1
    sec.close()


def test_durable_write_failure_stops_acceptance(tmp_path, monkeypatch):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    def broken_replace(*_):
        raise OSError("simulated storage failure")
    monkeypatch.setattr(os, "replace", broken_replace)
    with pytest.raises(RuntimeError, match="receiver stopped"):
        parse(link, frame(timestamp=sec.ticks()))
    assert sec.counters["signature_verified"] == 0
    sec.close()


def test_private_key_refuses_special_file_and_wrong_owner(tmp_path, monkeypatch):
    from services.aircraft_gateway.security import read_private
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo, 0o600)
    with pytest.raises(RuntimeError, match="regular"):
        read_private(fifo, 32)
    key = make_key(tmp_path / "key")
    real_uid = os.geteuid()
    monkeypatch.setattr(os, "geteuid", lambda: real_uid + 1)
    with pytest.raises(RuntimeError, match="owned"):
        read_private(key, 32)


@pytest.mark.parametrize("connection", ["udpin:0.0.0.0:14540", "tcp:192.0.2.1:5760", "udpin:example.com:14540"])
def test_unauthenticated_network_is_loopback_lab_only(tmp_path, connection):
    with pytest.raises(RuntimeError, match="loopback"):
        IngressSecurity(args(tmp_path, connection=connection, ingress_policy="unauthenticated",
            signing_key_file=None, signing_state_file=None, initialize_signing_state=False))


def test_unknown_message_parser_shortcut_never_bypasses_receive_gate(tmp_path):
    sec = security(tmp_path)
    link = Link(); sec.attach(link)
    packet = bytearray(frame(timestamp=sec.ticks()))
    # Pymavlink returns an unknown-message wrapper before signature checking.
    # It must never enter the mapper as a verified telemetry observation.
    packet[7:10] = (65535).to_bytes(3, "little")
    unknown = parse(link, packet)
    assert unknown is not None
    assert not sec.accept(unknown)
    assert sec.store.streams == {}
    assert sec.counters["signature_verified"] == 0
    sec.close()
