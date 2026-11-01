import type {
  GeoPoint,
  ProviderResult,
  RefreshOptions,
  WorldObservation,
} from "./worldview-core";
import { validatePoint } from "./worldview-core";

const ADSB_ORIGIN = "https://api.adsb.lol";
const EONET_ORIGIN = "https://eonet.gsfc.nasa.gov";
const MAX_BYTES = 1_000_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_RADIUS_NM = 100;
const MAX_WILDFIRES = 50;
const EONET_STALE_MS = 30 * 60_000;
const ADSB_STALE_MS = 2 * 60_000;

type OpenFeedInfo = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export const OPEN_FEED_INFO: OpenFeedInfo = Object.freeze({
  adsbLol: Object.freeze({
    providerId: "adsb-lol",
    name: "adsb.lol point API",
    endpoint: `${ADSB_ORIGIN}/v2/point/{lat}/{lon}/{radiusNm}`,
    terms: "ODbL 1.0; API/data terms and production-use contact",
    termsUrl: "https://www.adsb.lol/docs/privacy-license",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1.0/",
    attribution: "Aircraft data © adsb.lol contributors, ODbL 1.0",
    limits:
      "Manual GET; radius <=100 nautical miles; >=60s throttle; no credentials",
  }),
  nasaEonet: Object.freeze({
    providerId: "nasa-eonet",
    name: "NASA EONET v3 reported wildfires",
    endpoint: `${EONET_ORIGIN}/api/v3/events`,
    terms:
      "NASA EONET API terms/data-source review required; source licenses vary by event",
    termsUrl: "https://eonet.gsfc.nasa.gov/",
    docsUrl: "https://eonet.gsfc.nasa.gov/docs/v3",
    reviewUrl: "https://eonet.gsfc.nasa.gov/event-curation",
    attribution:
      "NASA EONET v3; reported event metadata, not FIRMS thermal detections or a live fire perimeter",
    limits:
      "Manual GET; days <=30; max 50 events; >=60s throttle; no credentials",
  }),
});

interface Cache {
  at: number;
  observations: WorldObservation[];
  retrievedAt: string;
}
let adsbCache: { key: string; value: Cache } | undefined;
let wildfireCache: Cache | undefined;
let adsbAttemptAt = 0;
let wildfireAttemptAt = 0;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isoNow = () => new Date().toISOString();
const safeError = (e: unknown) =>
  e instanceof Error ? e.message : "Request failed";

function boundedRadius(radiusNm: unknown): number {
  const r = radiusNm === undefined ? 100 : Number(radiusNm);
  if (!Number.isFinite(r) || r <= 0 || r > MAX_RADIUS_NM)
    throw new Error("adsb.lol radius must be >0 and <=100 nautical miles");
  return Math.min(MAX_RADIUS_NM, Math.round(r * 10) / 10);
}

async function readJson(
  url: string,
  options: RefreshOptions = {},
): Promise<unknown> {
  if (options.network !== true)
    throw new Error("Network access is opt-in; pass { network: true }");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    ![ADSB_ORIGIN, EONET_ORIGIN].includes(parsed.origin)
  )
    throw new Error("URL is not on the HTTPS provider allowlist");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Math.min(15_000, options.timeoutMs ?? 8_000)),
  );
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES || !response.body)
      throw new Error("Provider response exceeds 1 MiB or has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Provider response exceeds 1 MiB");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timer);
  }
}

function failed(
  providerId: string,
  now: string,
  error: string,
  cache?: Cache,
): ProviderResult {
  return {
    providerId,
    observations: cache?.observations ?? [],
    retrievedAt: cache?.retrievedAt ?? now,
    freshness: cache ? "stale" : "failed",
    error: cache
      ? `${error}; showing last successful snapshot as stale`
      : error,
  };
}
function throttled(
  providerId: string,
  cache: Cache,
  age: number,
): ProviderResult {
  return {
    providerId,
    observations: cache.observations,
    retrievedAt: cache.retrievedAt,
    freshness: "stale",
    error: `Refresh throttled for ${Math.ceil((MIN_INTERVAL_MS - age) / 1000)}s; showing cached data`,
  };
}
function validObservedAt(
  raw: unknown,
  nowMs: number,
): { value?: string; valid: boolean } {
  const time =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Date.parse(raw)
        : NaN;
  if (!Number.isFinite(time) || time > nowMs) return { valid: false };
  return { value: new Date(time).toISOString(), valid: true };
}
function coordinateFromGeometry(g: unknown): [number, number] | undefined {
  if (
    Array.isArray(g) &&
    g.length >= 2 &&
    finite(g[0]) &&
    finite(g[1]) &&
    Math.abs(g[0]) <= 180 &&
    Math.abs(g[1]) <= 90
  )
    return [g[0], g[1]];
  if (Array.isArray(g))
    for (const child of g) {
      const found = coordinateFromGeometry(child);
      if (found) return found;
    }
  return undefined;
}

