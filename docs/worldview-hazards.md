# WorldView live fire and cyclone hazards

An opt-in WorldView panel that shows public fire, natural-event and tropical-cyclone metadata on the globe. Nothing is requested until the user opens the panel and presses a feed button. No hazard data or imagery is bundled.

## Sources

| Source | What it shows | Path | Key |
|---|---|---|---|
| NASA FIRMS | Satellite thermal anomalies (VIIRS/MODIS). These are hot spots, not confirmed fires. | Server relay `GET /api/v1/public-imagery/hazards/firms` | `UCAS_NASA_FIRMS_MAP_KEY` (free MAP_KEY). Without it the relay reports `keyStatus: not_configured` and falls back to FIRMS' keyless public regional 24h/48h CSVs, filtered to the bbox. |
| NOAA NHC/CPHC | Active tropical cyclones with forecast points, track and cone | Server relay `GET /api/v1/public-imagery/hazards/nhc` | None |
| NIFC WFIGS | Current wildfire incident perimeters | Browser read of the public ArcGIS service | None |
| NASA EONET v3 | Curated natural-event metadata, provider geometry times, event categories, and individual source names/links | Manual browser GET to `/api/v3/events` and `/api/v3/sources`, bounded to the selected WGS84 box (≤20° per side), 1–30 days and 100 events | None |
| NOAA nowCOAST | Weather/hazard map overlays | Browser read | None |

`GET /api/v1/public-imagery/hazards/status` reports whether the relay is enabled and whether a key is configured, never the key itself.

## Enabling the relay

```bash
UCAS_PUBLIC_HAZARDS_ENABLED=1 UCAS_NASA_FIRMS_MAP_KEY='<your MAP_KEY>' .venv/bin/python services/management-api/app.py
```

Every relay request needs `X-SignalWarden-Hazards: enabled` and must be same-origin. Upstream hosts are fixed, redirects are refused, and responses are bounded (FIRMS 8 MiB, JSON 1 MiB, 20 s deadline, at most 2,000 detections and 10 storms, bbox at most 20° per side), throttled and cached.

## Limits and safety

- FIRMS detections are thermal anomalies; EONET entries are reports. Neither proves an incident.
- EONET is a metadata-only layer with its own Events toggle, separate from fires. It never requests NASA EONET imagery/layers or third-party source imagery. Event/source links open only after a user click. Point locations use provider geometry; polygon/multipolygon markers are approximate ring centres. NASA says EONET extents are for visualization/general information and may be approximations, not official spatial or temporal determinations.
- EONET geometry timestamps are retained. Records older than 48 hours are stale; malformed/future/out-of-box records are rejected. Empty results remain unknown, not a claim that no hazards exist.
- Every result carries its provider, timestamp and freshness, and failed or stale feeds are marked as such.
- Read-only: there is no write, command or control path, and the MAP_KEY never appears in responses, errors or logs.
