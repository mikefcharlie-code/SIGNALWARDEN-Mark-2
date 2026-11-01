# WorldView live maps: animated radar and geostationary satellite

The live maps panel drapes near-real-time, animatable map layers on the WorldView globe:

- **Precipitation radar** (one at a time): RainViewer global composite, or the Iowa Environmental Mesonet (IEM) US NEXRAD base-reflectivity composite.
- **Geostationary satellite** (one at a time, under the radar): NASA GIBS GOES-East, GOES-West and Himawari imagery at 10-minute cadence.
- A shared **loop controller**: play/pause, step back/forward, "Latest", and a time slider over the last ~2 hours; frame times in UTC and local time; per-layer freshness badges; optional auto-refresh.
- A **"Live data" strip** that lists which live feeds/layers are active anywhere in WorldView and how old they are.

Read-only civilian situational awareness. It is not an aviation, marine or severe-weather warning product, has no path to flight control, and does not identify or track people or vehicles.

## Setup

Nothing to configure. All three providers are keyless and send `Access-Control-Allow-Origin: *`, so the browser reads them directly and **no server relay exists for this panel** (no `UCAS_WORLDVIEW_LIVEMAPS_ENABLED` flag or `X-SignalWarden-LiveMaps` header is needed). If a deployment's Content-Security-Policy restricts `connect-src`/`img-src`, allow:

- `https://api.rainviewer.com`, `https://tilecache.rainviewer.com`
- `https://mesonet.agron.iastate.edu`
- `https://gibs.earthdata.nasa.gov`

## Using it

1. Open **Live maps** below the hazard feed panel (the "Live data" strip above it is always visible and makes no requests).
2. Tick **Allow requests…**. Nothing is fetched before this, and nothing is fetched until a layer is selected.
3. Pick a radar and/or satellite layer. RainViewer additionally asks you to confirm its personal/educational-use condition; until you do, no RainViewer request is made.
4. Frames load newest first, so the current picture appears before the loop fills in. Press **Play loop** once two or more frames are ready.

Behaviour:

- **Auto-refresh** is off by default. When on, frame lists are re-read at the provider's update interval (RainViewer 10 min, IEM 5 min, GIBS 10 min) or a 2×/3× multiple; it never runs faster. A manual refresh is limited to once per minute.
- **Tab hidden**: playback, refresh and tile loading pause (`visibilitychange`), and resume when the tab is visible again.
- **Reduced motion** (`prefers-reduced-motion: reduce`): the loop never auto-plays; the newest frame is shown; pressing play steps slowly (1.5 s/frame).
- **Freshness badge** (newest frame age vs. now): RainViewer LIVE ≤25 min, DELAYED ≤60 min; IEM LIVE ≤15 min, DELAYED ≤45 min; GIBS geostationary LIVE ≤60 min, DELAYED ≤3 h; older is STALE; a missing/future time is UNKNOWN. A failed frame-list refresh keeps the previous frames and says they are stale.
- **On-globe credit** (top-left) shows each active layer's provider credit, freshness and frame time (UTC) whenever a live layer is draped.
- The 2D fallback (no WebGL) does not draw live tiles and says so.

## Limits

