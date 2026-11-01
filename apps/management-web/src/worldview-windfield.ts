/* WorldView gridded wind field (map layer) from Open-Meteo.
 * Read-only, manually opted-in, bounded, throttled, cached. A bounded grid of
 * at most 100 points is sampled over the visible globe viewport in ONE
 * multi-location request (Open-Meteo accepts comma-separated lat/lon lists).
 * Keyless reads go direct from the browser (CORS "*", free non-commercial
 * tier); with the commercial key configured on the server the same grid goes
 * through the disabled-by-default weather relay, which holds the key. The
 * relay builds the sample points itself from bbox + grid shape.
 * Model output is a forecast, never an observation, and is labelled as such.
 */
import type { Freshness } from "./worldview-core";
import type { GlobeBounds } from "./worldview-globe-viewport";
import { WEATHER_MODELS, WEATHER_RELAY_PREFIX, WEATHER_SOURCES, isWeatherModel, type WeatherModel } from "./worldview-weather";

export const GRID_HOURS = 24;
export const MAX_GRID_POINTS = 100;
export const MAX_GRID_SIDE = 10;
export const GRID_MAX_BYTES = 1_500_000;
/** Direct (keyless) refresh spacing per grid kind; a 100-point, 14-variable grid costs ~140 Open-Meteo "calls". */
export const MIN_DIRECT_GRID_INTERVAL_MS = 120_000;
const GRID_CACHE_MS = 15 * 60_000;
const MODEL_RUN_STALE_MS = 18 * 3600_000;
const ALLOWED_GRID_ORIGINS = ["https://api.open-meteo.com", "https://air-quality-api.open-meteo.com"];

export type GridStatus = "live" | "stale" | "unknown" | "failed" | "not_configured" | "disabled" | "throttled";
export type GridFetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface GridOptions {
  network?: boolean;
  /** Route through the same-origin weather relay (server-held commercial key). */
  relay?: boolean;
  signal?: AbortSignal;
  fetcher?: GridFetcher;
  now?: () => number;
}

/** Continuous lon span: east may exceed 180 when the view crosses the antimeridian. */
export interface GridSpan { west: number; south: number; east: number; north: number }
export interface GridShape { rows: number; cols: number }
export interface GridField {
  rows: number;
  cols: number;
  span: GridSpan;
  /** Cell centres, row-major south→north, west→east, lon normalised to ±180. */
  points: ReadonlyArray<readonly [number, number]>;
  /** ISO UTC valid hours. */
  times: string[];
  /** values[variable][hourIndex][pointIndex] */
  values: Record<string, Array<Array<number | null>>>;
  units: Record<string, string>;
}
export interface GridProvenance {
  provider: string;
  providerId: string;
  dataKind: string;
  sourceUrl: string;
  retrievedAt: string;
  /** Model run initialisation (forecast) when the provider exposes it. */
  modelRun?: string;
  validFrom?: string;
  validTo?: string;
  attribution: string;
  termsUrl: string;
  licenseUrl: string;
  tier: string;
  route: "direct" | "relay";
  freshness: Freshness;
  ageSeconds: number | null;
  cache: "hit" | "miss";
  pointCount: number;
}
export interface GridResult {
  status: GridStatus;
  field?: GridField;
  provenance?: GridProvenance;
  error?: string;
  retrievedAt: string;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const wrap180 = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

class GridError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- grid geometry

/** One continuous span covering the globe viewport rectangles (1 or 2 when the view crosses ±180°). */
export function viewportSpan(bounds: ReadonlyArray<GlobeBounds>): GridSpan | null {
  const valid = (bounds ?? []).filter((b) => [b?.west, b?.south, b?.east, b?.north].every(finite) && b.west < b.east && b.south < b.north).slice(0, 2);
  if (!valid.length) return null;
  const south = Math.max(-89.5, Math.min(...valid.map((b) => b.south)));
  const north = Math.min(89.5, Math.max(...valid.map((b) => b.north)));
  if (south >= north) return null;
  if (valid.length === 1) return { west: r4(Math.max(-180, valid[0].west)), south: r4(south), east: r4(Math.min(180, valid[0].east)), north: r4(north) };
  const [a, b] = valid[0].west <= valid[1].west ? [valid[0], valid[1]] : [valid[1], valid[0]];
  // a touches -180, b touches +180: the visible strip runs b.west → a.east + 360.
  if (a.west <= -179.9 && b.east >= 179.9) {
    const west = b.west, east = a.east + 360;
    return east - west >= 359.9 ? { west: -180, south: r4(south), east: 180, north: r4(north) } : { west: r4(west), south: r4(south), east: r4(east), north: r4(north) };
  }
  return { west: r4(a.west), south: r4(south), east: r4(Math.max(a.east, b.east)), north: r4(north) };
}

/** Rows/cols following the span's aspect (cos-lat corrected), each 2..10, product ≤ maxPoints. */
export function chooseGridShape(span: GridSpan, maxPoints = 64): GridShape {
  const cap = Math.max(4, Math.min(MAX_GRID_POINTS, Math.floor(maxPoints)));
  const midLat = ((span.north + span.south) / 2) * (Math.PI / 180);
  const width = Math.max(0.01, (span.east - span.west) * Math.max(0.2, Math.cos(midLat)));
  const height = Math.max(0.01, span.north - span.south);
  let rows = Math.max(2, Math.min(MAX_GRID_SIDE, Math.round(Math.sqrt((cap * height) / width))));
  let cols = Math.max(2, Math.min(MAX_GRID_SIDE, Math.floor(cap / rows)));
  while (rows * cols > cap && rows > 2) rows--;
  while (rows * cols > cap && cols > 2) cols--;
  return { rows, cols };
}

/** Same algorithm as the relay (worldview_windair.grid_points): cell centres, 2-decimal rounding. */
export function gridPoints(span: GridSpan, shape: GridShape): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < shape.rows; i++) {
    const lat = r2(span.south + ((i + 0.5) * (span.north - span.south)) / shape.rows);
    for (let j = 0; j < shape.cols; j++) out.push([lat, r2(wrap180(span.west + ((j + 0.5) * (span.east - span.west)) / shape.cols))]);
  }
  return out;
}

