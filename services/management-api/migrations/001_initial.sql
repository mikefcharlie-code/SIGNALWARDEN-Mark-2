-- UCAS Management API PostgreSQL schema, migration 001.
-- Apply with a migration runner; do not execute this file repeatedly by hand.
-- PostgreSQL 15+ recommended. Timestamps are stored as timestamptz and returned as UTC.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS aircraft (
    aircraft_id text PRIMARY KEY CHECK (aircraft_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    schema_version text NOT NULL DEFAULT '1.0',
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('planned', 'active', 'maintenance', 'retired')),
    hardware_revision text CHECK (hardware_revision IS NULL OR char_length(hardware_revision) BETWEEN 1 AND 80),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_registrations (
    source_id text PRIMARY KEY CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    aircraft_id text NOT NULL REFERENCES aircraft(aircraft_id),
    environment text NOT NULL CHECK (environment IN ('simulation', 'lab', 'production')),
    source_type text NOT NULL CHECK (source_type IN ('simulator', 'aircraft_adapter', 'manual')),
    enabled boolean NOT NULL DEFAULT true,
    public_key_fingerprint text,
    config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_registrations_aircraft_idx ON source_registrations(aircraft_id);

-- One row per ingestion attempt. Duplicates are retained as explainable outcomes.
CREATE TABLE IF NOT EXISTS telemetry_ingestion_outcomes (
    attempt_id uuid PRIMARY KEY,
    event_key text NOT NULL,
    aircraft_id text NOT NULL REFERENCES aircraft(aircraft_id),
    source_id text NOT NULL,
    source text NOT NULL CHECK (source IN ('simulated', 'aircraft')),
    sequence bigint NOT NULL CHECK (sequence >= 0),
    sampled_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL CHECK (status IN ('accepted', 'late', 'duplicate', 'rejected', 'out_of_order')),
    error_code text,
    error_message text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX IF NOT EXISTS telemetry_ingestion_aircraft_received_idx
    ON telemetry_ingestion_outcomes(aircraft_id, received_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_ingestion_event_key_idx
    ON telemetry_ingestion_outcomes(event_key);

-- Accepted and late payloads are append-oriented. event_key makes replay idempotent.
CREATE TABLE IF NOT EXISTS telemetry_history (
    telemetry_id bigserial PRIMARY KEY,
    event_key text NOT NULL UNIQUE,
    aircraft_id text NOT NULL REFERENCES aircraft(aircraft_id),
    source_id text NOT NULL,
    source text NOT NULL CHECK (source IN ('simulated', 'aircraft')),
    sequence bigint NOT NULL CHECK (sequence >= 0),
    sampled_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    ingestion_status text NOT NULL CHECK (ingestion_status IN ('accepted', 'late', 'out_of_order')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telemetry_history_aircraft_sampled_idx
    ON telemetry_history(aircraft_id, sampled_at DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS telemetry_history_aircraft_source_sampled_idx
    ON telemetry_history(aircraft_id, source, sampled_at DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS telemetry_history_payload_gin_idx
    ON telemetry_history USING gin (payload);

-- Query-optimized and rebuildable. A row is scoped to aircraft + source.
CREATE TABLE IF NOT EXISTS telemetry_latest (
    aircraft_id text NOT NULL REFERENCES aircraft(aircraft_id),
    source text NOT NULL CHECK (source IN ('simulated', 'aircraft')),
    telemetry_id bigint NOT NULL REFERENCES telemetry_history(telemetry_id),
    event_key text NOT NULL,
    source_id text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence >= 0),
    sampled_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    ingestion_status text NOT NULL CHECK (ingestion_status IN ('accepted', 'late', 'out_of_order')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (aircraft_id, source)
);
CREATE INDEX IF NOT EXISTS telemetry_latest_sampled_idx ON telemetry_latest(sampled_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_records (
    record_id text PRIMARY KEY CHECK (record_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
    aircraft_id text NOT NULL REFERENCES aircraft(aircraft_id),
    schema_version text NOT NULL DEFAULT '1.0',
    summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
    status text NOT NULL CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
    created_at timestamptz NOT NULL,
    completed_at timestamptz,
    notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (completed_at IS NULL OR status = 'completed')
);
CREATE INDEX IF NOT EXISTS maintenance_aircraft_created_idx
    ON maintenance_records(aircraft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_events (
    event_id text PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
    aircraft_id text NOT NULL REFERENCES aircraft(aircraft_id),
    event_type text NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    source_id text,
    sequence bigint CHECK (sequence IS NULL OR sequence >= 0),
    model_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(model_ids) = 'array'),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    integrity_reference text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_aircraft_received_idx
    ON evidence_events(aircraft_id, received_at DESC);
CREATE INDEX IF NOT EXISTS evidence_type_received_idx
    ON evidence_events(event_type, received_at DESC);

-- Management changes and controlled service actions. Keep sensitive payloads minimized.
CREATE TABLE IF NOT EXISTS audit_events (
    audit_id bigserial PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
    actor_id text,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    request_id text,
    before_state jsonb,
    after_state jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS audit_entity_occurred_idx
    ON audit_events(entity_type, entity_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aircraft_set_updated_at ON aircraft;
CREATE TRIGGER aircraft_set_updated_at BEFORE UPDATE ON aircraft
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS source_registrations_set_updated_at ON source_registrations;
CREATE TRIGGER source_registrations_set_updated_at BEFORE UPDATE ON source_registrations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS maintenance_set_updated_at ON maintenance_records;
CREATE TRIGGER maintenance_set_updated_at BEFORE UPDATE ON maintenance_records
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations(version) VALUES ('001_initial')
ON CONFLICT (version) DO NOTHING;
