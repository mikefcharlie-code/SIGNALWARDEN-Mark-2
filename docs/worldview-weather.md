# WorldView weather models, air quality and aviation enrichment

An opt-in WorldView panel (`WorldViewWeather.tsx`, `worldview-weather.ts`) and a disabled-by-default local relay (`services/management-api/worldview_weather.py`). It is for civilian situational awareness only: read-only, no command, control, targeting or identity-enrichment path. Forecasts and modelled air quality are **not observations**, are not certified, and are not suitable for flight planning or safety decisions.

## What it does

| Provider | What you get | Route | Credential | Verified from this build (2026-10-30) |
|---|---|---|---|---|
| Open-Meteo Forecast API | 48 h hourly at the view center: wind speed/direction at 10 m, 80 m and 120 m, 10 m gusts, 2 m temperature, cloud cover, precipitation; model-run time from Open-Meteo model metadata | Browser direct (CORS `*`) on the free tier; relay when a commercial key is configured | None, or optional `UCAS_OPEN_METEO_API_KEY` | Free endpoint live. Customer endpoint only confirmed to reject an invalid key |
| – NOAA GFS | `models=gfs_seamless` (GFS 0.25° blended with HRRR over the US) | as above | as above | Live |
| – ECMWF IFS open data | `models=ecmwf_ifs025` | as above | as above | Live |
| – DWD ICON | `models=icon_seamless` | as above | as above | Live |
| Open-Meteo Air Quality (CAMS) | **Modelled** PM2.5, PM10, O₃, NO₂, US AQI, hourly 48 h | Browser direct; relay with commercial key | None, or optional `UCAS_OPEN_METEO_API_KEY` | Live |
| OpenAQ v3 | **Measured** latest values (PM2.5, PM10, O₃, NO₂, SO₂, CO) from ≤3 nearest stations within 25 km | Relay only | **Required** `UCAS_OPENAQ_API_KEY` | Unauthenticated request returns 401 as documented. Authenticated path built to the documented v3 shape and tested with fixtures, **not verified live** (no key available) |
| OpenSky Network | Aircraft state vectors in a ≤5°×5° box around the view center | Relay only | None (anonymous) or optional `UCAS_OPENSKY_CLIENT_ID` + `UCAS_OPENSKY_CLIENT_SECRET` | Endpoint and response shape verified live through an external fetcher. The build sandbox could not connect (OpenSky blocks many cloud IP ranges). OAuth tested with mocks only |
| adsbdb | Aircraft **type** (type, ICAO type code, manufacturer) for the one selected aircraft | Relay only | None | Live |

Every rendered observation carries `provider`, `sourceUrl`, `retrievedAt`, `providerTimestamp` (model run, valid hour, measurement time or position time, with its kind), `ageSeconds`, `attribution` and `termsUrl`/`licenseUrl` in its properties. Observations are labelled live (`fresh`) or `stale` and are never marked synthetic. Panel status lines show **LIVE**, **STALE**, **FAILED**, **NOT CONFIGURED**, **DISABLED** or **THROTTLED**. When a refresh fails, the provider's earlier records stay on the globe but are re-marked stale; nothing is fabricated.

Freshness rules: a forecast is stale when its model run is more than 18 h old or the series does not cover the current hour; if the model-run time is unavailable, freshness is `unknown`. OpenAQ values are stale after 3 h. Aircraft positions are stale after 2 min.

## Setup

Open-Meteo forecast and modelled air quality need no setup. Tick **allow requests from this panel** and press a refresh button. Requests go straight from the browser to `api.open-meteo.com` / `air-quality-api.open-meteo.com` under the free **non-commercial** terms.

For the relay (OpenAQ, OpenSky, adsbdb, or Open-Meteo commercial), set these on the API server:

```bash
UCAS_WORLDVIEW_WEATHER_ENABLED=1            # required to enable the relay at all
UCAS_OPEN_METEO_API_KEY=...                 # optional, paid: https://open-meteo.com/en/pricing
UCAS_OPENAQ_API_KEY=...                     # optional, free account: https://explore.openaq.org (API key in account settings)
UCAS_OPENSKY_CLIENT_ID=...                  # optional, free OpenSky account → Account → API client
UCAS_OPENSKY_CLIENT_SECRET=...
```

Route `/api/v1/worldview-weather` on the UI origin to the API (the Vite dev and preview servers already proxy it to `localhost:8000`). Press **Check local relay** in the panel. When a commercial Open-Meteo key is configured, Open-Meteo reads automatically switch to the relay.

Keys live only in the server environment. They are never sent to the browser or put in scene URLs, observation packs, source URLs or response bodies, and error messages and logs never include them. The relay's `status` route reports only `configured` / `keyless` / `not_configured`.

## Relay routes (GET only)

All routes need `X-SignalWarden-Weather: enabled`, reject cross-site/foreign-Origin requests, and return 404 `weather_relay_disabled` unless the flag is set.