function validShape(shape: GridShape): boolean {
  return Number.isInteger(shape?.rows) && Number.isInteger(shape?.cols) && shape.rows >= 2 && shape.cols >= 2 &&
    shape.rows <= MAX_GRID_SIDE && shape.cols <= MAX_GRID_SIDE && shape.rows * shape.cols <= MAX_GRID_POINTS;
}

/**
 * Bilinear sample between cell centres. `lon` may be given in either ±180 or
 * the span's unwrapped frame. Corners with null values are dropped and the
 * remaining weights renormalised; null when no corner has data.
 */
export function sampleField(field: GridField, values: ReadonlyArray<number | null> | undefined, lat: number, lon: number): number | null {
  if (!values) return null;
  const { rows, cols, span } = field;
  let x = lon;
  while (x < span.west) x += 360;
  while (x > span.west + 360) x -= 360;
  const fy = ((lat - span.south) / (span.north - span.south)) * rows - 0.5;
  const fx = ((x - span.west) / (span.east - span.west)) * cols - 0.5;
  const cy = Math.max(0, Math.min(rows - 1, fy)), cx = Math.max(0, Math.min(cols - 1, fx));
  const i0 = Math.floor(cy), j0 = Math.floor(cx), i1 = Math.min(rows - 1, i0 + 1), j1 = Math.min(cols - 1, j0 + 1);
  const ty = cy - i0, tx = cx - j0;
  let sum = 0, weight = 0;
  for (const [i, j, w] of [[i0, j0, (1 - ty) * (1 - tx)], [i0, j1, (1 - ty) * tx], [i1, j0, ty * (1 - tx)], [i1, j1, ty * tx]] as const) {
    const v = values[i * cols + j];
    if (w > 0 && finite(v)) { sum += v * w; weight += w; }
  }
  if (weight <= 0) {
    const v = values[Math.round(cy) * cols + Math.round(cx)];
    return finite(v) ? v : null;
  }
  return sum / weight;
}

export function insideSpan(span: GridSpan, lat: number, lon: number): boolean {
  if (lat < span.south || lat > span.north) return false;
  let x = lon;
  while (x < span.west) x += 360;
  return x <= span.east;
}

// ---------------------------------------------------------------- transport

const lastDirect = new Map<string, number>();
const cache = new Map<string, { at: number; result: GridResult }>();
export function resetGridState(): void {
  lastDirect.clear();
  cache.clear();
}

