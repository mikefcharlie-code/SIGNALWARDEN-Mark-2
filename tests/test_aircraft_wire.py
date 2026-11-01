"""Synthetic wire producers, NOT PX4/ArduPilot SITL or hardware validation."""
import importlib
import importlib.util
import json
import socket
import subprocess
import sys
import threading
import time
from http.client import HTTPConnection
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services/management-api"))
pytest.importorskip("pymavlink", reason="install requirements-aircraft.txt for wire tests")


@pytest.fixture
def api():
    spec = importlib.util.spec_from_file_location("wire_test_api", ROOT / "services/management-api/app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    app.STORE = app.InMemoryStore()
    server = app.create_server("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("version", ["v10", "v20"])
@pytest.mark.parametrize("family,autopilot,vehicle", [("px4", 12, 2), ("ardupilot", 3, 1)])
def test_real_mavlink_frames_reach_api_without_outbound_mavlink(api, version, family, autopilot, vehicle):
    mav = importlib.import_module(f"pymavlink.dialects.{version}.common")
    encoder = mav.MAVLink(None, srcSystem=1, srcComponent=1)
    wrong = mav.MAVLink(None, srcSystem=42, srcComponent=1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reserve:
        reserve.bind(("127.0.0.1", 0))
        udp_port = reserve.getsockname()[1]
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as producer:
        producer.bind(("127.0.0.1", 0))
        producer.settimeout(0.1)
        process = subprocess.Popen([
            sys.executable, "-m", "services.aircraft_gateway",
            "--connection", f"udpin:127.0.0.1:{udp_port}",
            "--aircraft-id", "sim-ucas-001", "--autopilot", family,
            "--system-id", "1", "--source", "simulated",
            "--api-url", f"http://127.0.0.1:{api}",
            "--interval", "0.1", "--max-samples", "3",
        ], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        heartbeat = mav.MAVLink_heartbeat_message(vehicle, autopilot, 128, 7, 4, 3)
        status = mav.MAVLink_sys_status_message(1, 1, 1, 100, 12300, -1, 78, 0, 0, 0, 0, 0, 0)
        position = mav.MAVLink_global_position_int_message(1000, 100000000, 200000000, 123400, 3400, 100, -200, 30, 65535)
        stop = threading.Event()
        def transmit():
            while not stop.is_set():
                for msg, enc in ((heartbeat, encoder), (status, encoder), (position, encoder),
                                 (heartbeat, wrong), (status, wrong)):
                    producer.sendto(msg.pack(enc), ("127.0.0.1", udp_port))
                stop.wait(0.02)
        sender = threading.Thread(target=transmit, daemon=True)
        sender.start()
        try:
            stdout, stderr = process.communicate(timeout=8)
            assert process.returncode == 0, stderr
            assert not stdout  # API mode does not dump locations into logs.
            # The listener must not send even a heartbeat or stream-rate command.
            with pytest.raises(socket.timeout):
                producer.recvfrom(4096)
        finally:
            stop.set()
            sender.join(timeout=2)
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=2)
    conn = HTTPConnection("127.0.0.1", api, timeout=2)
    try:
        conn.request("GET", "/api/v1/aircraft/sim-ucas-001/telemetry/latest?source=simulated")
        response = conn.getresponse()
        assert response.status == 200
        latest = json.loads(response.read())
    finally:
        conn.close()
    sample = latest["sample"]
    assert sample["schema_version"] == "1.1"
    assert sample["source"] == "simulated"
    assert sample["autopilot"]["family"] == family
    assert sample["autopilot"]["system_id"] == 1
    assert sample["autopilot"]["vehicle_type"] == vehicle
    assert sample["autopilot"]["armed"] is True
    assert sample["health"]["battery_voltage_v"] == 12.3
    assert sample["health"]["battery_percent"] == 78
    assert sample["health"]["link_quality_percent"] is None
    assert sample["position"]["latitude_deg"] == 10
    assert sample["position"]["altitude_msl_m"] == 123.4
    assert sample["position"]["heading_deg"] is None
    assert latest["freshness"] == "fresh"
    assert sample["source_id"].startswith("mavlink-")
