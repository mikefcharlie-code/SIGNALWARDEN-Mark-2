# WorldView transit, street imagery and context feeds

The **transit, street imagery and context** panel adds bikeshare (GBFS), transit vehicle positions (GTFS-realtime), street-level imagery metadata, place search, radio-station directory entries, news links and OpenStreetMap infrastructure to WorldView. Every request goes through a read-only relay in the local Management API (`services/management-api/worldview_mobility.py`). The relay is **disabled by default**. It holds every key on the server, allows only a fixed list of HTTPS hosts, never follows redirects, bounds size, time and area, throttles each provider, caches results briefly in memory, and returns normalized metadata only.

| Provider | Route | Access | Server configuration | Verification from the build sandbox (2026-10-31) |
|---|---|---|---|---|
| GBFS operators: [Citi Bike NYC](https://citibikenyc.com/data-sharing-policy), [Lime Washington DC](https://www.li.me/gbfs-terms) by default | `gbfs` | Keyless public GBFS 1.x/2.x/3.x discovery plus station and vehicle feeds | Optional `UCAS_GBFS_FEEDS_JSON` replaces the default list (see [Feed configuration](#feed-configuration)) | **Verified live** through the relay's own transport: Citi Bike returned 297 stations in a lower-Manhattan box, Lime DC returned vehicles (truncated at 300). |
| GTFS-realtime: [MBTA](https://www.mbta.com/developers), [MTA Bus Time](https://new.mta.info/developers), [511 SF Bay (Muni)](https://511.org/open-data/terms) by default | `gtfs-rt` | Protobuf `FeedMessage` (VehiclePositions). MBTA is keyless. MTA Bus Time answered without a key from the sandbox, but MTA documents a free key. 511 requires a free key (511.org/open-data/token) | Optional `UCAS_GTFSRT_FEEDS_JSON`; `UCAS_GTFSRT_MTA_BUS_KEY` (optional), `UCAS_GTFSRT_511_API_KEY` (**required** for 511) | **Verified live:** MBTA and MTA Bus Time both decoded to fresh vehicle positions. 511 returned 401 without a key, and the relay reports `not_configured`. **The keyed 511 path was not verified live** because no key was available. It is covered by mocked tests only. |
| [Mapillary Graph API](https://www.mapillary.com/developer/api-documentation) | `street-imagery?provider=mapillary` | Free client access token (mapillary.com/dashboard/developers), sent as `Authorization: OAuth …` | `UCAS_MAPILLARY_ACCESS_TOKEN` (**required**) | **Not verified live** because no token was available. Without one the relay returns `not_configured`. The request and response shape follow the Graph API docs and are covered by mocked tests. |
| [Panoramax](https://panoramax.fr/) federated API | `street-imagery?provider=panoramax` | Keyless STAC `/search` on the meta-catalogue `api.panoramax.xyz` | Optional `UCAS_PANORAMAX_URL` (one instance or a different catalogue) | **Verified live** (20 items near Paris, with per-item licence, author and instance). |
| [KartaView](https://kartaview.org/terms) | `street-imagery?provider=kartaview` | Keyless `api.kartaview.org/2.0/photo/` | none | **Verified live** (8 items near Paris). |
| [OpenStreetMap Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | `geocode` | Keyless. The public OSMF server needs an identifying User-Agent/contact and allows at most 1 request/s | `UCAS_WORLDVIEW_CONTACT` (URL or e-mail; **required** for the public server), or `UCAS_NOMINATIM_URL` for a self-hosted instance | **Verified live** with a contact set. Without a contact on the public server the relay returns `not_configured`. |
| [Radio Browser](https://www.radio-browser.info/) | `radio` | Keyless community directory | Optional `UCAS_RADIO_BROWSER_URL` (default `https://de1.api.radio-browser.info`) | **Verified live** (50 stations around New York). `de1` was intermittently unreachable from the sandbox while `de2` answered, so pin another mirror with the env var if needed. |
| [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | `news` | Keyless. GDELT asks for at most one request every 5 s | none | **Not verified live:** the sandbox's shared egress IP got HTTP 429 every time, with GDELT's plain-text rate-limit sentence. The relay maps that to `upstream_rate_limited` / `gdelt_rejected`. The parser follows the documented `artlist` JSON and is covered by fixtures. |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) (OSM `telecom=data_center`, `waterway=dam`) | `infrastructure` | Keyless public instance `overpass-api.de` | Optional `UCAS_OVERPASS_URL` (any Overpass instance, including your own) | **Not verified live:** `overpass-api.de` and other public instances timed out from the sandbox. The query and the `out center tags` response shape are covered by fixtures. Verify from your deployment network. |

On top of that, the whole relay requires `UCAS_WORLDVIEW_MOBILITY_ENABLED=1`. Without it, every `/api/v1/worldview-mobility/*` route returns `404 worldview_mobility_disabled`. A provider without its required key or contact reports `status: "not_configured"` and returns no items. No data is ever fabricated, and no provider is used as a silent fallback for another.

## Setup

```bash
UCAS_WORLDVIEW_MOBILITY_ENABLED=1 \
UCAS_WORLDVIEW_CONTACT='ops@example.org' \
UCAS_GTFSRT_511_API_KEY='…from 511.org…' \
UCAS_MAPILLARY_ACCESS_TOKEN='MLY|…' \
  python services/management-api/app.py
```

Set only what you intend to use. The Vite dev and preview servers forward `/api/v1/worldview-mobility` to `http://localhost:8000`. A deployment must expose the same narrow same-origin route. Then open **WorldView → Open transit, street imagery and context feeds**. The panel code is lazy-loaded only at that point. Tick the session opt-in, press **Check local relay**, and use each refresh/search button. Nothing is requested before that. **Clear panel layers** removes everything the panel added to the globe.

Keys live only in the server environment. They never appear in the browser bundle, scene URLs, observation packs, relay responses, `sourceUrl` values, status output or error messages. Query-parameter keys are added only to the outgoing request, and `sourceUrl` is the configured feed URL with anything key-like redacted. Do not put keys in Git, shell history or client-side configuration.

### Feed configuration

`UCAS_GBFS_FEEDS_JSON` and `UCAS_GTFSRT_FEEDS_JSON` each take a JSON list of at most 25 feeds and replace the defaults:

```json
[{"id": "my-agency", "name": "My Agency vehicles", "url": "https://rt.example.org/vehicles.pb",
  "attribution": "My Agency", "termsUrl": "https://example.org/terms", "timezone": "America/New_York",
  "keyEnv": "UCAS_GTFSRT_MY_AGENCY_KEY", "keyParam": "api_key", "keyRequired": true,
  "allowedHosts": ["cdn.example.org"]}]
```

`id` must be lowercase. `url` must be plain HTTPS. The feed's own host is always allowed, and `allowedHosts` adds further hosts (for example where a GBFS discovery document points its sub-feeds). `keyEnv` must match `UCAS_*_KEY` or `UCAS_*_TOKEN`, so a feed entry cannot read arbitrary server environment variables. The key goes in `keyParam` (query) or `keyHeader` (header). An invalid list is rejected with `*_config_invalid` and is never partially applied.

## Routes

All routes are GET-only, need the header `X-SignalWarden-Mobility: enabled`, and reject foreign `Origin` or `Sec-Fetch-Site: cross-site`. Unknown query parameters and repeated parameters are rejected.

- `status`: feed lists, which keys are configured (booleans only), geocoder mode. It never contacts a provider.
- `gbfs?feed=&west=&south=&east=&north=`: stations (capacity, bikes, e-bikes, docks, renting/returning) and free-floating vehicles (type, reserved/disabled, range) inside the box.
- `gtfs-rt?feed=&west=&south=&east=&north=`: vehicle positions (route, trip, direction, vehicle id/label, stop, status, bearing, speed, per-vehicle age) inside the box, plus the agency timezone.
- `street-imagery?provider=mapillary|panoramax|kartaview&lat=&lon=&radius=`: up to 20 image metadata records (id, capture time, compass, author, licence, thumbnail and page links).
- `geocode?q=`: up to 5 OSM place candidates.
- `radio?lat=&lon=&radius_km=`: up to 50 stations with station-submitted coordinates.
- `news?q=[&lat=&lon=]`: up to 25 article links (title, domain, language, source country, GDELT first-seen time) from the last 3 days.
- `infrastructure?west=&south=&east=&north=`: up to 400 OSM data centres and dams in the box.

Every response uses one envelope: `providerId`, `provider`, `status` (`ok`, `stale`, `throttled`, `failed`, `not_configured`), `freshness`, `retrievedAt`, `providerTimestamp`, `ageSeconds`, `sourceUrl`, `attribution`, `license`, `licenseUrl`, `termsUrl`, `ttlSeconds`, `truncated`, `items`, `notice`, `live` and `synthetic: false`. After a failure, the last good snapshot for the same query is returned as `stale`, with every item marked stale. Otherwise the response is `failed` with an `errorCode`. The browser maps items with a position to `WorldObservation`s on the extra layers `bikeshare`, `transit`, `street-imagery`, `places`, `radio`, `news` and `infrastructure`. Each carries its source, attribution and time basis (`provider` or `retrieval`). News without a place, and geocoder candidates, stay in the panel list.

## Limits

- **Area:** GBFS, Overpass ≤ 1° per side. GTFS-RT ≤ 2° per side. Street imagery radius 10–500 m (Mapillary bbox capped at a 250 m radius). Radio radius 1–100 km. Boxes cannot cross the antimeridian.
- **Transport:** HTTPS only, port 443, no credentials in URLs, fixed host allowlist (checked again for every sub-feed URL a GBFS discovery document returns), redirects rejected (`upstream_redirect_rejected`), 1 MiB per response (4 MiB for GBFS, GTFS-RT and Overpass), 15 s deadline, at most 4 concurrent upstream requests per process, `SignalWarden-WorldView/<version> (+contact)` User-Agent.
- **Throttles and caches (per server process, in memory, ≤ 256 entries each):**
  - GBFS: each document is cached for its own `ttl` (10 s to 1 h). Panning re-filters cached documents.
  - GTFS-RT: the whole feed is fetched and decoded at most once per 15 s per feed, and every view filters that snapshot.
  - Street imagery: ≥ 2 s per provider.
  - Nominatim: ≤ 1 request/s across the process (waits up to 1 s), results cached 24 h as the OSMF policy asks.
  - Radio Browser: ≥ 2 s.
  - GDELT: ≥ 6 s, results cached 5 min.
  - Overpass: ≥ 10 s, results cached 10 min.
- **Output:** ≤ 300 GBFS or GTFS items per response (`truncated: true` beyond that), 20 images, 5 places, 50 stations, 25 articles, 400 infrastructure features. Text fields are length-capped and stripped of control characters, and links are kept only if they are credential-free http(s).
- **Freshness:** a GBFS feed is stale when `last_updated` is older than max(300 s, 3 × ttl). A GTFS-RT vehicle or feed header is stale after 120 s, and a vehicle without a timestamp uses the feed header time (`timestampBasis: "feed header"`). Timestamps before 2000-01-01 (feeds use `0`/`86400` as "never reported") are treated as unknown. Street-imagery times are historical capture times. Radio and OSM times are directory or database edit times. None of these are "seen now".

## Attribution and terms

- **GBFS:** GBFS is a specification, not a licence. Each operator's terms apply, and the operator-declared `attribution_organization_name` and `license_url` from `system_information` are shown when present. Defaults: Citi Bike System Data (Lyft Bikes and Scooters, LLC) under the Citi Bike data-sharing policy, and Lime under its GBFS terms.
- **GTFS-realtime:** per agency (MBTA developer terms, MTA developer terms, 511 SF Bay open-data terms). The agency name and terms link are shown with every result.
- **Mapillary:** imagery © Mapillary contributors, CC BY-SA 4.0, plus Mapillary terms. Author username and licence are shown per image.
- **Panoramax:** licence and author **per item** as returned (often CC-BY-SA-4.0 or etalab-2.0), plus the hosting instance. The page link is the item's STAC metadata URL.
- **KartaView:** © KartaView contributors, CC BY-SA 4.0, plus KartaView terms.
- **Nominatim and Overpass:** © OpenStreetMap contributors, ODbL 1.0. Any database derived from these results that you share must be offered under ODbL (share-alike). Results are not bundled or stored.
- **Radio Browser:** community directory data. Station names, homepages and streams belong to the stations.
- **GDELT:** The GDELT Project, open access with citation. Headlines and articles remain © their publishers.

## Safety boundary

- **Read-only.** The relay performs bounded GETs and has no write, publish, transmit, tasking, vehicle-control, MAVLink, command or targeting path. It is unrelated to aircraft control.
- **No identity processing.** GBFS `bike_id`/`vehicle_id` values are rotating privacy identifiers and are replaced with positional ids. GTFS-RT `license_plate` is never decoded. The server never downloads street-level images, and SignalWarden does no face, plate, person or vehicle-identity analysis. Thumbnails load in the browser only when the user clicks *show thumbnail*, with `no-referrer`. Provider-side blurring is the providers' responsibility. Nothing is joined with other datasets for identity enrichment.
- **Metadata only.** Radio stream URLs and favicons are dropped, and streams are never relayed, played or recorded. GDELT article text and social images are never fetched or stored.
- **Honesty.** Positions are operator- or agency-reported or crowdsourced, never surveyed. OSM coverage is incomplete. A missing vehicle, image or feature is not evidence of absence. News markers sit at the searched place, not where events happened. This is civilian situational awareness, not a certified transit, navigation or emergency product.
