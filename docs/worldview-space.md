# WorldView satellite passes and space feeds

An opt-in panel for satellite pass forecasts and space context. Nothing is fetched until the panel is opened.

## What it shows

- **Pass forecasts** from CelesTrak GP/TLE data, propagated with SGP4 in the browser. Pass timing matched Skyfield within 0.3 s in testing. These are geometric forecasts and estimates, not sightings, and not a promise that a pass is visible.
- **Visibility context**: sun elevation, whether the satellite is in Earth's shadow, twilight phase and forecast cloud cover (Open-Meteo, NWS) for the observer location. Shown as context for the forecast, never as a confirmed visibility verdict.
- **SatNOGS** past radio observations for one NORAD ID, via the server relay (SatNOGS sends no CORS headers). Observer usernames and station coordinates are stripped.
- **Launch Library 2** upcoming launches from The Space Devs, via the server relay.

## Relay

Enable with `UCAS_SPACE_RELAY_ENABLED=1`. Routes, all GET and read-only:

- `/api/v1/worldview/space/status`
- `/api/v1/worldview/space/satnogs/observations?norad=<id>`
- `/api/v1/worldview/space/launches/upcoming`

Requests need `X-SignalWarden-Space: enabled` and a same-origin context. Responses are capped at 1 MiB with a 15 s deadline, cached and throttled (SatNOGS at most every 10 s; Launch Library every 300 s keyless or 60 s with `UCAS_LAUNCH_LIBRARY_API_KEY`, which is sent upstream as a token header and never echoed).

## Attribution

CelesTrak / Dr. T. S. Kelso; SatNOGS Network (Libre Space Foundation); The Space Devs Launch Library 2; Open-Meteo; NOAA/NWS. No catalog or launch data is bundled.