async function readBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > GRID_MAX_BYTES) throw new Error("Provider response exceeds 1.5 MB");
  if (!response.body) throw new Error("Provider returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > GRID_MAX_BYTES) {
      await reader.cancel();
      throw new Error("Provider response exceeds 1.5 MB");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** GET JSON from the Open-Meteo allowlist (direct) or the same-origin weather relay. */
export async function fetchGridJson(url: string, options: GridOptions, relay: boolean): Promise<unknown> {
  if (options.network !== true) throw new GridError(0, "opt_in", "Network access is opt-in");
  if (relay) {
    if (!url.startsWith(`${WEATHER_RELAY_PREFIX}/`)) throw new GridError(0, "not_allowlisted", "Relay path is not allowlisted");
  } else {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_GRID_ORIGINS.includes(parsed.origin) || parsed.username || parsed.password)
      throw new GridError(0, "not_allowlisted", "URL is not on the HTTPS provider allowlist");
  }
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetcher(url, {
      method: "GET", redirect: "error", credentials: relay ? "same-origin" : "omit", referrerPolicy: "no-referrer", cache: "no-store", signal,
      headers: relay ? { Accept: "application/json", "X-SignalWarden-Weather": "enabled" } : { Accept: "application/json" },
    });
    if (!response.ok) {
      let code = "provider_error", message = `HTTP ${response.status}`;
      try {
        const body = (await readBounded(response)) as { error?: { code?: unknown; message?: unknown } | boolean; reason?: unknown };
        const err = typeof body?.error === "object" && body.error ? body.error : undefined;
        if (typeof err?.code === "string") code = err.code.slice(0, 64);
        if (typeof err?.message === "string") message = err.message.slice(0, 240);
        else if (typeof body?.reason === "string") message = `HTTP ${response.status}: ${body.reason.slice(0, 200)}`;
      } catch { /* keep generic */ }
      throw new GridError(response.status, code, message);
    }
    return await readBounded(response);
  } finally {
    clearTimeout(timer);
  }
}

export function gridStatusFromError(e: unknown): { status: GridStatus; error: string } {
  if (e instanceof GridError) {
    if (e.code === "not_configured") return { status: "not_configured", error: e.message };
    if (e.code === "weather_relay_disabled" || (e.status === 404 && e.code === "not_found"))
      return { status: "disabled", error: "Relay disabled: set UCAS_WORLDVIEW_WEATHER_ENABLED=1 on the API server and route /api/v1/worldview-weather to it" };
    if (e.status === 429) return { status: "throttled", error: e.message };
    return { status: "failed", error: e.message };
  }
  return { status: "failed", error: e instanceof Error ? e.message : "Request failed" };
}

