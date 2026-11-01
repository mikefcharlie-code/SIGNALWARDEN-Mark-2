/* Fire and hazard feeds for WorldView: read-only, manually opted-in, bounded.
 *
 * Browser-direct (keyless, CORS-enabled): NIFC/WFIGS current interagency fire
 * perimeters, NOAA nowCOAST WMS overlays and NASA EONET event metadata only.
 * Same-origin relay (disabled by default server-side): NASA FIRMS thermal
 * anomalies (MAP_KEY stays on the server) and NOAA NHC/CPHC cyclones (no CORS).
 * EONET linked source imagery is never fetched or embedded by this client.
 */
import type { GeoPoint, Primitive, ProviderResult, RefreshOptions, WorldObservation } from "./worldview-core";
import type { GlobeImageryLayer } from "./worldview-globe-imagery";
import { buildGeoreferencedSurface, type GeoreferencedRasterSurface } from "./worldview-draped-raster";

export type HazardBbox = Readonly<{ west: number; south: number; east: number; north: number }>;
export function buildNowCoastSurface(width: number, height: number, rgba: Uint8ClampedArray, bbox: HazardBbox): GeoreferencedRasterSurface {
  const b = validateHazardBbox(bbox, 60);
  return buildGeoreferencedSurface(width, height, rgba, {
    crs: "EPSG:4326", originX: b.west, originY: b.north,
    pixelWidth: (b.east - b.west) / width, pixelHeight: -(b.north - b.south) / height,
  });
}
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type HazardOutline = Readonly<{
  key: string;
  provider: "NOAA NHC" | "NIFC WFIGS";
  label: string;
  ring: ReadonlyArray<readonly [number, number]>;
  observedAt: string;
  attribution: string;
  sourceUrl: string;
}>;
export type EonetSourceMetadata = Readonly<{
  id: string;
  name: string;
  homepageUrl?: string;
  eventUrl?: string;
  catalogUrl?: string;
}>;
export type EonetEventMetadata = Readonly<{
  id: string;
  title: string;
  eventUrl: string;
  categories: string[];
  geometryTimes: string[];
  geometryTypes: string[];
  closedAt?: string;
  sources: EonetSourceMetadata[];
  sourcesTruncated?: boolean;
}>;
export type HazardResult = ProviderResult & {
  mode?: string;
  keyStatus?: "configured" | "not_configured" | "not_required";
  outlines?: HazardOutline[];
  truncated?: boolean;
  sourceUrl?: string;
  eonetEvents?: EonetEventMetadata[];
};

const RELAY = "/api/v1/public-imagery/hazards";
const RELAY_HEADER = "X-SignalWarden-Hazards";
const EONET_ORIGIN = "https://eonet.gsfc.nasa.gov";
const EONET_SOURCES_URL = `${EONET_ORIGIN}/api/v3/sources`;
const WFIGS_URL = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";
const NOWCOAST_ORIGIN = "https://nowcoast.noaa.gov";
const MIN_INTERVAL_MS = 60_000;
const JSON_MAX = 2_000_000;
const IMAGE_MAX = 4_000_000;
const MAX_SPAN = 20;
const MAX_RING = 200;
const EONET_CATEGORIES = ["wildfires", "severeStorms", "volcanoes", "seaLakeIce", "dustHaze", "floods", "landslides", "earthquakes"] as const;
const EONET_FRESH_MS = 48 * 3600_000;
export const FIRMS_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT", "MODIS_NRT"] as const;
export type FirmsSource = (typeof FIRMS_SOURCES)[number];
export const NOWCOAST_PRODUCTS = {
  radar: { workspace: "weather_radar", layer: "conus_base_reflectivity_mosaic", title: "CONUS radar base reflectivity mosaic", credit: "NOAA/NOS nowCOAST; NOAA/NWS NEXRAD radar mosaic" },
  goesVisible: { workspace: "satellite", layer: "goes_visible_imagery", title: "GOES East & West visible imagery", credit: "NOAA/NOS nowCOAST; NOAA/NESDIS GOES-East/West" },
  goesLongwave: { workspace: "satellite", layer: "goes_longwave_imagery", title: "GOES East & West longwave infrared imagery", credit: "NOAA/NOS nowCOAST; NOAA/NESDIS GOES-East/West" },
} as const;
export type NowCoastProduct = keyof typeof NOWCOAST_PRODUCTS;

