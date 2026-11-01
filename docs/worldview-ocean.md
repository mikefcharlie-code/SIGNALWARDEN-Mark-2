# WorldView ocean maps and data

An opt-in WorldView panel (`WorldViewOcean.tsx`, `worldview-ocean.ts`, `worldview-ocean-globe.tsx`) and a disabled-by-default local relay (`services/management-api/ocean_relay.py`). It adds bathymetry, NOAA nautical chart display and NASA ocean products as layers draped on the globe, plus wave/swell/current/sea-surface-temperature model data, NOAA buoy observations and NOAA tide stations as live, source-labelled observations.

> **NOT FOR NAVIGATION.** Nothing in this panel is an official chart, tide table, notice to mariners or certified marine forecast. Depths are partly interpolated, chart rendering is a NOAA display service that NOAA itself marks "not to be used for navigation", wave/current/SST values are model output, buoy data are provisional and tide predictions ignore weather. Use official national hydrographic products for navigation. This is civilian situational awareness only: read-only, with no command, control, targeting or identity path.

## What it does

| Provider | What you get | Route | Credential | Verified live from this build (2026-10-31) |
|---|---|---|---|---|
| [GEBCO WMS](https://www.gebco.net/data-products/gridded-bathymetry-data) (BODC) | GEBCO_2026 grid as shaded relief (`GEBCO_LATEST`) or colour-shaded depth (`GEBCO_LATEST_2`), draped on the globe | Browser direct (CORS `*`), WMS 1.3.0 GetMap in EPSG:3857 per Web Mercator tile | None | Yes: capabilities and GetMap PNG |
| [NOAA NCEI DEM global mosaic](https://www.ncei.noaa.gov/products/etopo-global-relief-model) | Grey hillshade of ETOPO 2022 + coastal DEMs, draped | Browser direct (CORS `*`), ArcGIS ImageServer `exportImage` per tile | None | Yes |
| [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) `BlueMarble_ShadedRelief_Bathymetry` | Static shaded relief + bathymetry composite (opaque), draped | Browser direct (CORS `*`), WMTS EPSG:3857 | None | Yes |
| [NOAA ENC Direct / Maritime Chart Service](https://nauticalcharts.noaa.gov/data/gis-data-and-services.html) (`MCS/ENCOnline`) | S-57 ENCs rendered in S-52 style (transparent PNG), U.S. waters, draped | Browser direct (CORS echoes origin), ArcGIS MapServer `export` per tile | None | Yes. At globe zoom (tile zoom 2-6) it mostly shows chart cell outlines and overview charts; soundings/aids appear at larger scales. `MCS/NOAAChartDisplay` returned empty images at these scales, so it is not used. The cached `tileservice.charttools.noaa.gov` tiles returned 403 from the sandbox and are not used |
| NASA GIBS ocean products | GHRSST L4 MUR SST (daily, ~1 km), MUR SST anomaly, VIIRS NOAA-20 chlorophyll-a (daily), MUR sea-ice concentration; date picker (UTC) | Browser direct, WMTS EPSG:3857 with the requested date; product time from GIBS `layer-time-actual` | None | Yes (MUR products lag about 2 days; dates after the newest product return 404 and show as failed tiles) |
| [Open-Meteo Marine API](https://open-meteo.com/en/docs/marine-weather-api) | Current wave height/direction/period, swell, wind waves, ocean current speed/direction, SST: one point at the view centre, or an n×n grid (2-8 per side) over the visible area drawn as coloured cells + arrows | Browser direct (CORS `*`), one multi-location request | None (free tier is **non-commercial only**) | Yes |
| [NOAA NDBC](https://www.ndbc.noaa.gov/) | Latest report per buoy/C-MAN station in view: wind, gust, wave height/periods/direction, pressure, air/water temperature, dew point, tide; station name/owner from `activestations.xml` | **Relay** (NDBC sends no CORS headers) | None | Yes: `latest_obs.txt` (~100 KB, ~860 stations) and `activestations.xml` |
| [NOAA CO-OPS Tides & Currents](https://api.tidesandcurrents.noaa.gov/api/prod/) | ≤5 water-level stations nearest the view centre: latest 6-min water level (MLLW, IGLD for Great Lakes) with QC flag, and the next 48 h of predicted highs/lows | Browser direct (CORS `*`) | None | Yes: station metadata, `water_level` latest and `predictions` hilo |

Not implemented: CO-OPS current-meter stations (only water level/tides), Esri Ocean basemap (would need the keyed basemap relay; GEBCO/NCEI cover bathymetry without a key), OSCAR/altimetry currents rasters (GIBS copies are not current).

## Provenance and freshness

Every observation (`layer: "ocean"`) carries `provider`, `sourceUrl`, `retrievedAt`, `providerTimestamp`, `ageMinutesAtRetrieval`, `attribution`, `license` (terms URL), `disclosure`, `dataKind` (`model`, `measured` or `prediction`), `notForNavigation: true` and `live: true`. Panel lines show **LIVE**, **STALE**, **FAILED**, **THROTTLED** or **DISABLED**. After a failed refresh the previous snapshot stays on the globe, re-marked stale; nothing is fabricated.

- Open-Meteo Marine: `providerTimestamp` is the model's current 15-minute step (GMT); stale if more than 3 h from now. Land/no-data cells say so instead of showing zeros. Current speed is converted from km/h to m/s.
- NDBC: measurement time from the file; stale after 3 h. `fileLastModified` is the feed's `Last-Modified`.
- CO-OPS: measurement time of the latest water level (stale after 1 h, labelled preliminary unless verified). Stations without a recent water level show their prediction context labelled `prediction`.
- Draped tiles: each tile record keeps provider, source URL, retrieval time, provider time, freshness and attribution. Daily GIBS products are `recent` ≤3 days, `stale` ≤30 days, otherwise `historical`. GEBCO, NCEI and Blue Marble are `static-dataset`. ENC has no per-tile timestamp (`unknown`).

The provider credit and a **NOT FOR NAVIGATION** notice are drawn on the globe (bottom left) whenever an ocean overlay is enabled.

## Limits

- Nothing is requested until the panel is opened **and** the session opt-in box is ticked. Closing the panel or unticking clears the overlay, the ocean markers and the tile cache.
- Tiles: visible viewport only, ≤48 per view, ≤2 MiB each, image content types only, per-provider rate limits (GEBCO 120/min, NCEI 90/min, ENC 60/min, GIBS 240/min), ≤6 concurrent, 128-entry in-memory LRU cache. Tile zoom follows the globe zoom with an optional +1/+2 detail step (max zoom 8 on the globe).
- Data buttons: one bounded request per press; ≥15 s (marine point) or ≥60 s (grid, NDBC, CO-OPS) between refreshes, with the cached result shown when throttled. Boxes are clamped around the view centre: ≤30° per side for the marine grid and tides, ≤60° for buoys. JSON ≤1 MB (CO-OPS station list ≤2 MB, cached for the session, 24 h). Marine grid ≤64 points; each point counts toward Open-Meteo's free daily quota.
- Exact host and path allowlist in the browser: `gibs.earthdata.nasa.gov` (listed GIBS layers only), `wms.gebco.net/mapserv` (GetMap only), the NCEI hillshade `exportImage`, the ENCOnline `export`, `marine-api.open-meteo.com/v1/marine` (an `apikey` parameter is refused) and the two CO-OPS endpoints. No credentials, no redirects, `no-referrer`.

## Relay setup (NDBC buoys only)

```bash
UCAS_WORLDVIEW_OCEAN_ENABLED=1   # off by default; no key needed
```

Route `/api/v1/worldview-ocean` on the UI origin to the API (the Vite dev and preview servers proxy it to `localhost:8000`). All other ocean sources work without the relay.

| Route (GET) | Query | Limits |
|---|---|---|
| `/api/v1/worldview-ocean/status` | none | No upstream request |
| `/api/v1/worldview-ocean/ndbc/latest` | `west`, `south`, `east`, `north` (each once; ≤60° per side; no antimeridian wrap) | Upstream only `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt` and `activestations.xml`; no redirects, no env proxies, 15 s timeout, 1.5 MB cap, 2 concurrent; latest file cached 5 min with ≥60 s between upstream fetches (stale copy served while throttled); station names cached 24 h; ≤300 stations, nearest the box centre first |

Requests need `X-SignalWarden-Ocean: enabled`, must be same-origin (foreign `Origin` or `Sec-Fetch-Site: cross-site` → 403), and return 404 `ocean_relay_disabled` when the flag is off. Upstream error text is never echoed. The station XML is read with an attribute scan (no DTD or entity processing). Ship reports are dropped.

## Attribution and terms

| Source | Credit shown | Terms |
|---|---|---|
| GEBCO | "Imagery reproduced from the GEBCO_2026 Grid, GEBCO Compilation Group (2026) GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa)" | GEBCO grid public domain with acknowledgement; WMS imagery "not to be used for navigation", no warranty (BODC) |
| NOAA NCEI | NOAA NCEI DEM global mosaic (ETOPO and coastal DEMs) | U.S. Government work; no endorsement |
| NASA GIBS | Product credit (GHRSST MUR / JPL PO.DAAC, OB.DAAC VIIRS, Blue Marble) via NASA EOSDIS GIBS | NASA open data, credit requested |
| NOAA ENC | NOAA Office of Coast Survey ENC Online / Maritime Chart Service | U.S. Government work; display "Not to be used for navigation" |
| Open-Meteo Marine | Open-Meteo.com (CC BY 4.0); MeteoFrance MFWAM/SMOC via E.U. Copernicus Marine Service; ECMWF WAM; NOAA NCEP GFS Wave; DWD EWAM/GWAM | Free API non-commercial only; [licence](https://open-meteo.com/en/licence), [terms](https://open-meteo.com/en/terms) |
| NOAA NDBC | NOAA NDBC and the station owner (per record) | [NDBC disclaimer](https://www.ndbc.noaa.gov/disclaimer.shtml) |
| NOAA CO-OPS | NOAA NOS CO-OPS | [CO-OPS disclaimers](https://tidesandcurrents.noaa.gov/disclaimers.html) |

No provider data or imagery is bundled. Tests use small hand-written fixtures and mocked fetch/openers; CI never touches the network.

## Tests

- `apps/management-web/tests/worldview-ocean.test.mjs`: opt-in gating, URL shapes and allowlist, date and freshness rules, tile loader caps/cache/rate limit, size and content-type checks, Open-Meteo point/grid parsing and land cells, grid paint geometry and arrow directions, NDBC relay client, CO-OPS datums/predictions/station cache, and a no-request render of the panel.
- `tests/test_ocean_relay.py`: guards before transport, bbox validation, host allowlist, NDBC parsing/filtering, caching and throttling, sanitised upstream errors, entity-free XML scan, and the live app route.
