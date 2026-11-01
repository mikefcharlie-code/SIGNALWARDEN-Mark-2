from datetime import datetime, timezone
import pytest

from services.lattice_readonly import OfflineLattice
from services.lattice_readonly.reports import build_report, report_options

NOW = datetime(2025, 1, 1, 0, 1, tzinfo=timezone.utc)


def test_empty_snapshot_is_deterministic_and_has_gap():
    report = build_report(OfflineLattice("offline").overview(now=NOW), {"type": "platform-status"})
    assert len(report["evidence"]) == 1
    assert report["evidence"][0]["sourceId"] == "absence"
    assert report["coverageGaps"]
    assert report["advisory"] is True
    assert report["id"] == build_report(OfflineLattice("offline").overview(now=NOW), {"type": "platform-status"})["id"]


def test_synthetic_and_untrusted_evidence_are_labeled_with_source_links():
    report = build_report(OfflineLattice("mock").overview(now=NOW), {"type": "data-quality"})
    assert report["synthetic"] is True
    assert all(row["confidence"] == "unknown" for row in report["evidence"])
    assert any(row["trust"] != "trusted" for row in report["evidence"])
    assert "](#source-" in report["markdown"]
    assert "generated document does not verify evidence" in report["markdown"]


def test_filters_are_inclusive_and_sensor_filter_uses_actual_subject_ids():
    overview = OfflineLattice("mock").overview(now=NOW)
    sensor = "synthetic-air-001:sensor:synthetic-air-camera"
    report = build_report(overview, {"type": "sensor-isr", "sensorIds": [sensor], "start": "2025-01-01T00:00:00Z", "end": "2025-01-01T00:00:20Z"})
    assert report["evidence"]
    assert {row["subjectId"] for row in report["evidence"]} == {sensor}
    assert all(row["observedAt"] in {"2025-01-01T00:00:00Z", "2025-01-01T00:00:20Z"} for row in report["evidence"])


def test_invalid_filters_and_local_fallback():
    with pytest.raises(ValueError):
        build_report({}, {"type": "nope"})
    with pytest.raises(ValueError):
        build_report({}, {"start": "2025-01-02T00:00:00Z", "end": "2025-01-01T00:00:00Z"})
    report = build_report({}, {"engine": "local"})
    assert report["engine"] == "local-fallback"
    assert report["modelStatus"] == "unavailable"


def test_document_sources_are_allowlisted_and_historical():
    overview = {"generatedAt": "2025-01-01T00:01:00Z", "documentSources": [
        {"entityId": "air-1", "subjectId": "air-1", "sourceId": "maint[1]", "field": "maintenance.status", "value": "due", "observedAt": "2025-01-01T00:00:00Z", "trust": "trusted"},
        {"entityId": "air-1", "sourceId": "bad", "field": "location", "value": "secret", "observedAt": "2025-01-01T00:00:00Z"},
    ]}
    report = build_report(overview, {"type": "operator-handoff"})
    assert len(report["evidence"]) == 2
    assert any(row["field"] == "maintenance.status" for row in report["evidence"])
    assert "maint" in report["markdown"]


def test_options_contract_is_stable():
    assert "sensorIds" in report_options()["filters"]


def test_stale_conflict_unknown_times_and_historical_rows_are_retained():
    overview = {'generatedAt': '2025-01-01T01:00:00Z', 'platforms': [{'entityId': 'p', 'catalogId': 'fixed-camera-sensor-like'}], 'observationEvidence': [
        {'entityId': 'p', 'subjectId': 's', 'sourceId': 'a', 'field': 'health.status', 'value': 'old', 'observedAt': '2025-01-01T00:00:00Z', 'trust': 'untrusted'},
        {'entityId': 'p', 'subjectId': 's', 'sourceId': 'a', 'field': 'health.status', 'value': 'ok', 'observedAt': '2025-01-01T00:01:00Z', 'trust': 'untrusted'},
        {'entityId': 'p', 'subjectId': 's', 'sourceId': 'b', 'field': 'health.status', 'value': 'bad', 'observedAt': '2025-01-01T00:01:00Z', 'trust': 'unknown'},
    ]}
    report = build_report(overview, {'type': 'data-quality'})
    assert any(row['value'] == 'old' for row in report['evidence'])
    assert all(row['freshness'] == 'stale' for row in report['evidence'] if row['sourceId'] in {'a', 'b'})
    conflict = next(claim for section in report['sections'] for claim in section['claims'] if 'disagree' in claim['text'])
    assert len(conflict['evidenceIds']) == 2
    assert any('Stale' in gap for gap in report['coverageGaps'])
    filtered = build_report(overview, {'start': '2025-01-01T00:00:00Z'})
    assert all(row['observedAt'] for row in filtered['evidence'])
    assert any('Undated' in gap for gap in filtered['coverageGaps'])


def test_sensor_filter_keeps_original_conflicting_source_records():
    overview = OfflineLattice('mock').overview(now=NOW)
    report = build_report(overview, {'type': 'sensor-isr', 'sensorIds': ['synthetic-air-camera']})
    assert report['evidence']
    assert any(row['subjectId'].endswith(':sensor:synthetic-air-camera') for row in report['evidence'])
    assert any('disagree' in claim['text'] for section in report['sections'] for claim in section['claims'])
    assert all(row.get('sensorId') == 'synthetic-air-camera' for row in report['evidence'])