export const HAZARD_FEED_INFO = Object.freeze({
  firms: Object.freeze({
    providerId: "nasa-firms", name: "NASA FIRMS active fire (thermal anomaly) detections",
    endpoint: "https://firms.modaps.eosdis.nasa.gov/api/area/", termsUrl: "https://www.earthdata.nasa.gov/data/tools/firms",
    attribution: "NASA FIRMS (LANCE/ESDIS); satellite thermal anomalies, not confirmed fires",
    config: "Server env UCAS_NASA_FIRMS_MAP_KEY (free key); keyless public regional 24h/48h files as fallback; relay needs UCAS_PUBLIC_HAZARDS_ENABLED=1",
  }),
  eonet: Object.freeze({
    providerId: "nasa-eonet", name: "NASA EONET v3 natural event metadata",
    endpoint: `${EONET_ORIGIN}/api/v3/events`, termsUrl: "https://eonet.gsfc.nasa.gov/what-is-eonet",
    attribution: "NASA Earth Observatory Natural Event Tracker (EONET); event source names and links retained per event",
    config: "Keyless direct metadata GET only after the hazard-session opt-in and the EONET fetch button; no EONET or third-party imagery is fetched",
  }),
  nhc: Object.freeze({
    providerId: "noaa-nhc", name: "NOAA/NWS NHC & CPHC active tropical cyclones",
    endpoint: "https://www.nhc.noaa.gov/CurrentStorms.json", termsUrl: "https://www.weather.gov/disclaimer",
    attribution: "NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center; no endorsement",
    config: "None (keyless); same-origin relay because NHC sends no CORS headers; UCAS_PUBLIC_HAZARDS_ENABLED=1",
  }),
  wfigs: Object.freeze({
    providerId: "nifc-wfigs", name: "NIFC WFIGS current interagency fire perimeters",
    endpoint: WFIGS_URL.replace(/\/query$/, ""), termsUrl: "https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters",
    attribution: "National Interagency Fire Center / WFIGS; not a legal document, no warranty",
    config: "None; browser HTTPS GET after network opt-in",
  }),
  nowcoast: Object.freeze({
    providerId: "noaa-nowcoast", name: "NOAA nowCOAST WMS radar and GOES satellite",
    endpoint: `${NOWCOAST_ORIGIN}/geoserver/ows`, termsUrl: "https://www.weather.gov/disclaimer",
    attribution: "NOAA/NOS nowCOAST with NWS and NESDIS source products; no endorsement",
    config: "None; browser HTTPS GET after network opt-in",
  }),
});

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const safeError = (e: unknown) => (e instanceof Error ? e.message.slice(0, 300) : "Request failed");
function safeHttpLink(value: unknown): string | undefined {
  const text = str(value, 500);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && url.port === "" ? url.href : undefined;
  } catch { return undefined; }
}
function eonetTimestamp(value: unknown, now: number): { iso: string; ms: number } | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return undefined;
  const day = value.slice(0, 10), [year, month, date] = day.split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > now) return undefined;
  return { iso: new Date(ms).toISOString(), ms };
}

export function validateHazardBbox(b: HazardBbox, maxSpan = MAX_SPAN): HazardBbox {
  const { west, south, east, north } = b ?? ({} as HazardBbox);
  if (![west, south, east, north].every(finite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north)
    throw new Error("Bounding box must be west<east, south<north within WGS84 degrees (no antimeridian wrap)");
  if (east - west > maxSpan || north - south > maxSpan) throw new Error(`Bounding box span is capped at ${maxSpan} degrees per side`);
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { west: r(west), south: r(south), east: r(east), north: r(north) };
}

/** Clamp a viewport to the request cap around its centre. */
export function boundedBboxFrom(view: HazardBbox, maxSpan = MAX_SPAN): HazardBbox {
  const cx = (view.west + view.east) / 2, cy = (view.south + view.north) / 2;
  const hw = Math.min(maxSpan, view.east - view.west) / 2, hh = Math.min(maxSpan, view.north - view.south) / 2;
  return validateHazardBbox({
    west: Math.max(-180, cx - hw), east: Math.min(180, cx + hw),
    south: Math.max(-90, cy - hh), north: Math.min(90, cy + hh),
  }, maxSpan);
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) throw new Error("Provider response exceeds the size limit");
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > max) throw new Error("Provider response exceeds the size limit");
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > max) { await reader.cancel(); throw new Error("Provider response exceeds the size limit"); }
    chunks.push(part.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

function allowedUrl(url: string): boolean {
  if (url.startsWith(`${RELAY}/`)) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && u.port === "" &&
      ([NOWCOAST_ORIGIN, "https://services3.arcgis.com"].includes(u.origin) ||
        (u.origin === EONET_ORIGIN && /^\/api\/v3\/(?:events|sources)$/.test(u.pathname)));
  } catch { return false; }
}

async function request(url: string, options: RefreshOptions, fetcher: Fetcher, accept: string, relay = false): Promise<Response> {
  if (options.network !== true) throw new Error("Network access is opt-in; pass { network: true }");
  if (!allowedUrl(url)) throw new Error("URL is not on the hazard provider allowlist");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20_000, options.timeoutMs ?? 12_000)));
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const headers: Record<string, string> = { Accept: accept };
    if (relay) headers[RELAY_HEADER] = "enabled";
    return await fetcher(url, { method: "GET", headers, signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" });
  } finally { clearTimeout(timer); }
}

async function readJson(url: string, options: RefreshOptions, fetcher: Fetcher, relay = false): Promise<unknown> {
  const response = await request(url, options, fetcher, "application/json, application/geo+json", relay);
  const bytes = await readBounded(response, JSON_MAX);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`HTTP ${response.status}: invalid JSON`); }
  if (!response.ok) {
    const err = obj(body) && obj(body.error) ? body.error : undefined;
    const code = str(err?.code, 60), message = str(err?.message, 240);
    throw Object.assign(new Error(code ? `${code}: ${message ?? `HTTP ${response.status}`}` : `HTTP ${response.status}`), { code, status: response.status });
  }
  return body;
}

// ---------------------------------------------------------------- throttle/cache
type Cache = { at: number; result: HazardResult; key: string };
const caches = new Map<string, Cache>();
const attempts = new Map<string, number>();
export function resetHazardState(): void { caches.clear(); attempts.clear(); }

