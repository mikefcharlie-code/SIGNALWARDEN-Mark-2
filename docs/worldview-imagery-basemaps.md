# WorldView imagery, basemaps and terrain

The WorldView globe is an original schematic Three.js sphere. That schematic globe stays the **default and the offline fallback**. The *Open imagery, basemaps & terrain layers* control adds optional, read-only provider tiles draped on the globe. Nothing is requested until the operator ticks **Allow tile requests** and picks a layer. Closing the panel, unticking the opt-in or choosing *Schematic globe only* removes the tiles and the credit.

Code: `apps/management-web/src/worldview-basemap.ts` (providers, tile math, loader, cache, Terrarium decoding, hillshade, relay client), `worldview-basemap-globe.tsx` (Three.js tile patches and on-globe credit), `WorldViewBasemap.tsx` (panel), `services/management-api/basemap_relay.py` (keyed relay). Tests: `apps/management-web/tests/worldview-basemap.test.mjs`, `tests/test_basemap_relay.py`. All tests use hand-written fixtures and mocked fetch/transport; CI never touches the network.

## Providers

| Layer | Endpoint (verified shape) | Key | Status (checked 2026-10-30) | On-globe credit |
|---|---|---|---|---|
| NASA GIBS VIIRS SNPP true colour (daily) | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg` | none | Live, CORS `*` | NASA EOSDIS GIBS / Worldview |
| NASA GIBS MODIS Terra true colour (daily) | `…/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/…jpg` | none | Live | NASA EOSDIS GIBS / Worldview |
| NASA GIBS VIIRS SNPP Day/Night Band at-sensor radiance (night lights, daily) | `…/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/{date}/GoogleMapsCompatible_Level8/…png` | none | Live | NASA EOSDIS GIBS / Worldview |
| NASA GIBS VIIRS Black Marble (night lights, 2016 composite) | `…/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/…png` | none | Live; **historical** | NASA EOSDIS GIBS / Worldview |
| NASA GIBS MODIS Terra land surface temperature, day (thermal) | `…/MODIS_Terra_Land_Surface_Temp_Day/default/{date}/GoogleMapsCompatible_Level7/…png` | none | Live | NASA EOSDIS GIBS / Worldview |
| OpenStreetMap standard tiles | user-configurable HTTPS XYZ template; default `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | none | Live with an identifying User-Agent; a bare Node client received the OSM “Access blocked” tile, as the policy intends | © OpenStreetMap contributors |
| AWS Terrain Tiles (Terrarium) | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | none | Live, CORS `*`; decoded height for Denver matched ~1,597–1,610 m | Mapzen / AWS Terrain Tiles; USGS (3DEP, SRTM, GMTED2010), NOAA ETOPO1 and others (full list below) |
| Esri World Imagery | relay → `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=…` | `UCAS_ESRI_API_KEY` | Endpoint reachable. Without a token it answers `Token Required`. A placeholder token still returned a low-zoom JPEG, so key validation and billing behaviour with a **real** key are **unverified** | Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community |
| Google Map Tiles 2D (satellite) | relay → `POST https://tile.googleapis.com/v1/createSession?key=…` then `GET /v1/2dtiles/{z}/{x}/{y}?session=…&key=…`; copyright from `GET /tile/v1/viewport` | `UCAS_GOOGLE_MAPS_API_KEY` | Implemented against the documented shape; a placeholder key was rejected (HTTP 400). **Unverified with a real key** | Google + viewport copyright string |
| Google Photorealistic 3D Tiles | — | `UCAS_GOOGLE_MAPS_API_KEY` | **Not implemented.** The Three.js globe has no OGC 3D Tiles renderer, and adding one is out of scope. Status reports `not_implemented`, and Google support is limited to 2D Map Tiles | — |

