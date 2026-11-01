# Live-maps fixtures (hand-written)

Small hand-written documents that mirror the real response shapes observed on 2026-10-31 (tests never touch the network):

- `rainviewer-weather-maps.json`: shape of `https://api.rainviewer.com/public/weather-maps.json` (v2.0; `radar.past` 13 frames at 10-min steps; `nowcast` and `satellite.infrared` empty since RainViewer discontinued them on 2026-01-01). Frame paths are invented.
- `iem-radar-list.json`: shape of `https://mesonet.agron.iastate.edu/json/radar.py?operation=list&product=N0Q&radar=USCOMP&start=...&end=...` (`scans[].ts` as `YYYY-MM-DDTHH:MMZ`).
- `gibs-describe-domains.xml`: shape of the NASA GIBS WMTS `REQUEST=DescribeDomains` response for a GOES-East ABI layer (comma-separated `start/end/PT10M` intervals with gaps).