function failed(providerId: string, error: string, extra: Partial<HazardResult> = {}, cacheKey?: string): HazardResult {
  const cached = caches.get(providerId);
  if (cacheKey !== undefined && cached?.key === cacheKey) return staleSnapshot(cached.result, `${error}; showing last successful snapshot as stale`, extra);
  return { providerId, observations: [], retrievedAt: new Date().toISOString(), freshness: "failed", error, ...extra };
}

function staleSnapshot(result: HazardResult, error: string, extra: Partial<HazardResult> = {}): HazardResult {
  return { ...result, freshness: "stale", error, observations: result.observations.map((observation) => ({
    ...observation, freshness: "stale", stale: true,
    properties: observation.properties ? { ...observation.properties, live: false } : { live: false },
  })), ...extra };
}

async function throttled(providerId: string, key: string, run: () => Promise<HazardResult>, now = Date.now()): Promise<HazardResult> {
  const last = attempts.get(providerId) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    const cached = caches.get(providerId);
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
    if (cached && cached.key === key) return staleSnapshot(cached.result, `Refresh throttled for ${wait}s; showing cached data`);
    return failed(providerId, `Provider refresh throttled; wait ${wait}s (>=60s between requests)`);
  }
  attempts.set(providerId, now);
  try {
    const result = await run();
    caches.set(providerId, { at: now, result, key });
    return result;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "firms_not_configured")
      return { providerId, observations: [], retrievedAt: new Date().toISOString(), freshness: "failed", error: safeError(e), keyStatus: "not_configured", mode: "not_configured" };
    return failed(providerId, safeError(e), {}, key);
  }
}

function ageMinutes(iso: string, now: number): number { return Math.max(0, Math.round((now - Date.parse(iso)) / 60000)); }
function validPast(iso: unknown, now: number): string | undefined {
  if (typeof iso !== "string" && typeof iso !== "number") return undefined;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t) || t > now + 5 * 60_000) return undefined;
  return new Date(Math.min(t, now)).toISOString();
}
function baseProps(p: { provider: string; sourceUrl: string; retrievedAt: string; providerTimestamp: string; now: number; fresh: boolean; attribution: string; termsUrl: string; disclosure: string }): Record<string, Primitive> {
  return {
    provider: p.provider, sourceUrl: p.sourceUrl.slice(0, 500), retrievedAt: p.retrievedAt,
    providerTimestamp: p.providerTimestamp, ageMinutesAtRetrieval: ageMinutes(p.providerTimestamp, p.now),
    attribution: p.attribution, license: p.termsUrl, disclosure: p.disclosure, live: p.fresh,
  };
}
const overall = (obs: WorldObservation[]): HazardResult["freshness"] =>
  obs.length === 0 ? "unknown" : obs.every((o) => o.freshness === "fresh") ? "fresh" : "stale";

function simplifyRing(ring: unknown): Array<[number, number]> {
  if (!Array.isArray(ring)) return [];
  const pts = ring.filter((p): p is [number, number] => Array.isArray(p) && finite(p[0]) && finite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90).map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length <= MAX_RING) return pts;
  const step = pts.length / MAX_RING;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < MAX_RING; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}
function ringCenter(ring: ReadonlyArray<readonly [number, number]>): GeoPoint | undefined {
  if (!ring.length) return undefined;
  let w = 180, e = -180, s = 90, n = -90;
  for (const [lon, lat] of ring) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}
function outerRings(geometry: unknown): Array<Array<[number, number]>> {
  if (!obj(geometry)) return [];
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) return [simplifyRing(geometry.coordinates[0])];
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates))
    return geometry.coordinates.slice(0, 50).map((poly) => simplifyRing(Array.isArray(poly) ? poly[0] : []));
  return [];
}
const ringArea = (r: ReadonlyArray<readonly [number, number]>) =>
  Math.abs(r.reduce((a, [x1, y1], i) => { const [x2, y2] = r[(i + 1) % r.length]; return a + x1 * y2 - x2 * y1; }, 0) / 2);

// ---------------------------------------------------------------- relay status
export type HazardRelayStatus = { state: "enabled" | "disabled" | "error"; firmsKey?: "configured" | "not_configured"; message: string };
export async function fetchHazardRelayStatus(options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<HazardRelayStatus> {
  try {
    const body = await readJson(`${RELAY}/status`, options, fetcher, true);
    const key = obj(body) && obj(body.firms) && body.firms.keyStatus === "configured" ? "configured" : "not_configured";
    return { state: "enabled", firmsKey: key, message: key === "configured" ? "Relay enabled; FIRMS MAP_KEY configured on the server" : "Relay enabled; FIRMS MAP_KEY not_configured (keyless public-file fallback only)" };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) return { state: "disabled", message: "Hazard relay disabled on the server (set UCAS_PUBLIC_HAZARDS_ENABLED=1)" };
    return { state: "error", message: safeError(e) };
  }
}