export async function refreshAdsb(
  point: GeoPoint,
  options: RefreshOptions & { radiusNm?: number } = {},
): Promise<ProviderResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  if (options.network !== true)
    return failed("adsb-lol", nowIso, "Network access is opt-in");
  if (!validatePoint(point)) return failed("adsb-lol", nowIso, "Invalid point");
  let radius: number;
  try {
    radius = boundedRadius(options.radiusNm);
  } catch (e) {
    return failed("adsb-lol", nowIso, safeError(e));
  }
  const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)},${radius}`;
  const cached = adsbCache?.key === key ? adsbCache.value : undefined;
  if (now - adsbAttemptAt < MIN_INTERVAL_MS)
    return cached
      ? throttled("adsb-lol", cached, now - adsbAttemptAt)
      : failed(
          "adsb-lol",
          nowIso,
          "Provider refresh throttled; wait at least 60 seconds between requests",
        );
  adsbAttemptAt = now;
  try {
    const url = `${ADSB_ORIGIN}/v2/point/${encodeURIComponent(point.lat)}/${encodeURIComponent(point.lon)}/${encodeURIComponent(radius)}`;
    const body = (await readJson(url, options)) as {
      ac?: unknown[];
      now?: unknown;
    };
    if (!body || !Array.isArray(body.ac))
      throw new Error("Invalid adsb.lol response schema");
    const providerTime =
      typeof body.now === "number" && finite(body.now) && body.now <= now + 5000
        ? Math.min(body.now, now)
        : NaN;
    if (!Number.isFinite(providerTime))
      throw new Error(
        "Provider timestamp is missing, invalid, or in the future",
      );
    const observations: WorldObservation[] = [];
    for (const item of body.ac.slice(0, 500)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const x = item as Record<string, unknown>;
      const hex =
        typeof x.hex === "string" &&
        x.hex.length <= 8 &&
        /^[0-9a-f]{6,8}$/i.test(x.hex)
          ? x.hex.toLowerCase()
          : undefined;
      const lat = typeof x.lat === "number" ? x.lat : NaN,
        lon = typeof x.lon === "number" ? x.lon : NaN;
      if (!hex || !finite(lat) || !finite(lon) || !validatePoint({ lat, lon }))
        continue;
      if (
        typeof x.seen_pos !== "number" ||
        !finite(x.seen_pos) ||
        x.seen_pos < 0 ||
        x.seen_pos > 86400
      )
        continue;
      const seenSeconds = x.seen_pos;
      const observed = validObservedAt(providerTime - seenSeconds * 1000, now);
      const fresh =
        observed.valid && now - Date.parse(observed.value!) <= ADSB_STALE_MS;
      const altitude =
        typeof x.alt_baro === "number" &&
        finite(x.alt_baro) &&
        x.alt_baro >= -2000 &&
        x.alt_baro <= 100_000
          ? x.alt_baro * 0.3048
          : undefined;
      observations.push({
        id: `adsb-lol-${hex}`,
        layer: "aircraft",
        point: {
          lat,
          lon,
          ...(altitude === undefined ? {} : { altM: altitude }),
        },
        observedAt: observed.value ?? nowIso,
        source: "adsb.lol",
        label: "Reported aircraft",
        freshness: fresh ? "fresh" : "stale",
        properties: {
          opaqueContactHex: hex,
          attribution: "adsb.lol ODbL 1.0",
          disclosure:
            "Crowdsourced ADS-B position; not identity or ownership data",
        },
      });
    }
    const unique = [...new Map(observations.map((o) => [o.id, o])).values()];
    observations.splice(0, observations.length, ...unique);
    const value = { at: now, observations, retrievedAt: nowIso };
    adsbCache = { key, value };
    return {
      providerId: "adsb-lol",
      observations,
      retrievedAt: nowIso,
      freshness: observations.every((x) => x.freshness === "fresh")
        ? "fresh"
        : "stale",
    };
  } catch (e) {
    return failed("adsb-lol", nowIso, safeError(e), cached);
  }
}

export async function refreshWildfires(
  options: RefreshOptions = {},
): Promise<ProviderResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // EONET documents event/source metadata but do not grant one uniform license
  // for every curated source. Per DATA_SOURCES.md, do not ship a live adapter
  // until that source-by-source review is complete; never silently fall back.
  void options;
  void wildfireCache;
  void wildfireAttemptAt;
  void coordinateFromGeometry;
  void MAX_WILDFIRES;
  void EONET_STALE_MS;
  return failed(
    "nasa-eonet",
    nowIso,
    "Live EONET adapter disabled pending source-license review; see OPEN_FEED_INFO.nasaEonet.reviewUrl",
  );
}
