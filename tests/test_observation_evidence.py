from services.lattice_readonly import OfflineLattice, build_assessment
from services.lattice_readonly.assistance import build_assistance


def test_mock_overview_has_static_sensor_citations_and_conflict_without_count_changes():
    overview = OfflineLattice("mock").overview(now=__import__("datetime").datetime(2025, 1, 1, 0, 2, tzinfo=__import__("datetime").timezone.utc))
    assert len(overview["platforms"]) == 7
    assert overview["summary"]["sensorCount"] == 2
    assert len(overview["observationEvidence"]) == 2
    assert any(f["kind"] == "conflict" for f in overview["assessment"]["findings"])
    assert all(item["synthetic"] and item["trust"] == "unknown" for item in overview["assessment"]["evidence"] if item["field"].startswith("sensor."))


def test_timestamp_and_trust_are_fail_closed_and_cited():
    overview = {"generatedAt": "2025-01-01T00:05:00Z", "platforms": [{"entityId": "x", "catalogId": "fixed-camera-sensor-like"}],
                "observationEvidence": [
                    {"entityId": "x", "subjectId": "x", "sourceId": "a", "field": "health.status", "value": "ok", "observedAt": "2024-12-31T23:00:00Z"},
                    {"entityId": "x", "subjectId": "x", "sourceId": "b", "field": "health.status", "value": "bad", "observedAt": "2025-01-01T00:05:20Z", "trust": "untrusted"},
                ]}
    assessment = build_assessment(overview)
    assert {"stale", "future"}.issubset({row["freshness"] for row in assessment["evidence"]})
    assert all(row["trust"] != "trusted" for row in assessment["evidence"])
    assert all(f["evidenceIds"] for f in assessment["findings"] if f["kind"] in {"stale", "future", "untrusted", "conflict"})


def test_dedup_and_inventory_exclusion_are_deterministic():
    item = {"entityId": "x", "subjectId": "x", "sourceId": "a", "field": "health.status", "value": "ok", "observedAt": "2025-01-01T00:00:00Z"}
    overview = {"generatedAt": "2025-01-01T00:01:00Z", "platforms": [{"entityId": "weapon", "catalogId": "informational-weapon-like"}], "observationEvidence": [item, dict(item)]}
    first = build_assessment(overview)
    second = build_assessment(overview)
    assert first == second
    assert len(first["evidence"]) == 1
    assert "weapon" not in str(first)


def test_assistance_keeps_deterministic_findings_and_makes_no_default_network_call(monkeypatch):
    monkeypatch.setattr("urllib.request.build_opener", lambda *a, **k: (_ for _ in ()).throw(AssertionError("network")))
    result = build_assistance({"generatedAt": "2025-01-01T00:00:00Z"}, environ={})
    assert result["readOnly"] is True
    assert result["snapshotId"] == result["assessment"]["snapshotId"]
    assert result["dataLeavesSystem"] is False
    assert result["assessment"]["findings"]


def test_invalid_clock_is_deterministic_and_supplied_assessment_is_ignored():
    overview = {"generatedAt": "not-rfc3339", "platforms": [{"entityId": "x", "catalogId": "fixed-camera-sensor-like"}]}
    first = build_assessment(overview)
    second = build_assessment(overview)
    assert first == second
    assert first["generatedAt"] == "1970-01-01T00:00:00Z"
    assert all(row["freshness"] == "unknown" for row in first["evidence"])
    assisted = build_assistance({**overview, "assessment": {"snapshotId": "forged"}}, environ={})
    assert assisted["snapshotId"] == first["snapshotId"]


def test_latest_per_source_and_input_order_are_stable_with_30_second_cohort():
    records = [
        {"entityId": "x", "subjectId": "s", "sourceId": "a", "field": "health.status", "value": "old", "observedAt": "2025-01-01T00:00:00Z"},
        {"entityId": "x", "subjectId": "s", "sourceId": "a", "field": "health.status", "value": "new", "observedAt": "2025-01-01T00:02:00Z"},
        {"entityId": "x", "subjectId": "s", "sourceId": "b", "field": "health.status", "value": "other", "observedAt": "2025-01-01T00:02:20Z"},
    ]
    base = {"generatedAt": "2025-01-01T00:03:00Z", "platforms": [{"entityId": "x", "catalogId": "fixed-camera-sensor-like"}]}
    a = build_assessment({**base, "observationEvidence": records})
    b = build_assessment({**base, "observationEvidence": list(reversed(records))})
    assert a == b
    assert any(item["kind"] == "conflict" for item in a["findings"])


