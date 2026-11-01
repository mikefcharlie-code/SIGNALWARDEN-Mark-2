# WorldView GPS jamming / GNSS interference layer (GPSJAM)

The GPS interference panel drapes [GPSJAM](https://gpsjam.org/)'s daily map of likely GPS/GNSS interference on the WorldView globe as H3 resolution-4 hexagons, coloured by the share of aircraft that reported low navigation accuracy in each cell over one UTC day.

**What this is:** an *inferred* indicator. Many aircraft broadcast their navigation accuracy (ADS-B NIC/NACp). GPSJAM, built by John Wiseman, aggregates those reports from the community receiver networks [airplanes.live](https://airplanes.live/) and [ADS-B Exchange](https://adsbexchange.com/) (de-duplicated per aircraft when both are used) over 24 hours per H3 cell.

**What this is not:**

- not a detection, direction-finding or location of jammers or spoofers;
- not real time: one file per UTC day, published soon after midnight UTC, so the newest map describes a day that ended up to ~24 h earlier;
- not attribution of a cause or source. GPSJAM's [FAQ](https://gpsjam.org/faq/) notes low accuracy can also come from spoofing, military testing, aircraft manoeuvring that masks the antenna (common over Texas), INS-only navigation or avionics faults;
- not evidence of "no interference" where there are no hexes. Blank areas have no ADS-B coverage or no aircraft.
- not valid for the ground: aircraft are high up and see interference sources far beyond what a ground receiver sees.

Civilian situational awareness only. It has no targeting function, no path to flight control or navigation, and no identity enrichment. It is not for navigation or flight planning. The GPSJAM state is separate from aircraft observations, Warden/local-AI and analyst context, commands, tracking, and ground-vehicle odometry.

## Setup

gpsjam.org sends **no CORS headers** (checked live 2026-10-31: no `Access-Control-Allow-Origin` on `/data/manifest.csv` or the day files; `OPTIONS` returns 405), so the browser reads it through a server relay. The relay is **disabled by default**:

```bash
export UCAS_WORLDVIEW_GPSJAM_ENABLED=1   # then restart services/management-api
```

There is no key. The Vite dev/preview proxy forwards `/api/v1/worldview-gpsjam` to the API like the other WorldView relays.

Relay routes (all `GET`, all require `X-SignalWarden-GpsJam: enabled`, and all reject cross-site `Origin`/`Sec-Fetch-Site`):

| Route | Upstream | Notes |
|---|---|---|
| `/api/v1/worldview-gpsjam/status` | none | enabled flag, keyless status, terms note |
| `/api/v1/worldview-gpsjam/manifest` | `https://gpsjam.org/data/manifest.csv` | dates, `suspect` (incomplete-day) flag, high-hex count, source per day |
| `/api/v1/worldview-gpsjam/day?date=YYYY-MM-DD` | `https://gpsjam.org/data[/<source>]/<date>-h3_4.csv` | the date must be in the manifest; `<source>` is taken from the manifest (`merged/`, `airplaneslive/`, or none for `adsbexchange`), mirroring gpsjam.org's own client |

Upstream shape (verified live 2026-10-31): `manifest.csv` has `date,suspect,num_bad_aircraft_hexes,source` (1,718 days, 2022-02-14 … 2026-10-30; 65 recent days `merged`, older days `adsbexchange`). A day file has `hex,count_good_aircraft,count_bad_aircraft`; 2026-10-30 had 54,472 cells (≈1.1 MB uncompressed, ≈215 kB gzip). `Cache-Control: max-age=3600`; no `Last-Modified`.

## Using it

1. Click **Open GPS jamming / GNSS interference layer** in WorldView, then expand the panel.
2. Tick **Allow requests to GPSJAM**. This checkbox is independent of WorldView’s global network toggle. Nothing is requested before this (and nothing at all while the panel is closed); unticking it clears the data and overlay.
3. The newest day loads. Pick another UTC day with the date picker (bounded by the manifest), ◀ / ▶, or **Latest**. **Check for a new day** re-reads the manifest (at most once per 5 min).
4. Hover a hex on the 3D globe for its counts: low-accuracy aircraft, good aircraft, total and the share. The panel also lists the highest-share medium/high cells in view as an accessible table.

Colours and thresholds follow GPSJAM exactly: share = `(low-accuracy aircraft − 1) ÷ (good + low-accuracy aircraft)` per cell; **Low** < 2 % (green), **Medium** 2–<10 % (yellow), **High** ≥ 10 % (red). The −1 is GPSJAM's denoising and biases sparse cells toward green. By default a cell needs ≥ 2 aircraft (GPSJAM's default); the panel offers 5/10/25.

**Freshness badge:** `LATEST DAILY` for the manifest's newest day while it is ≤ 48 h past the end of that UTC day; `STALE` when the newest day is older (GPSJAM has not published); `HISTORICAL` for any other selected day. Days GPSJAM flags as incomplete show `INCOMPLETE DAY` with a link to its explanation. The "Live data" strip lists the layer as `DELAYED` (a daily aggregate never claims LIVE).

The on-globe box (bottom-right, above basemap credits) always shows the legend, UTC date, freshness badge, drawn-cell count/cap note, the "inferred / not real time / not a jammer detection" line and the GPSJAM + FAQ links while hexes are drawn. The 2D fallback (no WebGL) does not draw hexes and says so.

## Limits

| Limit | Value |
|---|---|
| Hexes drawn | ≤ 5,000 at once (cells whose centre is in the visible globe bounds); high, then medium, then low cells, then by traffic, so a cap never drops a red cell to draw a green one; the panel and globe say when the cap applies |
| Client cache | manifest 1 h; the last 4 days transiently in memory; in-flight requests de-duplicated; nothing persisted |
| Relay cache / throttle | manifest 1 h (previous manifest served if a refresh fails), ≥ 120 s between manifest fetches; days 6 h, 4 date/source entries LRU, ≥ 60 s per date, ≤ 20 day downloads per hour; 2 concurrent upstream requests; memory only, nothing persisted |
| Relay size/time | 20 s timeout; ≤ 3 MB compressed, ≤ 6 MB decompressed (gzip bomb-safe), ≤ 400 kB manifest, ≤ 120,000 cells, counts ≤ 1,000,000 |
| Relay transport | `https://gpsjam.org` only, fixed path patterns, no query strings, no redirects, environment proxies ignored, nothing written to disk |
| Browser read | ≤ 4 MB relay JSON, 30 s timeout, `credentials: omit`, `redirect: error`, same-origin only |

Rendering: the panel (lazy-loaded) does all H3 work with the existing `h3-js` 4.5.0 dependency (Apache-2.0; its LICENSE and NOTICE are already reproduced in `public/worldview-local-layers-notices.txt`). The globe receives plain boundary arrays and builds one merged, fan-triangulated mesh in 3D, so antimeridian and pentagon cells need no special casing and the globe chunk does not bundle `h3-js`.

## Attribution and reuse terms

Required on screen while enabled: **"GPSJAM by John Wiseman (gpsjam.org)"**, with aircraft reports from **airplanes.live and/or ADS-B Exchange**, and a link to the [GPSJAM FAQ](https://gpsjam.org/faq/) (method).

Reuse terms are **unclear**. As of 2026-10-31 gpsjam.org's [About](https://gpsjam.org/about/) and [FAQ](https://gpsjam.org/faq/) pages state no licence for the map data. The upstream networks restrict their own data: ADS-B Exchange's [data-use policy](https://support.adsbexchange.com/hc/en-us/articles/37364077703693-What-is-ADS-B-Exchange-s-data-use-policy) prohibits redistributing or making derivative works without authorization, and its terms require a commercial licence for commercial use. The airplanes.live [terms page](https://airplanes.live/terms-of-use/) could not be read in full. Whether those terms reach GPSJAM's derived daily aggregates is not established. SignalWarden therefore:

- bundles no GPSJAM data (test fixtures are hand-written; only real H3 cell ids are used);
- fetches on demand, per operator opt-in, for that operator's own viewing, through a relay that keeps a few days in memory only;
- shows attribution and this uncertainty in the panel, on the globe and in relay responses.

Deployments that intend commercial use, redistribution, recording/export or public display should obtain permission from John Wiseman (contact on gpsjam.org) and check the upstream networks' terms first.

## Validation

`apps/management-web/tests/worldview-gpsjam.test.mjs` (mocked fetch, hand-written fixtures in `tests/fixtures/gpsjam/`) covers: zero requests on import/render and before opt-in; relay URL allowlist; manifest/day validation (wrong resolution, duplicates, negatives, zero-aircraft rows); GPSJAM thresholds at the 2 %/10 % edges; viewport and min-aircraft filters and the hard cap with interference kept first; antimeridian bounds; per-date cache and request de-duplication; freshness (latest / stale / historical / incomplete); tooltip counts; globe mesh radius, pentagon handling, no globe-spanning triangles, mesh reuse, cap and disposal; ray-to-surface picking; on-globe legend/badge/attribution; the "Live data" strip row; static checks for keys, storage, env reads, `innerHTML` and control surfaces. `tests/test_worldview_gpsjam.py` covers the relay guards, URL allowlist, manifest-derived source paths, gzip and plain bodies, decompression-bomb cap, size/encoding/schema errors with sanitized messages, caching, throttles and the HTTP route.

Not verified: a real WebGL render in a browser (the hover tooltip's DOM placement and the visual layering were checked only by unit tests of the mesh and pick math), and GPSJAM's exact publish time each day (the FAQ says "soon after midnight UTC"; at 2026-10-31 23:56 UTC the newest file was 2026-10-30).