// ---------------------------------------------------------------- FIRMS
const FIRMS_FRESH_MS = 6 * 3600_000;
export async function refreshFirms(bbox: HazardBbox, opts: { source?: FirmsSource; days?: number } = {}, options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<HazardResult> {
  const providerId = "nasa-firms";
  if (options.network !== true) return failed(providerId, "Network access is opt-in");
  let b: HazardBbox;
  try { b = validateHazardBbox(bbox); } catch (e) { return failed(providerId, safeError(e)); }
  const source = opts.source ?? "VIIRS_NOAA20_NRT";
  const days = opts.days ?? 1;
  if (!FIRMS_SOURCES.includes(source)) return failed(providerId, "Unsupported FIRMS source");
  if (!Number.isInteger(days) || days < 1 || days > 5) return failed(providerId, "FIRMS days must be 1-5");
  const q = new URLSearchParams({ bbox: `${b.west},${b.south},${b.east},${b.north}`, source, days: String(days) });
  return throttled(providerId, q.toString(), async () => {
    const body = await readJson(`${RELAY}/firms?${q}`, options, fetcher, true);
    if (!obj(body) || !Array.isArray(body.detections) || body.provider !== "nasa-firms") throw new Error("Invalid FIRMS relay response");
    const now = Date.now();
    const retrievedAt = validPast(body.retrievedAt, now) ?? new Date(now).toISOString();
    const sourceUrl = str(body.sourceUrl, 400) ?? HAZARD_FEED_INFO.firms.endpoint;
    if (/api\/area\/csv\/(?!\[MAP_KEY\])/.test(sourceUrl)) throw new Error("Relay response exposed a credential-bearing URL; discarded");
    const mode = str(body.mode, 40) ?? "unknown";
    const observations: WorldObservation[] = [];
    for (const d of body.detections.slice(0, 2000)) {
      if (!obj(d) || !finite(d.lat) || !finite(d.lon) || Math.abs(d.lat) > 90 || Math.abs(d.lon) > 180) continue;
      if (d.lat < b.south || d.lat > b.north || d.lon < b.west || d.lon > b.east) continue;
      const acquired = validPast(d.acquiredAt, now);
      if (!acquired) continue;
      const fresh = now - Date.parse(acquired) <= FIRMS_FRESH_MS;
      observations.push({
        id: `firms-${source}-${d.lat.toFixed(4)}-${d.lon.toFixed(4)}-${acquired.slice(0, 16)}`.slice(0, 120),
        layer: "fires", point: { lat: d.lat, lon: d.lon, uncertaintyM: source === "MODIS_NRT" ? 1000 : 375 },
        observedAt: acquired, source: "NASA FIRMS", label: "Satellite thermal anomaly (not a confirmed fire)",
        freshness: fresh ? "fresh" : "stale",
        properties: {
          ...baseProps({ provider: "NASA FIRMS", sourceUrl, retrievedAt, providerTimestamp: acquired, now, fresh, attribution: HAZARD_FEED_INFO.firms.attribution, termsUrl: HAZARD_FEED_INFO.firms.termsUrl, disclosure: "Thermal anomaly at satellite pixel centre; may be industrial/volcanic/other heat; fires under cloud may be missed" }),
          acquisitionTimeUtc: acquired, confidence: str(d.confidence, 16) ?? "unknown",
          frpMw: finite(d.frpMw) ? d.frpMw : null, satellite: str(d.satellite, 24) ?? "unknown",
          instrument: str(d.instrument, 12) ?? "unknown", dayNight: str(d.dayNight, 8) ?? "unknown",
          firmsSource: source, accessMode: mode,
        },
      });
    }
    const unique = [...new Map(observations.map((o) => [o.id, o])).values()];
    if (body.detections.length > 0 && unique.length === 0) throw new Error("FIRMS returned no usable timestamped detections; malformed, future or out-of-area records were discarded");
    return {
      providerId, observations: unique, retrievedAt, freshness: overall(unique), mode, sourceUrl,
      keyStatus: body.keyStatus === "configured" ? "configured" : "not_configured", truncated: body.truncated === true,
      ...(unique.length ? {} : { error: "No timestamped detections returned; hazard freshness is unknown, not confirmation of safety" }),
    };
  });
}

// ---------------------------------------------------------------- EONET metadata only
/** Fetch curated event metadata and source references only; never follow source imagery/layer URLs. */
export async function refreshEonet(bbox: HazardBbox, opts: { days?: number; category?: string } = {}, options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<HazardResult> {
  const providerId = HAZARD_FEED_INFO.eonet.providerId;
  if (options.network !== true) return failed(providerId, "Network access is opt-in");
  let b: HazardBbox;
  try { b = validateHazardBbox(bbox); } catch (e) { return failed(providerId, safeError(e)); }
  const days = opts.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 30) return failed(providerId, "EONET days must be 1-30");
  const category = opts.category && opts.category !== "all" ? opts.category : undefined;
  if (category && !(EONET_CATEGORIES as readonly string[]).includes(category)) return failed(providerId, "Unsupported EONET category");
  // NASA EONET documents bbox as upper-left lon/lat followed by lower-right lon/lat.
  const query = new URLSearchParams({ bbox: `${b.west},${b.north},${b.east},${b.south}`, status: "all", days: String(days), limit: "100" });
  if (category) query.set("category", category);
  const eventsUrl = `${HAZARD_FEED_INFO.eonet.endpoint}?${query}`;
  const cacheKey = `${eventsUrl}|sources`;
  return throttled(providerId, cacheKey, async () => {
    const [body, sourcesBody] = await Promise.all([
      readJson(eventsUrl, options, fetcher),
      readJson(EONET_SOURCES_URL, options, fetcher),
    ]);
    if (!obj(body) || !Array.isArray(body.events)) throw new Error("Invalid NASA EONET events response schema");
    if (!obj(sourcesBody) || !Array.isArray(sourcesBody.sources)) throw new Error("Invalid NASA EONET sources response schema");
    const sourceCatalog = new Map<string, { title: string; homepageUrl?: string; catalogUrl?: string }>();
    for (const row of sourcesBody.sources.slice(0, 1000)) {
      if (!obj(row)) continue;
      const id = str(row.id, 80), title = str(row.title, 160);
      if (id && title) sourceCatalog.set(id, { title, homepageUrl: safeHttpLink(row.source), catalogUrl: safeHttpLink(row.link) });
    }
    const now = Date.now(), retrievedAt = new Date(now).toISOString();
    const observations: WorldObservation[] = [];
    const eonetEvents: EonetEventMetadata[] = [];
    let truncated = body.events.length >= 100;
    for (const row of body.events.slice(0, 100)) {
      if (!obj(row) || !Array.isArray(row.geometry) || !Array.isArray(row.sources)) continue;
      const id = str(row.id, 80);
      const title = str(row.title, 180);
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !title || row.sources.length === 0) continue;
      const eventCandidate = safeHttpLink(row.link);
      const eventUrl = eventCandidate && new URL(eventCandidate).origin === EONET_ORIGIN && new URL(eventCandidate).pathname.startsWith("/api/v3/events/")
        ? eventCandidate : `${EONET_ORIGIN}/api/v3/events/${encodeURIComponent(id)}`;
      const sources: EonetSourceMetadata[] = [];
      for (const ref of row.sources.slice(0, 20)) {
        if (!obj(ref)) continue;
        const sourceId = str(ref.id, 80);
        if (!sourceId) continue;
        const catalog = sourceCatalog.get(sourceId);
        const eventSourceUrl = safeHttpLink(ref.url);
        const homepageUrl = catalog?.homepageUrl ?? safeHttpLink(ref.source);
        const catalogUrl = catalog?.catalogUrl;
        sources.push({ id: sourceId, name: catalog?.title ?? str(ref.title, 160) ?? sourceId,
          ...(homepageUrl ? { homepageUrl } : {}), ...(eventSourceUrl ? { eventUrl: eventSourceUrl } : {}), ...(catalogUrl ? { catalogUrl } : {}) });
      }
      if (row.sources.length > 20) truncated = true;
      if (!sources.length) continue;
      const categories = Array.isArray(row.categories) ? row.categories.slice(0, 20).flatMap((c) => obj(c) ? [str(c.title, 100) ?? str(c.id, 60)].filter((v): v is string => !!v) : []) : [];
      const geometries = row.geometry.slice(0, 30);
      if (row.geometry.length > 30) truncated = true;
      const geometryTimes: string[] = [];
      const geometryTypes: string[] = [];
      const eventObservations: WorldObservation[] = [];
      const closedAt = eonetTimestamp(row.closed, now)?.iso;
      for (let index = 0; index < geometries.length; index++) {
        const geometry = geometries[index];
        if (!obj(geometry)) continue;
        const providerTime = eonetTimestamp(geometry.date, now);
        if (!providerTime) continue;
        const { iso: stamp, ms: dateMs } = providerTime;
        let point: GeoPoint | undefined;
        let geometryType = "";
        if (geometry.type === "Point" && Array.isArray(geometry.coordinates) && finite(geometry.coordinates[0]) && finite(geometry.coordinates[1])) {
          const [lon, lat] = geometry.coordinates;
          if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north) {
            point = { lon, lat }; geometryType = "Point";
          }
        } else if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
          const rings = outerRings(geometry).filter((ring) => ring.length >= 3);
          const ring = rings.reduce<Array<[number, number]> | undefined>((best, candidate) => !best || ringArea(candidate) > ringArea(best) ? candidate : best, undefined);
          const center = ring ? ringCenter(ring) : undefined;
          if (center && center.lon >= b.west && center.lon <= b.east && center.lat >= b.south && center.lat <= b.north) {
            point = center; geometryType = geometry.type;
          }
        }
        if (!point) continue;
        geometryTimes.push(stamp);
        geometryTypes.push(geometryType);
        const fresh = now - dateMs <= EONET_FRESH_MS;
        const sourceNames = sources.map((source) => source.name).join("; ").slice(0, 500);
        const sourceIds = sources.map((source) => source.id).join(",").slice(0, 240);
        const sourceEventLinks = sources.flatMap((source) => source.eventUrl ? [source.eventUrl] : []).join(" ").slice(0, 500);
        eventObservations.push({
          id: `eonet-${id}-${index}`.slice(0, 120), layer: "events", point, observedAt: stamp, source: "NASA EONET", title,
          label: `EONET curated event metadata: ${title}${geometryType === "Point" ? "" : ` (approx. ${geometryType} ring centre)`}`,
          freshness: fresh ? "fresh" : "stale",
          properties: {
            ...baseProps({ provider: "NASA EONET v3", sourceUrl: eventsUrl, retrievedAt, providerTimestamp: stamp, now, fresh,
              attribution: HAZARD_FEED_INFO.eonet.attribution, termsUrl: HAZARD_FEED_INFO.eonet.termsUrl,
              disclosure: "Curated event metadata only; reported spatial/time extent may be approximate and is not an official warning. No linked imagery is displayed" }),
            eventId: id, eventTitle: title, eventUrl, eventGeometryType: geometryType,
            eventCategories: categories.join(", ").slice(0, 300) || "Uncategorized", sourceIds, sourceNames,
            sourceEventLinks: sourceEventLinks || null, closedAt: closedAt ?? null,
          },
        });
        if (observations.length + eventObservations.length >= 1000) { truncated = true; break; }
      }
      if (eventObservations.length) {
        observations.push(...eventObservations);
        eonetEvents.push({ id, title, eventUrl, categories, geometryTimes, geometryTypes,
          ...(closedAt ? { closedAt } : {}),
          sources, ...(row.sources.length > 20 ? { sourcesTruncated: true } : {}) });
      }
      if (observations.length >= 1000) break;
    }
    if (body.events.length > 0 && observations.length === 0) throw new Error("NASA EONET returned no usable timestamped event geometry with source references; malformed, future or out-of-area records were discarded");
    return { providerId, observations, eonetEvents, retrievedAt, freshness: overall(observations), sourceUrl: eventsUrl, keyStatus: "not_required", truncated,
      ...(observations.length ? {} : { error: "No matching EONET event metadata returned; empty results are unknown and not confirmation that no events exist" }) };
  });
}

