# WorldView live AIS vessels

The **Live AIS vessels** panel fills WorldView's existing `vessels` layer with live AIS positions. They come through a read-only relay in the local Management API that is **disabled by default**. The relay has three providers. Each is bounded in area, time and memory, and each is configured only on the server:

| Provider | Access | Server configuration | Verification from the build sandbox (2026-10-30) |
|---|---|---|---|
| [AISStream.io](https://aisstream.io/documentation) | WebSocket `wss://stream.aisstream.io/v0/stream`, **free API key** (sign in at aisstream.io → *API keys*) | `UCAS_AISSTREAM_API_KEY` | Endpoint reachable: the WebSocket handshake succeeds and a dummy key is closed by the server. **No real key was available**, so no live vessel was observed. Message parsing follows the documented envelope (`MessageType`, `MetaData`, `Message.<Type>`). |
| [Kystverket open AIS](https://www.kystverket.no/en/sea-transport-and-ports/ais/access-to-ais-data) (Norwegian Coastal Administration) | Raw AIVDM/NMEA over TCP `153.44.253.27:5631`, **keyless**, no registration | `UCAS_KYSTVERKET_AIS_ENABLED=1` | **Not reachable from the sandbox**: outbound raw TCP is blocked there, and the HTTP proxy refuses CONNECT to that port. The decoder is tested only against fixture sentences, which were cross-checked against the independent pyais decoder. Verify connectivity from your deployment network. |
| [BarentsWatch AIS Live API](https://live.ais.barentswatch.no/index.html) (Kystverket data) | HTTPS `POST /v1/latest/combined`, OAuth2 client credentials (`https://id.barentswatch.no/connect/token`, scope `ais`); **free client** registered at barentswatch.no → *My page* ([instructions](https://developer.barentswatch.no/docs/appreg)) | `UCAS_BARENTSWATCH_CLIENT_ID`, `UCAS_BARENTSWATCH_CLIENT_SECRET` | API and token endpoint are live: both return 401/400 without credentials. Request and response shapes come from the published OpenAPI document. **No client credentials were available**, so no live response was observed. |

In addition, the whole relay requires `UCAS_PUBLIC_AIS_ENABLED=1`. Without it, every `/api/v1/public-ais/*` route returns `404 public_ais_disabled`. A provider without its key or enable flag reports `not_configured` and returns no vessels. No data is ever fabricated, and no provider is used as a silent fallback for another.

## Setup

```bash
UCAS_PUBLIC_AIS_ENABLED=1 \
UCAS_AISSTREAM_API_KEY='…from aisstream.io…' \
UCAS_KYSTVERKET_AIS_ENABLED=1 \
UCAS_BARENTSWATCH_CLIENT_ID='…' UCAS_BARENTSWATCH_CLIENT_SECRET='…' \
  python services/management-api/app.py
```

Set only the providers you intend to use. The Vite dev and preview servers forward only `/api/v1/public-ais` to `http://localhost:8000`. A deployment must expose the same narrow same-origin route. Then open **WorldView → Open live AIS vessel controls**, tick the session opt-in, choose a provider, and press **Refresh vessels now** or enable 30-second polling. Closing the panel or unticking the opt-in removes the live vessels from the globe.

Keys live only in the server environment. They never appear in the browser bundle, scene URLs, observation packs, relay responses, status output or error messages. Provider error text is redacted and truncated. Do not put keys in Git, shell history or client-side configuration.

## Routes

All routes are GET-only, need the header `X-SignalWarden-AIS: enabled`, and reject foreign `Origin` or `Sec-Fetch-Site: cross-site`.

- `GET /api/v1/public-ais/status` lists each provider's status (`live`, `connecting`, `stale`, `error`, `idle`, `not_configured`), its last provider message time, attribution, licence and terms links, coverage note and limits. It never connects to a provider.
- `GET /api/v1/public-ais/vessels?provider=<aisstream|kystverket|barentswatch>&south=&west=&north=&east=` returns up to 500 latest positions inside the box, plus `vesselsInBox`/`truncated`, `retrievedAt`, the source URL, attribution, licence, the self-reported disclosure and the provider status. No other parameters are accepted.

## Limits

- **Area:** the box must be ≤ 4° latitude × 6° longitude and cannot cross the antimeridian. The browser derives a 2° × 3° box around the current view centre.
- **Streams (AISStream, Kystverket):** one shared connection per provider per server process. It starts on the first vessel poll and disconnects after 2 minutes without a poll. If the stream is silent for 2 minutes it reconnects with exponential backoff (5 s up to 120 s). AISStream subscription updates are sent at most once every 2 seconds (the provider limit is 1/s) and are filtered to PositionReport, Class B position reports, ShipStaticData and StaticDataReport. WebSocket frames are capped at 256 KiB, TCP lines at 512 bytes, and partial-line buffering at 8 KiB. Multi-sentence AIVDM reassembly is capped at 128 pending groups with a 10-second expiry. The Kystverket feed covers all of Norway, so the relay decodes it but keeps only positions inside the box.
- **BarentsWatch:** one bounded snapshot per poll, throttled to once every 30 seconds for the same box. Responses are capped at 4 MiB and 5,000 records, with a 20-second deadline and redirects disabled. The token is cached until shortly before it expires.
- **Store:** latest position per MMSI, at most 2,000 vessels plus 4,000 name/type records per provider. A position is marked **STALE** after 10 minutes and dropped after 30. Nothing is written to disk.
- **Fields shown:** MMSI, broadcast name, ship-type category, SOG, COG, true heading, navigational status and AIS class, as broadcast. The decoder handles AIS types 1/2/3/5/18/24. Call sign, IMO number, destination and ETA are deliberately not extracted or displayed.

## Attribution and terms

- **AISStream.io:** “Vessel data: AISStream.io”. Use is subject to AISStream's terms. The service has no SLA, does not allow direct browser connections, and grants no redistribution right, so none is assumed. The relay passes only per-view latest positions to the local UI.
- **Kystverket open AIS:** licensed under [NLOD 2.0](https://data.norge.no/nlod/en/2.0). External use must credit Kystverket. The relay shows “Contains data under the Norwegian licence for Open Government data (NLOD) distributed by the Norwegian Coastal Administration (Kystverket)”. Coverage is the Norwegian economic zone and the Svalbard/Jan Mayen protection zones. For privacy reasons, Kystverket **excludes fishing vessels under 15 m and recreational craft under 45 m**.
- **BarentsWatch:** “AIS data from the Norwegian Coastal Administration (Kystverket) via BarentsWatch, NLOD”. BarentsWatch API terms also apply. Coverage and exclusions are the same as Kystverket open AIS.

Every vessel observation carries the provider, source URL, retrieval time, provider timestamp, age/freshness, attribution, licence and terms links, and `live: true`/`synthetic: false`.

## Honesty boundary

AIS is **self-reported** by vessel transponders. Positions, names and types can be wrong, delayed, spoofed, switched off or missing, and coverage depends on receivers. AISStream is crowdsourced terrestrial reception. Kystverket and BarentsWatch cover Norway only. A missing vessel is not evidence of absence. This is civilian situational awareness, not a certified navigation, collision-avoidance, maritime-domain-awareness or law-enforcement product.

## Safety

The relay is receive-only. It has no AIS transmit path, no vessel tasking, and no link to aircraft control, MAVLink, commands or targeting. It performs no owner, crew, person or identity enrichment, and it does not join AIS records with any other dataset.
