# Offline telemetry simulation

`generate_telemetry.py` emits deterministic synthetic newline-delimited JSON matching the telemetry v1 schema. It writes to stdout, does not contact a server, and never connects to aircraft hardware.

```bash
python simulation/generate_telemetry.py --count 5 --aircraft-id sim-ucas-001
```

`--count` must be positive; IDs must match the contract identifier pattern. Timestamps start at a fixed synthetic instant and advance by one second. There is no pacing or real-time behavior; ingestion/replay is future work.