| Route | Query | Limits |
|---|---|---|
| `/api/v1/worldview-weather/status` | none | No upstream request |
| `/api/v1/worldview-weather/open-meteo/forecast` | `lat`, `lon`, `model` ∈ `gfs_seamless`, `ecmwf_ifs025`, `icon_seamless` | 10 min cache per 0.01°; ≥2 s between upstream calls |
| `/api/v1/worldview-weather/open-meteo/air-quality` | `lat`, `lon` | Same |
| `/api/v1/worldview-weather/openaq/latest` | `lat`, `lon` | Key required; ≤1 + 3 upstream calls; 5 min cache; ≥10 s throttle |
| `/api/v1/worldview-weather/opensky/states` | `lamin`, `lomin`, `lamax`, `lomax` (spans ≤5°, no antimeridian crossing) | One OpenSky credit; cache and throttle 60 s anonymous / 15 s OAuth; ≤500 states; OAuth token cached until 60 s before expiry |
| `/api/v1/worldview-weather/adsbdb/aircraft` | `icao24` (6 hex digits) | 24 h cache (≤256), ≥2 s throttle |

Common limits: fixed HTTPS host allowlist (`api.open-meteo.com`, `customer-api.open-meteo.com`, `air-quality-api.open-meteo.com`, `customer-air-quality-api.open-meteo.com`, `api.openaq.org`, `opensky-network.org`, `auth.opensky-network.org`, `api.adsbdb.com`), no redirects, no environment proxies, 10 s timeout, 1 MB response cap, 4 concurrent upstream requests, coordinates rounded to 4 decimals, and no unexpected query parameters. A throttle or quota hit returns 429 with `retryAfterSeconds`. The browser also enforces a 10 s minimum between direct Open-Meteo calls, a 1 MB cap and a 15 s timeout.

## Identity minimisation

This follows the existing adsb.lol policy: an aircraft is keyed only by the opaque ICAO 24-bit hex its source supplies.

- **OpenSky:** the relay drops callsign (which is often a tail number), origin country, squawk, SPI and receiver IDs. The client copies only position, altitude, speed, track, vertical rate, on-ground flag and timestamps.
- **adsbdb:** the upstream record also contains registration, registered owner/operator, owner country and photo URLs. Repo policy forbids registration and owner enrichment ("No callsign, registration, owner or person lookup"), so the relay returns **type only** and the client copies only those fields. Lookups happen one selected aircraft at a time, on click. Route lookups are not offered.
- **OpenAQ:** low-cost/community sensor names can name a household, so they are replaced with "Low-cost / community sensor". Station owner names are not forwarded. Licence attribution names are kept because the licences require them.

## GFS via GRIB2 (not implemented)

NOAA publishes GFS 0.25° GRIB2 on NOAA Open Data on AWS (`noaa-gfs-bdp-pds`). A direct client would fetch `.idx` index files, issue HTTP byte-range requests for the wanted messages, and decode GRIB2 (JPEG2000/complex packing) to sample a point. That needs a GRIB2 decoder dependency, roughly MB-scale transfers per field and run, and a run-selection and cache policy. It is too heavy for this bounded read-only slice, so GFS is provided through Open-Meteo's `gfs_seamless`, credited to NOAA GFS. Do not describe the Open-Meteo path as direct NOAA access.

## Attribution and terms

- Open-Meteo: "Weather data by Open-Meteo.com", [CC BY 4.0](https://open-meteo.com/en/licence), [terms](https://open-meteo.com/en/terms). The free API is for non-commercial use only (<10,000 calls/day, 5,000/hour, 600/min). Limits apply per IP, so a shared egress IP can be rate-limited early; the build proxy hit the daily limit during development. Commercial deployments need a paid key.
- NOAA GFS: "NOAA Global Forecast System (GFS)". NOAA does not endorse this product.
- ECMWF: "© ECMWF. Source: www.ecmwf.int", [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), modified (point-sampled and unit-converted by Open-Meteo). "ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use." See the [ECMWF terms](https://apps.ecmwf.int/datasets/licences/general/).
- DWD ICON via Open-Meteo, CC BY 4.0. CAMS / Copernicus Atmosphere Monitoring Service via Open-Meteo.
- OpenAQ: [terms](https://docs.openaq.org/about/terms) plus the per-station licence shown with each record. Low-cost sensors are uncalibrated, and coverage varies widely by country.
- OpenSky: "The OpenSky Network, https://opensky-network.org", [terms](https://opensky-network.org/about/terms-of-use) (research/non-commercial; no bulk mirroring). Anonymous use gets 400 credits/day per IP. Data is crowdsourced and coverage has gaps.
- adsbdb: "Aircraft type from adsbdb.com". There is no published blanket redistribution right, so the panel only does bounded single lookups.

No provider data is bundled. Tests use hand-written fixtures and mocked transports, and never touch the network.