function isoUtcHour(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}:00Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Parse Open-Meteo multi-location output (array, or one object for a single point) into a grid. */
export function parseGridLocations(data: unknown, variables: readonly string[], span: GridSpan, shape: GridShape): GridField {
  const rows = Array.isArray(data) ? data : [data];
  const count = shape.rows * shape.cols;
  if (rows.length !== count) throw new Error(`Open-Meteo returned ${rows.length} locations; expected ${count}`);
  const first = rows[0] as { hourly?: Record<string, unknown>; location_id?: unknown };
  const firstRawTimes = Array.isArray(first?.hourly?.time) ? (first.hourly!.time as unknown[]).slice(0, GRID_HOURS) : [];
  const times = firstRawTimes.map(isoUtcHour);
  if (!times.length || times.some((t): t is undefined => !t)) throw new Error("Open-Meteo grid has no valid hourly times");
  for (let i = 1; i < times.length; i++) {
    if (Date.parse(times[i]!) <= Date.parse(times[i - 1]!)) throw new Error("Open-Meteo grid hourly times are not strictly increasing");
  }
  const canonicalTimes = times as string[];
  const values: Record<string, Array<Array<number | null>>> = {};
  for (const v of variables) values[v] = canonicalTimes.map(() => new Array<number | null>(count).fill(null));
  const units: Record<string, string> = {};
  const seen = new Set<number>();
  const usable = new Map<string, number>();
  rows.forEach((raw, p) => {
    const loc = raw as { hourly?: Record<string, unknown>; hourly_units?: Record<string, unknown>; location_id?: unknown };
    const hasLocationId = loc && Object.hasOwn(loc, "location_id");
    if (hasLocationId && (!finite(loc.location_id) || !Number.isInteger(loc.location_id) || loc.location_id < 0 || loc.location_id >= count))
      throw new Error("Open-Meteo grid has an out-of-range location_id");
    const idx = hasLocationId ? loc.location_id as number : p;
    if (seen.has(idx)) throw new Error("Open-Meteo grid has duplicate location_id values");
    seen.add(idx);
    const hourly = loc?.hourly;
    if (!hourly || !Array.isArray(hourly.time)) throw new Error("Open-Meteo grid location has no hourly time array");
    const rowTimes = hourly.time.slice(0, GRID_HOURS).map(isoUtcHour);
    if (rowTimes.length !== canonicalTimes.length || rowTimes.some((t, i) => t !== canonicalTimes[i]))
      throw new Error("Open-Meteo grid locations have inconsistent hourly times");
    for (const v of variables) {
      const s = hourly[v];
      if (!Array.isArray(s) || s.length !== canonicalTimes.length) continue;
      let valid = 0;
      for (let h = 0; h < canonicalTimes.length; h++) {
        values[v][h][idx] = finite(s[h]) ? s[h] : null;
        if (finite(s[h])) valid++;
      }
      usable.set(v, (usable.get(v) ?? 0) + valid);
      if (typeof loc.hourly_units?.[v] === "string" && !units[v]) units[v] = String(loc.hourly_units[v]).slice(0, 16);
    }
  });
  if (seen.size !== count || [...Array(count).keys()].some((i) => !seen.has(i))) throw new Error("Open-Meteo grid location_ids are incomplete");
  const minCells = Math.max(1, Math.ceil(count * canonicalTimes.length * 0.25));
  const usableFields = variables.filter((v) => (usable.get(v) ?? 0) >= minCells).length;
  if (usableFields < Math.ceil(variables.length / 2)) throw new Error("Open-Meteo grid has insufficient usable fields");
  const pts = gridPoints(span, shape);
  return { rows: shape.rows, cols: shape.cols, span, points: pts, times: canonicalTimes, values, units };
}

export interface GridRequest {
  kind: "wind" | "air";
  variables: readonly string[];
  directUrl: (lats: string, lons: string) => string;
  relayPath: (bbox: string, grid: string) => string;
  provider: string;
  providerId: string;
  dataKind: string;
  attribution: string;
  termsUrl: string;
  licenseUrl: string;
  modelMeta?: string;
  cacheKey: string;
}