| Limit | Value |
|---|---|
| Frames per layer | ≤12, spanning ~2 h (IEM's 5-min list is sub-sampled; newest always kept) |
| Tiles per frame | ≤16 visible tiles nearest the view centre, tile zoom ≤4 (globe zoom), never beyond the provider's max zoom |
| Rate | RainViewer ≤60 tiles/min, 2 concurrent (provider limit 100 requests/IP/min); IEM ≤120/min, 2 concurrent; GIBS ≤240/min, 4 concurrent. Throttled tiles are retried after 20 s, not immediately |
| Frame-list documents | ≤256 KiB, ≤12 s timeout, `redirect: "error"`, `credentials: "omit"`, `referrerPolicy: "no-referrer"`, host + path allowlist |
| Tiles | Shared basemap `TileLoader`: ≤2 MiB/tile, image content types only, allowlisted origins, bounded LRU (224 tiles per layer) |
| Globe | ≤32 tile meshes per channel; textures cached per frame (≤224) so looping does not re-upload; everything disposed on layer change/close |

## Providers, terms and attribution

| Layer | Endpoint(s) | Terms | Attribution shown | Caveats |
|---|---|---|---|---|
| RainViewer global radar | `https://api.rainviewer.com/public/weather-maps.json`; tiles `{host}{path}/256/{z}/{x}/{y}/2/1_1.png` | [RainViewer API](https://www.rainviewer.com/api.html): **personal or educational use only**, free, no SLA; commercial use needs an agreement with RainViewer | "Weather data by RainViewer (rainviewer.com)" | Max zoom 7; 100 requests/IP/min; frame `time` is generation time, radars within a frame may be older; coverage gaps; nowcast, satellite IR and other colour schemes were [discontinued on 2026-01-01](https://www.rainviewer.com/api/transition-faq.html) (the adapter would label nowcast frames "NOWCAST: forecast, not observed" if the provider ever returned them) |
| IEM US NEXRAD N0Q composite | `https://mesonet.agron.iastate.edu/json/radar.py?operation=list&product=N0Q&radar=USCOMP&start=…&end=…`; tiles `…/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-{YYYYMMDDHHMM}/{z}/{x}/{y}.png` | [IEM disclaimer](https://mesonet.agron.iastate.edu/disclaimer.php): public domain, attribution appreciated, no warranty, not an operational service | "NEXRAD composite: Iowa Environmental Mesonet, Iowa State University; source data NOAA/NWS" | CONUS only; base reflectivity includes clutter/blockage/non-weather echoes |
| NASA GIBS GOES-East / GOES-West clean IR (Band 13), GeoColor; Himawari clean IR (Band 13), red visible (Band 3) | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&…`; tiles `…/wmts/epsg3857/best/{layer}/default/{YYYY-MM-DDTHH:MM:SSZ}/GoogleMapsCompatible_Level{6,7}/{z}/{y}/{x}.png` | [NASA Earthdata data-use guidance](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance): no copyright restriction, credit requested | "NASA EOSDIS GIBS / Worldview; GOES-East/West imagery courtesy NOAA/NESDIS" (Himawari: "… NOAA/NESDIS and JMA") | ~20–60 min latency; the newest time can return 404 tiles while GIBS is still ingesting, so incomplete frames join the loop only if no complete frame exists; GeoColor at night is an IR/city-lights rendering; visible band is dark at night; limb distortion near disk edges |

**Not available:** Meteosat (EUMETSAT) — GIBS publishes no Meteosat layer, so there is no Europe/Africa/Indian Ocean geostationary loop. NOAA nowCOAST/MRMS radar is not used for the loop (nowCOAST WMS single-frame radar/GOES overlays remain in the [hazards panel](worldview-hazards.md)). No lightning layer.

## Verification (2026-10-31)

Verified live from the build sandbox: RainViewer `weather-maps.json` (13 past frames at 10-min steps, `nowcast` and `satellite.infrared` empty) and z≤7 tiles; IEM `radar.py` scan list (5-min scans) and `ridge::USCOMP-N0Q-…` tiles (a future/unknown stamp returns HTTP 503); GIBS `DescribeDomains` and tiles for all six layers (newest frames 20–60 min old; newest GOES-West frame briefly returned 404 tiles). All CORS `*`. Tests use small hand-written fixtures (`apps/management-web/tests/fixtures/livemaps/`) and mocked `fetch`; CI never touches the network.

## Live data strip

`summarizeLiveFeeds` (in `worldview-livemaps.ts`) is a pure read of existing WorldView state: `providerResults` (USGS/NOAA/adsb.lol/hazard results), records on the globe that carry `properties.retrievedAt` (grouped by `properties.provider`; synthetic demo rows and imported packs without a retrieval time are excluded; records already counted under a provider result are not double counted), globe imagery footprints (SAR/hazard overlays), the active basemap, and the live map layers above. Each chip shows LIVE / DELAYED / STALE / FAILED / UNKNOWN and age. It makes no requests.

## Files

- `apps/management-web/src/worldview-livemaps.ts` — provider catalogue, frame-list fetch/parsers, tile URLs, freshness, timeline helpers, live-data summary.
- `apps/management-web/src/WorldViewLiveMaps.tsx` + `worldview-livemaps.css` — panel and strip.
- `apps/management-web/src/worldview-livemaps-globe.tsx` — animated transparent tile overlays and on-globe credit.
- Shared edits: `WorldGlobe.tsx` (`liveOverlay` prop, one overlay layer + credit), `WorldView.tsx` (lazy mount, one state).
- `apps/management-web/tests/worldview-livemaps.test.mjs`.