GIBS dates are UTC calendar days. The default is yesterday, because today's composite is still filling in. The date picker rejects future dates, impossible dates and dates before each layer's start (VIIRS SNPP 2015-11-24, MODIS Terra 2000-02-24, DNB 2020-11-18). GIBS's `layer-time-actual` response header becomes the provider timestamp. Swath gaps, clouds, moonlight and aurora are normal. LST is a cloud-masked, colour-mapped product. It is not a fire detector and not a FLIR view.

## Lazy loading and limits

- **Viewport only:** tiles come from the globe's real camera-frustum bounds (`visibleGlobeBounds`), nearest the view centre first. There is no prefetch ring. A 500 ms debounce means a drag does not fire a burst of requests.
- **Tile zoom:** z 2–4 to match the globe's 0.65–1.8× camera zoom, capped per provider. Requests are capped at **48 tiles per view** and **64 meshes** on the globe.
- **Size/time/shape:** each tile is at most 2 MiB, with a 10 s timeout. Accepted types are `image/png`, `image/jpeg` and `image/webp`. Requests use `redirect: "error"` and `credentials: "omit"`. URLs must match a per-provider allowlist (GIBS WMTS path, terrarium path, the origin of the validated OSM template, or the fixed relay path).
- **Rate:** GIBS and terrain are capped at 240 tiles/min with 4 in parallel. OSM is capped at 60 tiles/min with **2 in parallel**, per the OSMF policy. Throttled tiles are counted and shown, never retried in a loop.
- **Cache:** in-memory LRU, 128 imagery and 96 terrain tiles, dropped when the opt-in is turned off. There is no persistent or offline cache and no redistribution.
- **Provenance:** every loaded tile records provider, source URL, retrieval time, provider time (`layer-time-actual`, the requested date, or `Last-Modified`), freshness (`recent` ≤3 days, `stale` ≤30 days, `historical`, `static-dataset`, `unknown`), age, attribution and terms link. It is marked `live: true`. The panel shows loaded, cached, failed and throttled counts, the first error, freshness and age. A tile that fails leaves the schematic globe visible underneath; nothing is substituted or invented.

## OpenStreetMap tile policy

The template must be HTTPS on the standard port, with exactly one `{z}`, `{x}` and `{y}`. Credentials, query strings, fragments and credential-looking path segments are rejected, so no API key can ride in the client or a shared scene. The browser fetches tiles itself and sends its own User-Agent plus an origin Referer (`strict-origin-when-cross-origin`); OSM's policy asks for both. Use is limited to light interactive viewing: visible tiles only, no bulk download, and no prefetch beyond the view. For heavier or commercial use, point the template at your own or a commercial tile server, which then sets its own terms and attribution.

## Terrain

Terrarium decoding: `metres = R×256 + G + B/256 − 32768`. Browser decoding uses `createImageBitmap` with `premultiplyAlpha: "none"` and `colorSpaceConversion: "none"`, so values are not altered.

- **Hillshade overlay:** 315° azimuth and 45° altitude, with 40× vertical exaggeration at globe scale. Alpha encodes shading strength, so flat ground stays transparent.
- **Relief:** 0–80× vertical exaggeration. Tile patch vertices are displaced by DEM height (bathymetry is clamped to 0). Height-only tiles still render as bounded neutral terrain meshes; they are not silently discarded when no image or hillshade is present.
- **Elevation readout:** reads the z12 tile containing the point (about 30 m per pixel at mid-latitudes), with bilinear sampling. The default point is the view centre, or a typed lat/lon within ±85.05°. The readout shows source tile URL, retrieval time, the tile's `Last-Modified`, licence link and a **static dataset** freshness label.

These are bare-earth heights, roughly relative to mean sea level, merged from DEMs of different resolution and age. They are not surveyed and must not be used for navigation, obstacle clearance or flight altitude.

Required terrain attribution (from the [tilezen list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md), as required for the AWS registry dataset):