/** Shared bounded grid fetch used by the wind and air layers. */
export async function fetchGrid(req: GridRequest, span: GridSpan, shape: GridShape, options: GridOptions): Promise<GridResult> {
  const now = (options.now ?? Date.now)();
  const retrievedAt = new Date(now).toISOString();
  if (options.network !== true) return { status: "failed", error: "Network access is opt-in", retrievedAt };
  if (!validShape(shape)) return { status: "failed", error: `Grid must be 2-${MAX_GRID_SIDE} per side and ≤${MAX_GRID_POINTS} points`, retrievedAt };
  if (![span?.west, span?.south, span?.east, span?.north].every(finite) || span.west >= span.east || span.south >= span.north || span.east - span.west > 360)
    return { status: "failed", error: "Invalid viewport span", retrievedAt };
  const route: "direct" | "relay" = options.relay ? "relay" : "direct";
  const pts = gridPoints(span, shape);
  const key = `${req.cacheKey}|${route}|${shape.rows}x${shape.cols}|${pts.map((p) => p.join(",")).join(";")}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < GRID_CACHE_MS && hit.result.provenance) {
    const provenance = { ...hit.result.provenance, cache: "hit" as const, ...ages(hit.result.provenance, now) };
    const status: GridStatus = provenance.freshness === "fresh" ? "live" : provenance.freshness === "stale" ? "stale" : "unknown";
    const { error: _previousError, ...cached } = hit.result;
    return { ...cached, status, provenance,
      ...(status === "stale" ? { error: "Forecast run is old or the series no longer covers the current hour" }
        : status === "unknown" ? { error: "Provider model-run time is unavailable; data is not labeled live" } : {}) };
  }
  try {
    let data: unknown, sourceUrl: string, modelRun: string | undefined, tier = "free_non_commercial";
    if (route === "relay") {
      const bbox = [span.west, span.south, span.east, span.north].map((v) => r4(v)).join(",");
      const body = (await fetchGridJson(req.relayPath(bbox, `${shape.rows}x${shape.cols}`), options, true)) as Record<string, unknown>;
      if (typeof body?.sourceUrl !== "string" || !Array.isArray(body.locations)) throw new Error("Invalid weather relay grid response");
      data = body.locations.map((loc: unknown) => (loc && typeof loc === "object" ? loc : {}));
      sourceUrl = body.sourceUrl;
      if (typeof body.modelRun === "string" && Number.isFinite(Date.parse(body.modelRun))) modelRun = new Date(body.modelRun).toISOString();
      if (typeof body.tier === "string") tier = body.tier.slice(0, 32);
    } else {
      const last = lastDirect.get(req.cacheKey);
      if (last !== undefined && now - last < MIN_DIRECT_GRID_INTERVAL_MS)
        throw new GridError(429, "client_throttled", `Grid refresh throttled (free tier); wait ${Math.ceil((MIN_DIRECT_GRID_INTERVAL_MS - (now - last)) / 1000)}s`);
      lastDirect.set(req.cacheKey, now);
      sourceUrl = req.directUrl(pts.map((p) => p[0].toFixed(2)).join(","), pts.map((p) => p[1].toFixed(2)).join(","));
      data = await fetchGridJson(sourceUrl, options, false);
      if (req.modelMeta) {
        try {
          const meta = (await fetchGridJson(`https://api.open-meteo.com/data/${req.modelMeta}/static/meta.json`, options, false)) as { last_run_initialisation_time?: unknown };
          if (finite(meta?.last_run_initialisation_time)) modelRun = new Date(meta.last_run_initialisation_time * 1000).toISOString();
        } catch { /* model run unknown; disclosed as freshness "unknown" */ }
      }
    }
    const field = parseGridLocations(data, req.variables, span, shape);
    const base: GridProvenance = {
      provider: req.provider, providerId: req.providerId, dataKind: req.dataKind, sourceUrl, retrievedAt, modelRun,
      validFrom: field.times[0], validTo: field.times[field.times.length - 1], attribution: req.attribution, termsUrl: req.termsUrl,
      licenseUrl: req.licenseUrl, tier, route, freshness: "unknown", ageSeconds: null, cache: "miss", pointCount: pts.length,
    };
    const provenance = { ...base, ...ages(base, now) };
    const status: GridStatus = provenance.freshness === "fresh" ? "live" : provenance.freshness === "stale" ? "stale" : "unknown";
    const result: GridResult = { status, field, provenance, retrievedAt };
    if (cache.size >= 16) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, result });
    return provenance.freshness === "stale" ? { ...result, error: "Forecast run is old or the series no longer covers the current hour" }
      : provenance.freshness === "unknown" ? { ...result, error: "Provider model-run time is unavailable; data is not labeled live" } : result;
  } catch (e) {
    return { ...gridStatusFromError(e), retrievedAt };
  }
}

function ages(p: GridProvenance, now: number): Pick<GridProvenance, "freshness" | "ageSeconds"> {
  const firstValid = p.validFrom ? Date.parse(p.validFrom) : NaN;
  const lastValid = p.validTo ? Date.parse(p.validTo) : NaN;
  const covers = Number.isFinite(firstValid) && firstValid <= now && Number.isFinite(lastValid) && lastValid + 3600_000 > now;
  if (p.modelRun) {
    const age = now - Date.parse(p.modelRun);
    return { freshness: !covers || age > MODEL_RUN_STALE_MS || age < -300_000 ? "stale" : "fresh", ageSeconds: Math.round(age / 1000) };
  }
  const retrievedAge = now - Date.parse(p.retrievedAt);
  return { freshness: !covers ? "stale" : p.dataKind.includes("model forecast") ? "unknown" : "fresh", ageSeconds: Math.round(retrievedAge / 1000) };
}

/** Index of the hour closest to `now` (or 0). */
export function currentHourIndex(times: readonly string[], now: number): number {
  let best = 0;
  for (let i = 0; i < times.length; i++) if (Date.parse(times[i]) <= now) best = i;
  return best;
}

// ---------------------------------------------------------------- wind

export const WIND_GRID_VARIABLES = [
  "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
  "wind_speed_80m", "wind_direction_80m", "wind_speed_120m", "wind_direction_120m",
  "wind_speed_850hPa", "wind_direction_850hPa", "wind_speed_500hPa", "wind_direction_500hPa",
  "wind_speed_250hPa", "wind_direction_250hPa", "pressure_msl",
] as const;

