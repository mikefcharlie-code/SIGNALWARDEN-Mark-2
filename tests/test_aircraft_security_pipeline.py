"""Synthetic signing receiver acceptance, NOT provisioned firmware or flight evidence."""
import copy
import importlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.client import HTTPConnection
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from test_aircraft_wire import api  # isolated registered in-memory API fixture
from services.aircraft_gateway.mapper import TelemetryMapper
from services.aircraft_gateway.security import EPOCH

ROOT = Path(__file__).resolve().parents[1]


def read_latest(port):
    conn = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        conn.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry/latest?source=simulated")
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


@pytest.mark.parametrize("family,autopilot", [("px4", 12), ("ardupilot", 3)])
def test_required_signed_wire_rejects_spoofs_then_publishes_without_transmission(api, tmp_path, monkeypatch, family, autopilot):
    mav = importlib.import_module("pymavlink.dialects.v20.common")
    key = os.urandom(32)
    key_path = tmp_path / "key"
    key_path.write_bytes(key)
    key_path.chmod(0o600)
    replay_dir = tmp_path / "replay"
    replay_dir.mkdir(mode=0o700)
    publisher_token = os.urandom(32).hex()
    token_path = tmp_path / "publisher.token"
    token_path.write_text(publisher_token)
    token_path.chmod(0o600)
    publishers = tmp_path / "publishers.json"
    publishers.write_text(json.dumps({"signed-test": {"token": publisher_token,
        "aircraft_ids": ["sim-ucas-001"], "sources": ["simulated"],
        "ingress_policies": ["required-signed"]}}))
    monkeypatch.setenv("UCAS_TELEMETRY_PUBLISHERS_FILE", str(publishers))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as producer:
        producer.bind(("127.0.0.1", 0))
        producer.settimeout(.1)
        process = subprocess.Popen([
            sys.executable, "-m", "services.aircraft_gateway", "--connection", f"udpin:127.0.0.1:{port}",
            "--aircraft-id", "sim-ucas-001", "--autopilot", family, "--system-id", "1",
            "--source", "simulated", "--ingress-policy", "required-signed",
            "--signing-key-file", str(key_path), "--signing-state-file", str(replay_dir / "state.json"),
            "--initialize-signing-state", "--api-url", f"http://127.0.0.1:{api}",
            "--publisher-id", "signed-test", "--publisher-token-file", str(token_path),
            "--interval", ".1", "--max-samples", "3",
        ], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
        encoder.signing.secret_key = key
        encoder.signing.sign_outgoing = True
        encoder.signing.timestamp = int((time.time() - EPOCH) * 100000)
        heartbeat = mav.MAVLink_heartbeat_message(2, autopilot, 0, 0, 3, 3)
        unsigned = heartbeat.pack(mav.MAVLink(None, srcSystem=1, srcComponent=1))
        stop = threading.Event()
        sender = None
        try:
            # Only spoofable unsigned frames: must not create any API sample.
            end = time.monotonic() + .5
            while time.monotonic() < end:
                producer.sendto(unsigned, ("127.0.0.1", port))
                time.sleep(.02)
            code, empty = read_latest(api)
            assert code == 200
            assert empty["sample"] is None
            assert empty["freshness"] == "missing"
            valid = heartbeat.pack(encoder)
            # Invalid high-timestamp MAC must not poison the durable watermark.
            wrong = mav.MAVLink(None, srcSystem=1, srcComponent=1)
            wrong.signing.secret_key = os.urandom(32)
            wrong.signing.sign_outgoing = True
            wrong.signing.timestamp = encoder.signing.timestamp + 5_000_000
            invalid = heartbeat.pack(wrong)
            producer.sendto(invalid, ("127.0.0.1", port))
            producer.sendto(valid, ("127.0.0.1", port))
            producer.sendto(valid, ("127.0.0.1", port))  # duplicate
            status = mav.MAVLink_sys_status_message(1, 1, 1, 100, 12300, -1, 78, 0, 0, 0, 0, 0, 0)
            def transmit():
                while not stop.is_set():
                    for message in (heartbeat, status):
                        producer.sendto(message.pack(encoder), ("127.0.0.1", port))
                    stop.wait(.02)
            sender = threading.Thread(target=transmit, daemon=True)
            sender.start()
            stdout, stderr = process.communicate(timeout=8)
            assert process.returncode == 0, stderr
            assert stdout == ""
            with pytest.raises(socket.timeout):
                producer.recvfrom(4096)
        finally:
            stop.set()
            if sender:
                sender.join(timeout=2)
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=2)
    code, latest = read_latest(api)
    assert code == 200
    security = latest["sample"]["ingress_security"]
    assert security["telemetry_trust"] == latest["telemetry_trust"] == "signature-verified"
    assert security["flight_ready"] is latest["flight_ready"] is False
    assert security["counters"]["bad_signature"] >= 1
    assert security["counters"]["replay_rejected"] >= 1
    assert security["counters"]["parser_rejected"] >= 1
    assert latest["sample"]["autopilot"]["armed"] is False
    assert latest["sample"]["health"]["battery_voltage_v"] == 12.3
    # No secret is emitted as a log value, binary repr, or common encoding.
    import base64
    assert key.hex() not in stderr
    assert base64.b64encode(key).decode() not in stderr