- Mapzen
- ArcticDEM terrain data: DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich
- Canada terrain data contains information licensed under the Open Government Licence – Canada
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers
- Global ETOPO1 terrain data: U.S. National Oceanic and Atmospheric Administration
- Mexico terrain data source: INEGI, Continental relief, 2016
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government
- Norway terrain data © Kartverket
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey

The on-globe credit is a condensed line linking to this list. The full text is in `TERRAIN_ATTRIBUTION` and is attached to every terrain record.

## Keyed providers (server relay)

| Variable | Purpose | Where to get it | Cost |
|---|---|---|---|
| `UCAS_PUBLIC_BASEMAP_RELAY_ENABLED` | Turns the relay tile routes on (`1`/`true`/`yes`); default off | — | — |
| `UCAS_ESRI_API_KEY` | Esri World Imagery basemap tiles | ArcGIS Location Platform developer account → API key with *Basemaps* privilege ([developers.arcgis.com](https://developers.arcgis.com/)) | Free tier with monthly basemap tile allowance; billed beyond it (check current Esri pricing) |
| `UCAS_GOOGLE_MAPS_API_KEY` | Google Map Tiles API (2D satellite) | Google Cloud console → enable *Map Tiles API* → API key ([developers.google.com/maps/documentation/tile](https://developers.google.com/maps/documentation/tile)) | Billing account required; usage-based with a monthly free allowance (check current Google pricing) |

Routes (all `GET`, same-origin only, header `X-SignalWarden-Basemap: enabled` required):

- `/api/v1/public-imagery/basemap/status`: `relayEnabled` plus per-provider `disabled` / `not_configured` / `configured` (`google3d`: `not_implemented`). It never returns key values.
- `/api/v1/public-imagery/basemap/esri/tile?z=&x=&y=` and `/google/tile?z=&x=&y=`: only integer z ≤ 8 and in-range x/y; no other parameters.
- `/api/v1/public-imagery/basemap/google/attribution?zoom=&north=&south=&east=&west=`: Google's copyright text for the viewport.

The key lives only in the server environment. It is appended to fixed upstream URLs and is never sent to the browser or written into scene URLs, observation packs, logs (the request log prints the path only) or error messages. Transport errors are mapped to generic codes without the upstream URL. Redirects are refused. Responses are bounded to 2 MiB in 10 s, 4 concurrent and 240 per minute per provider, and return `no-store`/`nosniff`. The Google session token is created server-side and reused until an hour before expiry. Without a key, the panel shows `NOT_CONFIGURED` and requests no tiles. The existing Vite `/api/v1/public-imagery` proxy already routes these paths in development; production must route the same narrow prefix on the UI origin.

Google's [Map Tiles API attribution policy](https://developers.google.com/maps/documentation/tile/policies) says to use the official Google Maps logo whenever possible, keep it unmodified, preserve its aspect ratio, provide at least 16dp height and clear space, and include an accessible “Google Maps” label. The on-globe Google credit therefore uses the unmodified official dark-outline SVG at `apps/management-web/public/google-maps-logo-with-dark-outline.svg`, downloaded from Google's [official attribution asset package](https://developers.google.com/static/maps/documentation/images/Google_Maps_Attribution_Assets.zip), alongside the complete viewport copyright string. The asset is Google's trademark artwork supplied for this attribution purpose; it is not an invented or independently redrawn logo.

## Limits and honesty notes

- The globe zoom is coarse (tile z ≤ 4 on screen). This is context imagery, not a high-resolution or navigation map.
- Without WebGL, the 2D SVG fallback keeps the schematic outlines and the credit line, and says that provider tiles are not drawn.
- No visual check was run in a real WebGL browser while building this. Geometry, winding, mercator placement, mesh bounds and disposal are covered by Node tests, and live endpoint responses were checked with Node/curl.
- Esri and Google relays were not exercised with real keys.
- Read-only civilian context: no flight control, MAVLink transmit, targeting, identity enrichment, plate reading or face recognition. Imagery is not evidence of an event, identity or location.