export const WIND_LEVELS = Object.freeze({
  "10m": { label: "10 m (surface)", speed: "wind_speed_10m", direction: "wind_direction_10m", note: "Standard surface wind" },
  gusts: { label: "10 m gusts", speed: "wind_gusts_10m", direction: "wind_direction_10m", note: "Gust speed; direction from 10 m mean wind" },
  "80m": { label: "80 m", speed: "wind_speed_80m", direction: "wind_direction_80m", note: "Low-level / small-UAS band" },
  "120m": { label: "120 m", speed: "wind_speed_120m", direction: "wind_direction_120m", note: "Near the 400 ft small-UAS ceiling" },
  "850hPa": { label: "850 hPa (~1.5 km)", speed: "wind_speed_850hPa", direction: "wind_direction_850hPa", note: "Low-level aviation; height varies with pressure" },
  "500hPa": { label: "500 hPa (~5.5 km)", speed: "wind_speed_500hPa", direction: "wind_direction_500hPa", note: "Mid-troposphere steering flow" },
  "250hPa": { label: "250 hPa (~10.4 km)", speed: "wind_speed_250hPa", direction: "wind_direction_250hPa", note: "Jet-stream / cruise level" },
});
export type WindLevel = keyof typeof WIND_LEVELS;
export const isWindLevel = (v: unknown): v is WindLevel => typeof v === "string" && Object.hasOwn(WIND_LEVELS, v);

/** Meteorological direction is where the wind blows FROM; u east-, v north-ward (m/s). */
export function windToUV(speed: number, directionFromDeg: number): { u: number; v: number } {
  const t = (directionFromDeg * Math.PI) / 180;
  return { u: -speed * Math.sin(t), v: -speed * Math.cos(t) };
}
export function uvToWind(u: number, v: number): { speed: number; directionFrom: number } {
  return { speed: Math.hypot(u, v), directionFrom: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
}

/** Per-point u/v for a level and hour (null where the model has no value, e.g. 80 m in some models). */
export function windComponents(field: GridField, level: WindLevel, hour: number): { u: Array<number | null>; v: Array<number | null> } {
  const def = WIND_LEVELS[level];
  const sp = field.values[def.speed]?.[hour] ?? [];
  const dir = field.values[def.direction]?.[hour] ?? [];
  const u: Array<number | null> = [], v: Array<number | null> = [];
  for (let i = 0; i < field.points.length; i++) {
    const s = sp[i], d = dir[i];
    if (finite(s) && finite(d)) { const c = windToUV(s, d); u.push(c.u); v.push(c.v); }
    else { u.push(null); v.push(null); }
  }
  return { u, v };
}

export type WindSampler = (lat: number, lon: number) => { u: number; v: number; speed: number } | null;
/** Interpolates u/v (not speed/direction) so the field stays physically consistent. */
export function windSampler(field: GridField, level: WindLevel, hour: number): WindSampler {
  const { u, v } = windComponents(field, level, hour);
  return (lat, lon) => {
    if (!insideSpan(field.span, lat, lon)) return null;
    const a = sampleField(field, u, lat, lon), b = sampleField(field, v, lat, lon);
    return a === null || b === null ? null : { u: a, v: b, speed: Math.hypot(a, b) };
  };
}

export interface WindArrow { lat: number; lon: number; speed: number; directionFrom: number; color: readonly [number, number, number] }
export function windArrows(field: GridField, level: WindLevel, hour: number): WindArrow[] {
  const def = WIND_LEVELS[level];
  const sp = field.values[def.speed]?.[hour] ?? [];
  const dir = field.values[def.direction]?.[hour] ?? [];
  const out: WindArrow[] = [];
  field.points.forEach(([lat, lon], i) => {
    const s = sp[i], d = dir[i];
    if (finite(s) && finite(d)) out.push({ lat, lon, speed: s, directionFrom: d, color: speedColor(s) });
  });
  return out;
}

/** Speed legend in m/s (also shown in knots for aviation users). */
export const SPEED_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [98, 113, 183]], [3, [57, 160, 202]], [6, [74, 199, 160]], [10, [160, 214, 76]],
  [15, [240, 210, 70]], [20, [242, 150, 55]], [30, [225, 80, 70]], [45, [190, 60, 150]], [60, [240, 230, 255]],
];
export function speedColor(speed: number): readonly [number, number, number] {
  if (!finite(speed) || speed <= SPEED_STOPS[0][0]) return SPEED_STOPS[0][1];
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [s1, c1] = SPEED_STOPS[i];
    if (speed <= s1) {
      const [s0, c0] = SPEED_STOPS[i - 1];
      const t = (speed - s0) / (s1 - s0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as unknown as readonly [number, number, number];
    }
  }
  return SPEED_STOPS[SPEED_STOPS.length - 1][1];
}
export const msToKnots = (ms: number) => ms * 1.943844;