def mapped_sample():
    mav = importlib.import_module("pymavlink.dialects.v20.common")
    parser = mav.MAVLink(None)
    encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    heartbeat = parser.parse_char(mav.MAVLink_heartbeat_message(2, 12, 0, 0, 3, 3).pack(encoder))
    mapper = TelemetryMapper("sim-ucas-001", "px4", 1)
    mapper.accept(heartbeat)
    return mapper.snapshot()


@pytest.mark.parametrize("trust", ["signature-verified", "transport-asserted"])
def test_contract_forbids_authenticated_label_on_unauthenticated_telemetry(trust):
    sample = mapped_sample()
    sample["ingress_security"] = {"policy": "unauthenticated", "telemetry_trust": trust,
                                  "flight_ready": False, "counters": {}}
    validator = Draft202012Validator(json.loads((ROOT / "packages/contracts/v1/telemetry.schema.json").read_text()))
    with pytest.raises(ValidationError):
        validator.validate(sample)
    sample["ingress_security"]["telemetry_trust"] = "untrusted"
    validator.validate(sample)
    sample["ingress_security"]["flight_ready"] = True
    with pytest.raises(ValidationError):
        validator.validate(sample)


def test_api_trust_is_separate_from_freshness_and_missing_metadata_is_untrusted():
    sys.path.insert(0, str(ROOT / "services/management-api"))
    from telemetry_policy import compute_freshness
    sample = mapped_sample()
    assert compute_freshness(sample, sample["received_at"])["telemetry_trust"] == "untrusted"
    sample["ingress_security"] = {"policy": "unauthenticated", "telemetry_trust": "signature-verified"}
    view = compute_freshness(sample, sample["received_at"])
    assert view["connectivity"] == "live"
    assert view["telemetry_trust"] == "untrusted"
    assert view["flight_ready"] is False
    sample["ingress_security"] = {"policy": "secure-transport", "telemetry_trust": "transport-asserted"}
    view = compute_freshness(sample, sample["received_at"])
    assert view["telemetry_trust"] == "transport-asserted"
    assert view["flight_ready"] is False


# Exercise the HTTP boundary: schema consistency is not publisher provenance.
from test_aircraft_ingestion_security import security_api, app as security_app


@pytest.mark.parametrize("policy,trust", [("required-signed", "signature-verified"),
                                          ("secure-transport", "transport-asserted")])