def test_strict_offsets_synthetic_trust_and_inventory_binding_fail_closed():
    overview = {"generatedAt": "2025-01-01T00:00:00Z", "synthetic": True,
                "platforms": [{"entityId": "x", "catalogId": "fixed-camera-sensor-like"},
                               {"entityId": "weapon", "catalogId": "informational-weapon-like"}],
                "observationEvidence": [
                    {"entityId": "x", "subjectId": "s", "sourceId": "s", "field": "health.status", "value": "ok", "observedAt": "2025-01-01T00:00:00+01:99", "trust": "trusted", "synthetic": "true"},
                    {"entityId": "weapon", "subjectId": "weapon", "sourceId": "w", "field": "health.status", "value": "leak"},
                ]}
    result = build_assessment(overview)
    assert all(row["entityId"] != "weapon" for row in result["evidence"])
    row = next(row for row in result["evidence"] if row["field"] == "health.status")
    assert row["trust"] == "unknown" and row["synthetic"] is True and row["observedAt"] is None


def test_projected_fields_survive_unknown_provenance_and_valid_provenance_has_no_absence_markers():
    base = {"generatedAt": "2025-01-01T00:05:00Z", "platforms": [
        {"entityId": "unknown-source", "catalogId": "fixed-camera-sensor-like",
         "health": {"status": "ok", "location": {"lat": 1}}, "sensors": {"status": "ready"}},
        {"entityId": "identified", "catalogId": "fixed-camera-sensor-like",
         "health": {"status": "ok"}, "provenance": {"sourceId": "sensor-a", "sourceUpdateTime": "2025-01-01T00:04:00Z"}},
    ]}
    result = build_assessment(base)
    unknown = [r for r in result["evidence"] if r["entityId"] == "unknown-source"]
    assert {r["field"] for r in unknown} >= {"health", "sensors", "source", "time"}
    assert all(r["sourceId"] == "unknown" for r in unknown if r["field"] in {"health", "sensors"})
    assert "location" not in str(next(r["value"] for r in unknown if r["field"] == "health"))
    identified = [r for r in result["evidence"] if r["entityId"] == "identified"]
    assert not {r["field"] for r in identified} & {"source", "time"}


def test_latest_reduction_removes_stale_findings_and_unknown_source_does_not_conflict():
    base = {"generatedAt": "2025-01-01T00:03:00Z", "platforms": [{"entityId": "x", "catalogId": "fixed-camera-sensor-like"}]}
    result = build_assessment({**base, "observationEvidence": [
        {"entityId": "x", "subjectId": "s", "sourceId": "a", "field": "health.status", "value": "old", "observedAt": "2024-01-01T00:00:00Z"},
        {"entityId": "x", "subjectId": "s", "sourceId": "a", "field": "health.status", "value": "new", "observedAt": "2025-01-01T00:02:00Z"},
        {"entityId": "x", "subjectId": "s", "field": "health.status", "value": "unknown", "observedAt": "2025-01-01T00:02:10Z"},
    ]})
    assert not any(r["value"] == "old" for r in result["evidence"])
    assert not any(f["kind"] == "stale" and "old" in str(f) for f in result["findings"])
    assert not any(f["kind"] == "conflict" and "Independent sources" in f["title"] for f in result["findings"])