def test_markdown_citations_resolve_and_preserve_metadata_and_synthetic_label():
    import re
    report = build_report(OfflineLattice('mock').overview(now=NOW))
    markdown = report['markdown']
    assert 'synthetic demo' in markdown and 'Scope:' in markdown and 'Generated at:' in markdown
    for anchor in re.findall(r'\]\(#([^)]*)\)', markdown):
        assert f'id="{anchor}"' in markdown
    for row in report['evidence']:
        assert row['id'] in markdown and row['sourceId'] in markdown
        if row['observedAt']:
            assert row['observedAt'] in markdown
    assert 'confidence:' in markdown and 'freshness:' in markdown


def test_default_templates_never_invoke_model_even_when_external_configured(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Model must not run by default')
    monkeypatch.setattr('services.lattice_readonly.reports.build_assistance', forbidden)
    report = build_report(OfflineLattice('mock').overview(now=NOW), environ={'UCAS_AI_MODE': 'external'})
    assert report['engine'] == 'template'


def test_selected_local_model_preserves_configuration_and_all_deterministic_findings(monkeypatch):
    from services.lattice_readonly.assistance import build_assistance as rules
    overview = OfflineLattice('mock').overview(now=NOW)
    baseline = build_report(overview)
    calls = []
    def available(value, *, environ):
        calls.append(environ)
        result = rules(value, environ={'UCAS_AI_MODE': 'local', 'UCAS_AI_LOCAL_RUNTIME': 'rules'})
        return {**result, 'engine': 'local-model', 'modelStatus': 'available'}
    monkeypatch.setattr('services.lattice_readonly.reports.build_assistance', available)
    report = build_report(overview, {'engine': 'local'}, environ={'UCAS_AI_MODE': 'external', 'UCAS_AI_LOCAL_RUNTIME': 'openai-compatible', 'UCAS_AI_LOCAL_MODEL': 'example-local-model'})
    assert calls[0]['UCAS_AI_MODE'] == 'local'
    assert calls[0]['UCAS_AI_LOCAL_RUNTIME'] == 'openai-compatible'
    assert calls[0]['UCAS_AI_LOCAL_MODEL'] == 'example-local-model'
    assert report['engine'] == 'local-model' and report['modelStatus'] == 'available'
    assert report['evidence'] == baseline['evidence']
    assert report['sections'][:len(baseline['sections'])] == baseline['sections']
    ids = {row['id'] for row in report['evidence']}
    assert all(claim['evidenceIds'] and set(claim['evidenceIds']) <= ids for section in report['sections'] for claim in section['claims'])


def test_local_highlights_cannot_partially_cite_a_broader_scope(monkeypatch):
    overview = OfflineLattice('mock').overview(now=NOW)
    baseline = build_report(overview, {'platformIds': ['synthetic-air-001']})
    chosen = baseline['evidence'][0]['id']
    monkeypatch.setattr('services.lattice_readonly.reports.build_assistance', lambda *args, **kwargs: {'engine': 'local-model', 'modelStatus': 'available', 'insights': [{'title': 'BROADER_SCOPE', 'detail': 'do not retain', 'evidence': [chosen, 'outside-scope']} ]})
    report = build_report(overview, {'engine': 'local', 'platformIds': ['synthetic-air-001']})
    assert 'BROADER_SCOPE' not in report['markdown']


def test_lattice_synthetic_flag_and_inventory_sensor_projection_fail_closed():
    overview = {'generatedAt': '2025-01-01T00:01:00Z', 'synthetic': True, 'platforms': [
        {'entityId': 'p', 'catalogId': 'fixed-camera-sensor-like', 'provenance': {'sourceId': 's', 'trust': 'trusted', 'sourceUpdateTime': '2025-01-01T00:00:00Z'}, 'sensors': {'sensors': [{'sensorId': 'camera', 'sensorType': 'EO'}]}},
        {'entityId': 'inventory', 'catalogId': 'informational-weapon-like', 'sensors': {'sensors': [{'sensorId': 'excluded', 'sensorType': 'DO_NOT_EXPORT'}]}},
    ]}
    report = build_report(overview)
    assert 'DO_NOT_EXPORT' not in report['markdown']
    assert all(row['synthetic'] and row['trust'] != 'trusted' and row['freshness'] != 'current' for row in report['evidence'])


def test_document_source_synthetic_status_is_not_inherited_from_mock_lattice():
    overview = {'generatedAt': '2025-01-01T00:01:00Z', 'synthetic': True, 'documentSources': [{'entityId': 'real-aircraft', 'sourceId': 'repository', 'field': 'aircraft.status', 'value': 'planned', 'observedAt': '2025-01-01T00:00:00Z', 'synthetic': False}]}
    report = build_report(overview, {'platformIds': ['real-aircraft']})
    assert len(report['evidence']) == 1 and report['evidence'][0]['synthetic'] is False


def test_empty_filtered_demo_report_stays_labeled_without_invented_records():
    report = build_report(OfflineLattice('mock').overview(now=NOW), {'platformIds': ['does-not-exist']})
    assert report['evidence'] == []
    assert report['synthetic'] is True and 'synthetic demo' in report['title']
    assert all(not section['claims'] for section in report['sections'])