def test_http_cannot_self_attest_authenticated_ingress(security_api, tmp_path, monkeypatch, policy, trust):
    sample = mapped_sample()
    sample["ingress_security"] = {"policy": policy, "telemetry_trust": trust,
                                  "flight_ready": False, "counters": {}}
    # Open synthetic publishing is not authority to claim authentication.
    code, result = security_api(sample)
    assert code == 403
    assert result["error"]["code"] == "ingress_policy_not_authorized"
    assert security_app.STORE.telemetry == []
    token = os.urandom(32).hex()
    entry = {"token": token, "aircraft_ids": [sample["aircraft_id"]], "sources": ["simulated"]}
    config = tmp_path / "publishers.json"
    config.write_text(json.dumps({"gateway": entry}))
    monkeypatch.setenv("UCAS_TELEMETRY_PUBLISHERS_FILE", str(config))
    headers = {"X-Source-ID": "gateway", "Authorization": "Bearer " + token}
    # An authenticated but unconfigured gateway still cannot assert trust.
    assert security_api(sample, headers)[0] == 403
    assert security_app.STORE.telemetry == []
    entry["ingress_policies"] = [policy]
    config.write_text(json.dumps({"gateway": entry}))
    assert security_api(sample, headers)[0] == 202
    assert len(security_app.STORE.telemetry) == 1
    # Revocation is read on the next request; no stale policy cache.
    entry["ingress_policies"] = ["unauthenticated"]
    config.write_text(json.dumps({"gateway": entry}))
    assert security_api(sample, headers)[0] == 403
    assert len(security_app.STORE.telemetry) == 1


def test_http_unsigned_lab_telemetry_stays_untrusted(security_api):
    sample = mapped_sample()
    sample["ingress_security"] = {"policy": "unauthenticated", "telemetry_trust": "untrusted",
                                  "flight_ready": False, "counters": {}}
    assert security_api(sample)[0] == 202
    view = security_app.STORE.current_view(sample["aircraft_id"])
    assert view["telemetry_trust"] == "untrusted"
    assert view["flight_ready"] is False


def test_real_gateway_process_restart_keeps_replay_watermark(tmp_path):
    import selectors
    mav = importlib.import_module("pymavlink.dialects.v20.common")
    key = os.urandom(32)
    key_path = tmp_path / "key"
    key_path.write_bytes(key); key_path.chmod(0o600)
    replay = tmp_path / "replay"
    replay.mkdir(mode=0o700)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reserve:
        reserve.bind(("127.0.0.1", 0)); port = reserve.getsockname()[1]
    command = [sys.executable, "-m", "services.aircraft_gateway", "--connection", f"udpin:127.0.0.1:{port}",
        "--aircraft-id", "synthetic-restart", "--autopilot", "px4", "--system-id", "1",
        "--source", "simulated", "--ingress-policy", "required-signed", "--stdout", "--max-samples", "1",
        "--signing-key-file", str(key_path), "--signing-state-file", str(replay / "state.json"),
        "--interval", ".05"]
    encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    encoder.signing.secret_key = key; encoder.signing.sign_outgoing = True
    encoder.signing.timestamp = int((time.time() - EPOCH) * 100000)
    heartbeat = mav.MAVLink_heartbeat_message(2, 12, 0, 0, 3, 3)
    old = heartbeat.pack(encoder)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as producer:
        producer.bind(("127.0.0.1", 0)); producer.settimeout(.1)
        for iteration in range(2):
            process = subprocess.Popen(command + (["--initialize-signing-state"] if iteration == 0 else []),
                cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                # Repeated startup sends avoid a fragile port-ready timing assumption.
                end = time.monotonic() + .5
                while time.monotonic() < end and process.poll() is None:
                    producer.sendto(old, ("127.0.0.1", port)); time.sleep(.02)
                if iteration:
                    assert process.poll() is None  # old verified packet cannot publish again
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        assert not selector.select(timeout=.05)
                    new = heartbeat.pack(encoder)
                    for _ in range(5):
                        producer.sendto(new, ("127.0.0.1", port)); time.sleep(.02)
                stdout, stderr = process.communicate(timeout=5)
                assert process.returncode == 0, stderr
                sample = json.loads(stdout)
                assert sample["ingress_security"]["telemetry_trust"] == "signature-verified"
                if iteration:
                    assert sample["ingress_security"]["counters"]["replay_rejected"] > 0
                with pytest.raises(socket.timeout):
                    producer.recvfrom(4096)
            finally:
                if process.poll() is None:
                    process.kill(); process.communicate(timeout=2)