def test_synthetic_inheritance_and_invalid_clock_are_explicitly_citable():
    result = build_assessment({"generatedAt": "invalid", "synthetic": True, "platforms": [{
        "entityId": "x", "catalogId": "fixed-camera-sensor-like", "synthetic": True,
        "observationEvidence": [{"subjectId": "s", "sourceId": "a", "field": "health.status",
                                   "value": "ok", "observedAt": "not-time", "synthetic": False}],
    }]})
    row = next(r for r in result["evidence"] if r["field"] == "health.status")
    assert row["synthetic"] is True and row["trust"] == "unknown" and row["observedAt"] is None
    assert any(f["kind"] == "missing" and row["id"] in f["evidenceIds"] for f in result["findings"])
    assert any(f["kind"] == "limitation" and f["evidenceIds"] for f in result["findings"])


def test_model_highlight_uses_exact_local_citations_and_never_exports_record_details(monkeypatch):
    import json
    overview = OfflineLattice("mock").overview()
    captured = {}

    class Response:
        status = 200
        def read(self, size):
            choice = {"insights": [{"id": "finding.conflict", "evidence": ["finding.conflict"]}]}
            return json.dumps({"choices": [{"message": {"content": json.dumps(choice)}}]}).encode()
        def __enter__(self): return self
        def __exit__(self, *args): pass

    class Opener:
        def open(self, request, timeout):
            captured["url"] = request.full_url
            captured["body"] = json.loads(request.data)
            return Response()

    monkeypatch.setattr("urllib.request.build_opener", lambda *args: Opener())
    result = build_assistance(overview, environ={"UCAS_AI_MODE": "local", "UCAS_AI_LOCAL_RUNTIME": "openai-compatible", "UCAS_AI_LOCAL_MODEL": "test-model", "UCAS_LATTICE_AI_ENDPOINT": "http://127.0.0.1:9"})
    assert captured["url"] == "http://127.0.0.1:9/v1/chat/completions"
    assert result["engine"] == "local-model" and result["modelStatus"] == "available"
    assert result["insights"][0]["id"] == "finding.conflict"
    records = {row["id"]: row for row in result["assessment"]["evidence"]}
    assert len(result["insights"][0]["evidence"]) == 2
    assert all(records[ref]["observedAt"] for ref in result["insights"][0]["evidence"])
    assert all(ref in records for insight in result["insights"] for ref in insight["evidence"])
    assert result["assessment"] == overview["assessment"]  # a model cannot suppress deterministic findings
    payload = json.dumps(captured["body"])
    for forbidden in ("synthetic-air-001", "synthetic-source-alpha", "2025-01-01", "latitude", "OPERATIONAL_STATE_OPERATIONAL"):
        assert forbidden not in payload
    assert "findingCounts" in payload


def test_platform_synthetic_flag_cannot_be_overridden_by_top_level_source_report():
    overview = {"generatedAt": "2025-01-01T00:01:00Z", "platforms": [{"entityId": "x", "catalogId": "autonomous-air-like", "synthetic": True}], "observationEvidence": [{"entityId": "x", "sourceId": "a", "field": "health.status", "value": "ok", "observedAt": "2025-01-01T00:00:00Z", "trust": "trusted", "synthetic": False}]}
    result = build_assessment(overview)
    row = next(row for row in result["evidence"] if row["field"] == "health.status")
    assert row["synthetic"] is True and row["trust"] == "unknown" and row["freshness"] != "current"


def test_missing_source_never_becomes_trusted_and_expected_absent_fields_are_citable():
    overview = {"generatedAt": "2025-01-01T00:01:00Z", "platforms": [{"entityId": "x", "catalogId": "autonomous-air-like", "health": {"healthStatus": "ok"}, "provenance": {"sourceUpdateTime": "2025-01-01T00:00:00Z", "trust": "trusted"}}]}
    result = build_assessment(overview)
    rows = {row["id"]: row for row in result["evidence"]}
    health = next(row for row in rows.values() if row["field"] == "health")
    assert health["value"] == {"healthStatus": "ok"} and health["trust"] == "unknown"
    missing = [rows[ref] for finding in result["findings"] if finding["kind"] == "missing" for ref in finding["evidenceIds"]]
    assert any(row["field"] == "sensors" and row["value"] is None for row in missing)
    assert any(row["field"] == "source" for row in missing)
    assert not any(row["field"] == "time" for row in missing)