// ---------------------------------------------------------------- particles (pure, testable)

export interface Particle { lat: number; lon: number; age: number; trail: Array<[number, number]> }
export type Rand = () => number;
export const PARTICLE_TRAIL = 4;

function spawn(span: GridSpan, rand: Rand, maxAge: number): Particle {
  const lat = span.south + rand() * (span.north - span.south);
  const lon = wrap180(span.west + rand() * (span.east - span.west));
  return { lat, lon, age: Math.floor(rand() * maxAge), trail: [[lat, lon]] };
}
export function createParticles(count: number, span: GridSpan, rand: Rand = Math.random, maxAge = 90): Particle[] {
  const n = Math.max(0, Math.min(2000, Math.floor(count)));
  return Array.from({ length: n }, () => spawn(span, rand, maxAge));
}
/**
 * Advects particles one animation step. `degPerMsPerSecond` scales m/s to
 * screen-friendly degrees/second; it is a visual speed-up, not physical time.
 */
export function stepParticles(particles: Particle[], sampler: WindSampler, span: GridSpan, dtSeconds: number, rand: Rand = Math.random, maxAge = 90, degPerMsPerSecond = 0.012): void {
  const dt = Math.max(0, Math.min(0.1, dtSeconds));
  for (let k = 0; k < particles.length; k++) {
    const p = particles[k];
    const w = p.age < maxAge ? sampler(p.lat, p.lon) : null;
    if (!w) { particles[k] = spawn(span, rand, maxAge); particles[k].age = 0; continue; }
    const scale = degPerMsPerSecond * dt;
    const cosLat = Math.max(0.15, Math.cos((p.lat * Math.PI) / 180));
    p.lat = Math.max(-89.5, Math.min(89.5, p.lat + w.v * scale));
    p.lon = wrap180(p.lon + (w.u * scale) / cosLat);
    p.age++;
    p.trail.unshift([p.lat, p.lon]);
    if (p.trail.length > PARTICLE_TRAIL) p.trail.length = PARTICLE_TRAIL;
  }
}

// ---------------------------------------------------------------- refresh

export const windFieldSource = (model: WeatherModel) => `Open-Meteo wind grid · ${WEATHER_MODELS[model].label}`;

/** Gridded wind over the visible span: 10/80/120 m, gusts, 850/500/250 hPa and MSL pressure, 24 h. */
export async function refreshWindField(span: GridSpan, shape: GridShape, model: WeatherModel, options: GridOptions = {}): Promise<GridResult> {
  const now = (options.now ?? Date.now)();
  if (!isWeatherModel(model)) return { status: "failed", error: "Unknown model", retrievedAt: new Date(now).toISOString() };
  const src = WEATHER_SOURCES.openMeteo;
  return fetchGrid({
    kind: "wind", variables: WIND_GRID_VARIABLES, provider: `${src.name} · ${WEATHER_MODELS[model].label}`, providerId: "open-meteo",
    dataKind: "model forecast (not an observation)", attribution: `${src.attribution}; ${WEATHER_MODELS[model].attribution}`,
    termsUrl: src.termsUrl, licenseUrl: src.licenseUrl, modelMeta: WEATHER_MODELS[model].meta, cacheKey: `wind:${model}`,
    directUrl: (lats, lons) => `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      latitude: lats, longitude: lons, hourly: WIND_GRID_VARIABLES.join(","), models: model,
      forecast_hours: String(GRID_HOURS), wind_speed_unit: "ms", timezone: "GMT",
    })}`,
    relayPath: (bbox, grid) => `${WEATHER_RELAY_PREFIX}/open-meteo/wind-grid?${new URLSearchParams({ bbox, grid, model })}`,
  }, span, shape, options);
}

/** Min / max / mean for a variable at an hour (panel readout). */
export function fieldStats(field: GridField, variable: string, hour: number): { min: number; max: number; mean: number; count: number } | null {
  const vals = (field.values[variable]?.[hour] ?? []).filter(finite);
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals), mean: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length };
}
