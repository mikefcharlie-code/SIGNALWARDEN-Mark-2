#!/usr/bin/env python3
"""Disarmed passive firmware -> UDP relay -> gateway -> isolated API smoke test.

Does not issue MAVLink commands or arm. Firmware startup/configuration is supplied
explicitly by the operator as a JSON argv list. This is not failsafe/flight proof.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services/management-api"))


def stop(process, privileged=False):
    if process is None or process.poll() is not None:
        return
    if privileged:
        subprocess.run(["sudo", "-n", "kill", "-INT", "--", f"-{process.pid}"], check=False)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        if privileged:
            subprocess.run(["sudo", "-n", "kill", "-KILL", "--", f"-{process.pid}"], check=False)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", choices=["px4", "ardupilot"], required=True)
    parser.add_argument("--firmware-command-json", required=True)
    parser.add_argument("--firmware-cwd", type=Path, required=True)
    parser.add_argument("--ingress-port", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--capture", action="store_true", help="require sudo tcpdump loopback capture")
    args = parser.parse_args()
    command = json.loads(args.firmware_command_json)
    if not isinstance(command, list) or not command or not all(isinstance(v, str) for v in command):
        parser.error("firmware command must be a nonempty JSON string list")
    args.output.mkdir(parents=True, exist_ok=False)
    # This standalone validation process must never open operational storage
    # or inherit a real-aircraft publisher registry.
    os.environ.pop("UCAS_DATABASE_URL", None)
    os.environ.pop("UCAS_TELEMETRY_PUBLISHERS_FILE", None)
    os.environ["UCAS_FRESH_AFTER_SECONDS"] = "30"
    spec = importlib.util.spec_from_file_location("passive_validation_api", ROOT / "services/management-api/app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    app.STORE = app.InMemoryStore()
    aircraft_id = args.family + "-passive-validation"
    app.STORE.add_aircraft({"schema_version": "1.0", "aircraft_id": aircraft_id,
                            "display_name": "Passive SITL only", "lifecycle_status": "planned",
                            "hardware_revision": "simulated-not-aircraft"})
    server = app.create_server("127.0.0.1", 0)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    api_url = f"http://127.0.0.1:{server.server_address[1]}"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reserve:
        reserve.bind(("127.0.0.1", 0))
        gateway_port = reserve.getsockname()[1]
    relay = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    relay.bind(("127.0.0.1", args.ingress_port))
    relay.settimeout(.1)
    ending = threading.Event()
    counters = Counter()
    from pymavlink.dialects.v20 import common
    decoder = common.MAVLink(None)
    decoder.robust_parsing = True
    def forward():
        with (args.output / "firmware-mavlink.raw").open("wb") as raw:
            while not ending.is_set():
                try:
                    data, sender = relay.recvfrom(65535)
                except socket.timeout:
                    continue
                if sender[1] == gateway_port:
                    counters["gateway_outbound_datagrams"] += 1
                    continue
                counters["firmware_datagrams"] += 1
                raw.write(data)
                for message in decoder.parse_buffer(data) or []:
                    counters[message.get_type()] += 1
                    frame = message.get_msgbuf()
                    if message.get_type() != "BAD_DATA" and len(frame) >= 12 and frame[0] == 0xFD:
                        counters["v2_signed_flag" if frame[2] & 1 else "v2_unsigned_flag"] += 1
                relay.sendto(data, ("127.0.0.1", gateway_port))
    forward_thread = threading.Thread(target=forward, daemon=True)
    forward_thread.start()
    firmware = gateway = capture = None
    handles = []
    readbacks = []
    evidence = {"family": args.family, "firmware_command": command,
                "firmware_cwd": str(args.firmware_cwd), "ingress_port": args.ingress_port,
                "gateway_port": gateway_port, "api_url": api_url,
                "source": "simulated", "arming_or_control_commands_sent": False,
                "scope": "passive telemetry pipeline and feed-loss recovery only; not autopilot failsafe"}
    def output(name):
        handle = (args.output / name).open("w")
        handles.append(handle)
        return handle
    def launch(label):
        env = {key: value for key, value in os.environ.items() if not key.startswith("PX4_")}
        env.update(PX4_SIM_MODEL="none", PX4_SIMULATOR="none")
        return subprocess.Popen(command, cwd=args.firmware_cwd, env=env,
                                stdout=output(label), stderr=subprocess.STDOUT, start_new_session=True)
    def read(label):
        with urlopen(api_url + f"/api/v1/aircraft/{aircraft_id}/telemetry/latest?source=simulated", timeout=3) as response:
            view = json.load(response)
        readbacks.append({"phase": label, "view": view})
        (args.output / "api-readbacks.json").write_text(json.dumps(readbacks, indent=2) + "\n")
        return view
    def await_live(label, previous_session=None):
        end = time.monotonic() + 45
        while time.monotonic() < end:
            view = read(label)
            sample = view.get("sample")
            if (sample and view.get("connectivity") == "live"
                    and (previous_session is None or sample["session_id"] != previous_session)):
                assert sample["autopilot"]["family"] == args.family
                assert sample["autopilot"]["system_id"] == 1
                assert sample["autopilot"]["component_id"] == 1
                assert sample["autopilot"]["armed"] is False
                assert view["freshness"] == "fresh"
                assert view["telemetry_trust"] == "untrusted"
                assert view["flight_ready"] is False
                assert sample["ingress_security"]["policy"] == "unauthenticated"
                assert sample["ingress_security"]["telemetry_trust"] == "untrusted"
                assert sample["ingress_security"]["flight_ready"] is False
                return view
            if gateway.poll() is not None:
                raise AssertionError("gateway exited before live telemetry")
            time.sleep(.25)
        raise AssertionError("no live disarmed expected-family API sample within 45 seconds")
    try:
        if args.capture:
            capture = subprocess.Popen(["sudo", "-n", "tcpdump", "-i", "lo", "-s", "0", "-U", "-Z", "ubuntu",
                                        "-w", str(args.output / "loopback.pcap"),
                                        f"udp and (port {args.ingress_port} or port {gateway_port})"],
                                       stdout=output("tcpdump.log"), stderr=subprocess.STDOUT, start_new_session=True)
            time.sleep(.5)
            assert capture.poll() is None, "packet capture could not start"
        gateway = subprocess.Popen([str(ROOT / ".venv/bin/python"), "-m", "services.aircraft_gateway",
                                    "--connection", f"udpin:127.0.0.1:{gateway_port}",
                                    "--aircraft-id", aircraft_id, "--autopilot", args.family,
                                    "--system-id", "1", "--component-id", "1", "--source", "simulated",
                                    "--api-url", api_url, "--interval", "0.2",
                                    "--heartbeat-timeout", "2", "--field-timeout", "2"],
                                   cwd=ROOT, stdout=output("gateway.stdout"), stderr=output("gateway.log"), start_new_session=True)
        firmware = launch("firmware.log")
        first = await_live("initial")
        time.sleep(2)
        normal = await_live("normal")
        assert normal["sample"]["sequence"] > first["sample"]["sequence"]
        session = normal["sample"]["session_id"]
        stop(firmware)
        time.sleep(3.2)
        lost = read("firmware-stopped")
        assert lost["snapshot_freshness"] == "fresh", "snapshot should remain within the separate 30s snapshot window"
        assert lost["connectivity"] == "stale"
        assert lost["freshness"] == "stale"
        assert lost["telemetry_trust"] == "untrusted"
        assert lost["flight_ready"] is False
        stopped_sequence = lost["sample"]["sequence"]
        time.sleep(.6)
        assert read("loss-remains-stale")["sample"]["sequence"] == stopped_sequence
        firmware = launch("firmware-restart.log")
        recovered = await_live("recovered", session)
        assert recovered["sample"]["session_id"] != session
        evidence.update(passed=True, initial_session=session,
                        recovered_session=recovered["sample"]["session_id"],
                        loss_effective_heartbeat_age=lost["effective_ages"]["heartbeat"])
    except Exception as exc:
        evidence.update(passed=False, failure=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        stop(firmware)
        stop(gateway)
        stop(capture, privileged=True)
        ending.set()
        forward_thread.join(timeout=2)
        relay.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
        for handle in handles:
            handle.close()
        evidence["counts"] = dict(counters)
        evidence["gateway_outbound_datagrams"] = counters["gateway_outbound_datagrams"]
        if counters["gateway_outbound_datagrams"] or not counters["HEARTBEAT"]:
            evidence.update(passed=False, failure="unexpected outbound gateway traffic or missing heartbeat")
        (args.output / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    assert counters["gateway_outbound_datagrams"] == 0
    assert counters["HEARTBEAT"] > 0
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
