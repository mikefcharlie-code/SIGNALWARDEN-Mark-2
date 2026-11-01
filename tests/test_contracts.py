import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("telemetry_simulator", ROOT / "simulation/generate_telemetry.py")
SIM = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SIM)


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def validator(name):
    contract = load_json(ROOT / f"packages/contracts/v1/{name}.schema.json")
    Draft202012Validator.check_schema(contract)
    return Draft202012Validator(contract, format_checker=FormatChecker())


class ContractTests(unittest.TestCase):
    def test_all_schemas_and_examples(self):
        for name in ("telemetry", "aircraft", "maintenance", "operational-event"):
            with self.subTest(contract=name):
                validator(name).validate(load_json(ROOT / f"packages/contracts/examples/{name}.json"))

    def test_invalid_telemetry_is_rejected(self):
        sample = load_json(ROOT / "packages/contracts/examples/telemetry.json")
        cases = []
        wrong = copy.deepcopy(sample)
        wrong["health"]["battery_percent"] = 101
        cases.append(wrong)
        wrong = copy.deepcopy(sample)
        wrong["timestamp"] = "not-a-dateZ"
        cases.append(wrong)
        wrong = copy.deepcopy(sample)
        wrong["source"] = "untrusted"
        cases.append(wrong)
        wrong = copy.deepcopy(sample)
        wrong["sequence"] = -1
        cases.append(wrong)
        wrong = copy.deepcopy(sample)
        wrong["command"] = "unexpected"
        cases.append(wrong)
        wrong = copy.deepcopy(sample)
        del wrong["aircraft_id"]
        cases.append(wrong)
        wrong = copy.deepcopy(sample)
        wrong["timestamp"] = "2026-01-01T00:00:00+00:00"
        cases.append(wrong)
        for i, case in enumerate(cases):
            with self.subTest(case=i), self.assertRaises(ValidationError):
                validator("telemetry").validate(case)

    def test_invalid_aircraft_and_maintenance_rejected(self):
        for name, field, invalid in [("aircraft", "lifecycle_status", "unknown"),
                                     ("maintenance", "status", "ready-to-fly"),
                                     ("aircraft", "aircraft_id", "invalid id")]:
            case = load_json(ROOT / f"packages/contracts/examples/{name}.json")
            case[field] = invalid
            with self.subTest(contract=name, field=field), self.assertRaises(ValidationError):
                validator(name).validate(case)

    def test_operational_event_rejects_control_fields(self):
        case = load_json(ROOT / "packages/contracts/examples/operational-event.json")
        case["command"] = {"type": "control"}
        with self.assertRaises(ValidationError):
            validator("operational-event").validate(case)

    def test_samples_valid_deterministic_and_ordered(self):
        samples = list(SIM.generate_samples(25))
        self.assertEqual(samples, list(SIM.generate_samples(25)))
        self.assertEqual(len(samples), 25)
        self.assertEqual([s["sequence"] for s in samples], list(range(25)))
        stamps = [s["timestamp"] for s in samples]
        self.assertEqual(stamps, sorted(set(stamps)))
        for sample in samples:
            validator("telemetry").validate(sample)
            self.assertEqual(sample["source"], "simulated")

    def test_generator_rejects_invalid_inputs(self):
        for count, identifier in [(0, "sim-001"), (-1, "sim-001"), (True, "sim-001"),
                                  (2, "invalid id"), (2, "")]:
            with self.subTest(count=count, identifier=identifier), self.assertRaises(ValueError):
                list(SIM.generate_samples(count, identifier))

    def test_cli_outputs_requested_samples(self):
        result = subprocess.run([sys.executable, str(ROOT / "simulation/generate_telemetry.py"),
                                 "--count", "3"], capture_output=True, text=True, check=True)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 3)
        for line in lines:
            validator("telemetry").validate(json.loads(line))

    def test_cli_invalid_count_exits_nonzero(self):
        result = subprocess.run([sys.executable, str(ROOT / "simulation/generate_telemetry.py"),
                                 "--count", "0"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