// ---------------------------------------------------------------- WFIGS perimeters
const WFIGS_FIELDS = "poly_IncidentName,poly_GISAcres,poly_DateCurrent,poly_PolygonDateTime,poly_MapMethod,attr_IncidentTypeCategory,attr_PercentContained,attr_UniqueFireIdentifier,attr_POOState";
const WFIGS_FRESH_MS = 72 * 3600_000;
export async function refreshWfigs(bbox: HazardBbox, options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<HazardResult> {
  const providerId = "nifc-wfigs";
  if (options.network !== true) return failed(providerId, "Network access is opt-in");
  let b: HazardBbox;
  try { b = validateHazardBbox(bbox); } catch (e) { return failed(providerId, safeError(e)); }
  const params = new URLSearchParams({
    where: "1=1", geometry: `${b.west},${b.south},${b.east},${b.north}`, geometryType: "esriGeometryEnvelope", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: WFIGS_FIELDS, returnGeometry: "true", outSR: "4326",
    maxAllowableOffset: "0.005", geometryPrecision: "4", resultRecordCount: "200", orderByFields: "poly_GISAcres DESC", f: "geojson",
  });
  const url = `${WFIGS_URL}?${params}`;
  return throttled(providerId, url, async () => {
    const body = await readJson(url, options, fetcher);
    if (!obj(body) || !Array.isArray(body.features)) throw new Error(obj(body) && obj(body.error) ? "WFIGS service returned an error" : "Invalid WFIGS response schema");
    const now = Date.now(), retrievedAt = new Date(now).toISOString();
    const observations: WorldObservation[] = [];
    const outlines: HazardOutline[] = [];
    for (const f of body.features.slice(0, 200)) {
      if (!obj(f) || !obj(f.properties)) continue;
      const p = f.properties;
      const rings = outerRings(f.geometry).filter((r) => r.length >= 3);
      if (!rings.length) continue;
      const main = rings.reduce((a, r) => (ringArea(r) > ringArea(a) ? r : a), rings[0]);
      const center = ringCenter(main);
      const stamp = validPast(p.poly_DateCurrent, now) ?? validPast(p.poly_PolygonDateTime, now);
      if (!center || !stamp) continue;
      const fresh = now - Date.parse(stamp) <= WFIGS_FRESH_MS;
      const fireId = str(p.attr_UniqueFireIdentifier, 40) ?? `obj-${observations.length}`;
      const name = str(p.poly_IncidentName, 80) ?? "Unnamed incident";
      const type = p.attr_IncidentTypeCategory === "RX" ? "Prescribed fire" : p.attr_IncidentTypeCategory === "WF" ? "Wildfire" : "Fire";
      const id = `wfigs-${fireId.replace(/[^A-Za-z0-9-]/g, "")}`.slice(0, 120);
      observations.push({
        id, layer: "fires", point: center, observedAt: stamp, source: "NIFC WFIGS",
        label: `${type} perimeter: ${name}`, title: name, freshness: fresh ? "fresh" : "stale",
        properties: {
          ...baseProps({ provider: "NIFC WFIGS", sourceUrl: HAZARD_FEED_INFO.wfigs.endpoint, retrievedAt, providerTimestamp: stamp, now, fresh, attribution: HAZARD_FEED_INFO.wfigs.attribution, termsUrl: HAZARD_FEED_INFO.wfigs.termsUrl, disclosure: "Reported interagency perimeter (U.S. incidents only, not every incident has one); marker is perimeter bbox centre" }),
          incidentType: type, gisAcres: finite(p.poly_GISAcres) ? Math.round(p.poly_GISAcres * 10) / 10 : null,
          percentContained: finite(p.attr_PercentContained) ? p.attr_PercentContained : null,
          mapMethod: str(p.poly_MapMethod, 60) ?? null, perimeterTime: validPast(p.poly_PolygonDateTime, now) ?? null,
          state: str(p.attr_POOState, 12) ?? null, uniqueFireId: fireId, vertexCount: main.length,
        },
      });
      outlines.push({ key: id, provider: "NIFC WFIGS", label: `${name} (${type})`, ring: main, observedAt: stamp, attribution: HAZARD_FEED_INFO.wfigs.attribution, sourceUrl: HAZARD_FEED_INFO.wfigs.endpoint });
    }
    const truncated = obj(body.properties) && body.properties.exceededTransferLimit === true;
    if (body.features.length > 0 && observations.length === 0) throw new Error("WFIGS returned no usable timestamped perimeters; malformed or future records were discarded");
    return { providerId, observations, outlines, retrievedAt, freshness: overall(observations), truncated, sourceUrl: HAZARD_FEED_INFO.wfigs.endpoint, keyStatus: "not_required", ...(observations.length ? {} : { error: "No timestamped perimeters returned; hazard freshness is unknown, not confirmation of safety" }) };
  });
}

// ---------------------------------------------------------------- NHC
const NHC_FRESH_MS = 7 * 3600_000;
const CLASS: Record<string, string> = { HU: "Hurricane", TS: "Tropical storm", TD: "Tropical depression", STS: "Subtropical storm", STD: "Subtropical depression", PTC: "Potential tropical cyclone", PC: "Post-tropical cyclone", TY: "Typhoon" };
export async function refreshNhc(options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<HazardResult> {
  const providerId = "noaa-nhc";
  if (options.network !== true) return failed(providerId, "Network access is opt-in");
  return throttled(providerId, "nhc", async () => {
    const body = await readJson(`${RELAY}/nhc`, options, fetcher, true);
    if (!obj(body) || !Array.isArray(body.storms) || body.provider !== "noaa-nhc") throw new Error("Invalid NHC relay response");
    const now = Date.now();
    const retrievedAt = validPast(body.retrievedAt, now) ?? new Date(now).toISOString();
    const observations: WorldObservation[] = [];
    const outlines: HazardOutline[] = [];
    const attribution = HAZARD_FEED_INFO.nhc.attribution, termsUrl = HAZARD_FEED_INFO.nhc.termsUrl;
    for (const s of body.storms.slice(0, 10)) {
      if (!obj(s) || typeof s.id !== "string" || !/^(al|ep|cp)\d{6}$/.test(s.id) || !finite(s.lat) || !finite(s.lon)) continue;
      if (Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) continue;
      const updated = validPast(s.lastUpdate, now);
      if (!updated) continue;
      const kind = CLASS[String(s.classification)] ?? "Tropical cyclone";
      const name = str(s.name, 40) ?? "Unnamed";
      const sourceUrl = str(s.publicAdvisoryUrl, 300) ?? HAZARD_FEED_INFO.nhc.endpoint;
      const fresh = now - Date.parse(updated) <= NHC_FRESH_MS;
      const disclosure = "Official advisory position; forecast cone is the probable track of the centre, not the hazard extent";
      observations.push({
        id: `nhc-${s.id}`, layer: "weather", point: { lat: s.lat, lon: s.lon }, observedAt: updated, source: "NOAA NHC/CPHC",
        label: `${kind} ${name} (advisory position)`, title: `${kind} ${name}`, freshness: fresh ? "fresh" : "stale",
        properties: {
          ...baseProps({ provider: s.centralPacific === true ? "NOAA CPHC" : "NOAA NHC", sourceUrl, retrievedAt, providerTimestamp: updated, now, fresh, attribution, termsUrl, disclosure }),
          classification: str(s.classification, 8) ?? null, maxWindKt: finite(s.intensityKt) ? s.intensityKt : null,
          pressureMb: finite(s.pressureMb) ? s.pressureMb : null, movementDirDeg: finite(s.movementDirDeg) ? s.movementDirDeg : null,
          movementSpeedMph: finite(s.movementSpeedMph) ? s.movementSpeedMph : null, advisoryNumber: str(s.advisoryNumber, 8) ?? null,
          advisoryIssued: validPast(s.advisoryIssued, now) ?? null, stormId: s.id, binNumber: str(s.binNumber, 4) ?? null,
        },
      });
      const fc = obj(s.forecast) ? s.forecast : {};
      const points = Array.isArray(fc.points) ? fc.points.filter(obj) : [];
      for (const p of points.slice(0, 20)) {
        const c = p.coordinates;
        if (p.type !== "Point" || !Array.isArray(c) || !finite(c[0]) || !finite(c[1])) continue;
        if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) continue;
        const pr = obj(p.properties) ? p.properties : {};
        const tau = finite(pr.tau) ? pr.tau : null;
        if (tau === 0) continue;
        observations.push({
          id: `nhc-${s.id}-tau${tau ?? observations.length}`, layer: "weather", point: { lon: c[0], lat: c[1] }, observedAt: updated,
          source: "NOAA NHC/CPHC", label: `${name} forecast position${tau != null ? ` +${tau}h` : ""} (forecast, not observed)`,
          freshness: fresh ? "fresh" : "stale",
          properties: {
            ...baseProps({ provider: "NOAA NHC GIS", sourceUrl: str(body.gisSourceUrl, 300) ?? sourceUrl, retrievedAt, providerTimestamp: updated, now, fresh, attribution, termsUrl, disclosure: "Forecast point issued with the advisory; not an observation" }),
            forecastHour: tau, validTimeLabel: str(pr.fldatelbl ?? pr.datelbl ?? pr.validtime, 60) ?? null,
            maxWindKt: finite(pr.maxwind) ? pr.maxwind : null, stormId: s.id,
          },
        });
      }
      const cones = Array.isArray(fc.cone) ? fc.cone.filter(obj) : [];
      for (const cone of cones.slice(0, 1)) {
        const ring = outerRings(cone)[0];
        if (ring && ring.length >= 3)
          outlines.push({ key: `nhc-cone-${s.id}`, provider: "NOAA NHC", label: `${name} forecast cone`, ring, observedAt: updated, attribution, sourceUrl: str(body.gisSourceUrl, 300) ?? sourceUrl });
      }
    }
    if (body.storms.length > 0 && observations.length === 0) throw new Error("NHC returned no usable timestamped advisories; malformed, future or out-of-range records were discarded");
    return { providerId, observations, outlines, retrievedAt, freshness: overall(observations), sourceUrl: HAZARD_FEED_INFO.nhc.endpoint, keyStatus: "not_required", ...(observations.length ? {} : { error: "No timestamped advisories returned; hazard freshness is unknown, not confirmation of safety" }) };
  });
}

// ---------------------------------------------------------------- nowCOAST
export type NowCoastOverlay = { layer: GlobeImageryLayer; validTime: string; blob: Blob; getMapUrl: string };
export function parseWmsDefaultTime(xml: string, layer: string): string | undefined {
  // Locate the named layer, then its time Dimension default (exact product time).
  const at = xml.indexOf(`<Name>${layer}</Name>`);
  const scope = at >= 0 ? xml.slice(at, at + 20000) : xml;
  const m = /<Dimension[^>]*name="time"[^>]*default="([^"]+)"/.exec(scope) ?? /<Dimension[^>]*default="([^"]+)"[^>]*name="time"/.exec(scope);
  const t = m?.[1];
  return t && Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : undefined;
}
export function nowCoastGetMapUrl(product: NowCoastProduct, bbox: HazardBbox, time: string, width = 1024): string {
  const p = NOWCOAST_PRODUCTS[product];
  const b = validateHazardBbox(bbox, 60);
  const w = Math.max(64, Math.min(1024, Math.round(width)));
  const h = Math.max(64, Math.min(1024, Math.round((w * (b.north - b.south)) / (b.east - b.west))));
  // WMS 1.3.0 with EPSG:4326 uses lat,lon axis order.
  const q = new URLSearchParams({ service: "WMS", version: "1.3.0", request: "GetMap", layers: p.layer, styles: "", format: "image/png", transparent: "true", crs: "EPSG:4326", bbox: `${b.south},${b.west},${b.north},${b.east}`, width: String(w), height: String(h), time });
  return `${NOWCOAST_ORIGIN}/geoserver/${p.workspace}/ows?${q}`;
}
export async function loadNowCoastOverlay(product: NowCoastProduct, bbox: HazardBbox, options: RefreshOptions = {}, fetcher: Fetcher = fetch, now = Date.now()): Promise<NowCoastOverlay> {
  const p = NOWCOAST_PRODUCTS[product];
  if (!p) throw new Error("Unknown nowCOAST product");
  const b = validateHazardBbox(bbox, 60);
  const capsUrl = `${NOWCOAST_ORIGIN}/geoserver/${p.workspace}/${p.layer}/ows?service=WMS&request=GetCapabilities&version=1.3.0`;
  const capsResp = await request(capsUrl, options, fetcher, "text/xml, application/xml");
  if (!capsResp.ok) throw new Error(`nowCOAST capabilities HTTP ${capsResp.status}`);
  const xml = new TextDecoder().decode(await readBounded(capsResp, JSON_MAX));
  const validTime = parseWmsDefaultTime(xml, p.layer);
  if (!validTime) throw new Error("nowCOAST capabilities did not declare an exact product time; overlay not requested");
  const getMapUrl = nowCoastGetMapUrl(product, b, validTime);
  const imgResp = await request(getMapUrl, options, fetcher, "image/png");
  if (!imgResp.ok) throw new Error(`nowCOAST GetMap HTTP ${imgResp.status}`);
  const type = (imgResp.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/png") throw new Error("nowCOAST returned a non-PNG response (often a WMS exception)");
  const bytes = await readBounded(imgResp, IMAGE_MAX);
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const ageMs = now - Date.parse(validTime);
  const layer: GlobeImageryLayer = {
    key: `nowcoast-${product}`, provider: "NOAA nowCOAST", productId: `${p.title} · valid ${validTime.replace(".000Z", "Z")} UTC`,
    sourceUrl: getMapUrl, termsUrl: HAZARD_FEED_INFO.nowcoast.termsUrl,
    acquisitionStart: validTime, retrievedAt: new Date(now).toISOString(),
    footprint: [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]],
    attribution: p.credit, license: HAZARD_FEED_INFO.nowcoast.termsUrl,
    freshness: ageMs <= 30 * 60_000 ? "recent" : "stale", refreshState: "manual",
    coverageNote: `WMS GetMap for the requested bbox at the product's exact time ${validTime} (UTC); areas outside product coverage are transparent.`,
    registrationNote: "WMS raster is north-up in the exact requested EPSG:4326 bbox; globe vertices derive from that bbox and are clipped by the separate imagery AOI when one is selected.",
  };
  return { layer, validTime, blob, getMapUrl };
}

/** Express a polygon outline as a footprint-only globe layer (no image). */
export function outlineLayer(o: HazardOutline, now = Date.now()): GlobeImageryLayer {
  const age = now - Date.parse(o.observedAt);
  return {
    key: `outline-${o.key}`.slice(0, 120), provider: o.provider, productId: o.label, retrievedAt: new Date(now).toISOString(),
    acquisitionStart: o.observedAt, footprint: o.ring, attribution: o.attribution, license: o.sourceUrl,
    freshness: age <= 72 * 3600_000 ? "recent" : "stale", refreshState: "manual",
    coverageNote: o.provider === "NOAA NHC" ? "Forecast cone: probable track of the centre only, not hazard extent." : "Reported perimeter outline (simplified to at most 200 vertices).",
    registrationNote: "Outline only; no imagery.",
  };
}
