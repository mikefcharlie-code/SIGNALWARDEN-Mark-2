import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("tracegate_engine", ROOT / "services" / "tracegate" / "tracegate_engine.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TracegateEngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = MODULE.make_demo_engine()

    def test_camera_change_closes_impact_and_selects_mapped_tests(self):
        result = self.engine.evaluate({
            "event_id": "TEST-CAMERA",
            "changed_nodes": ["component.camera"],
            "target_configuration_fingerprint": "cfg-test",
            "target_domain": "inspection",
            "test_results": {"T-CAL-01": "PASS", "T-PER-02": "PASS", "T-TIME-03": "PASS"},
        })
        self.assertIn("requirement.perception_quality", result["affected_requirements"])
        self.assertEqual(result["readiness_status"], "READY")

    def test_failed_required_test_blocks_unknown(self):
        result = self.engine.evaluate({
            "event_id": "TEST-FAIL",
            "changed_nodes": ["model.perception"],
            "target_configuration_fingerprint": "cfg-test",
            "target_domain": "inspection",
            "test_results": {"T-CAL-01": "PASS", "T-PER-02": "PASS", "T-LAT-04": "FAIL"},
        })
        self.assertEqual(result["readiness_status"], "BLOCKED_UNKNOWN")
        self.assertIn("REQUIRED_TEST_FAILED", result["reason_codes"])

    def test_conflict_requires_review_even_when_tests_pass(self):
        result = self.engine.evaluate({
            "event_id": "TEST-CONFLICT",
            "changed_nodes": ["component.camera"],
            "target_configuration_fingerprint": "cfg-test",
            "target_domain": "inspection",
            "unresolved_configuration_conflict": True,
            "test_results": {"T-CAL-01": "PASS", "T-PER-02": "PASS", "T-TIME-03": "PASS"},
        })
        self.assertEqual(result["readiness_status"], "REVIEW_REQUIRED")
        self.assertIn("UNRESOLVED_CONFIGURATION_CONFLICT", result["reason_codes"])

    def test_demo_cli_produces_json(self):
        results = MODULE.run_scenarios(MODULE.demo_scenarios())
        self.assertEqual(len(results), 5)
        self.assertTrue(all("prototype_notice" in result for result in results))


if __name__ == "__main__":
    unittest.main()
