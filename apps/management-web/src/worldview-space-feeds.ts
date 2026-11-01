/*
 * Space situational-awareness feeds for WorldView. Read-only, manually
 * opted-in, bounded, throttled and attributed.
 *
 *  - CelesTrak GP catalog (orbital ELEMENTS; keyless, CORS-enabled, browser read)
 *  - NWS gridpoint skyCover and Open-Meteo cloud_cover (cloud FORECASTS; keyless)
 *  - SatNOGS Network (RADIO observations by volunteer ground stations; via the
 *    opt-in server relay because the API sends no CORS headers)
 *  - Launch Library 2 (scheduled launch EVENTS; keyless browser read, or the
 *    server relay when UCAS_LAUNCH_LIBRARY_API_KEY is configured server-side)
 *
 * Nothing here is an optical sighting. Forecast vs observed is explicit on
 * every result via `kind`.
 */
import * as satellite from "satellite.js";
import type { SatRec } from "satellite.js";
import { elementUncertainty, type ElementAgeStatus } from "./worldview-space-visibility";

export type SpaceFreshness = "fresh" | "cached" | "stale" | "unknown" | "failed" | "not_configured" | "disabled";
export type SpaceSourceMeta = {
  provider: string;
  kind: "orbital-elements" | "cloud-forecast" | "radio-observations" | "launch-schedule";
  sourceUrl: string;
  retrievedAt: string | null;
  providerTimestamp: string | null;
  ageSeconds: number | null;
  freshness: SpaceFreshness;
  attribution: string;
  license: string;
  licenseUrl: string;
  note?: string;
  error?: string;
};
export type SpaceOptions = {
  network?: boolean;
  openMeteoTermsConfirmed?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  fetcher?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

export const SPACE_PROVIDERS = Object.freeze({
  celestrak: Object.freeze({
    name: "CelesTrak GP (general perturbations) elements",
    endpoint: "https://celestrak.org/NORAD/elements/gp.php",
    attribution: "Orbital elements: CelesTrak (Dr. T.S. Kelso), derived from US Space Force 18th SDS data",
    license: "CelesTrak usage policy; cite CelesTrak as the source",
    licenseUrl: "https://celestrak.org/webmaster.php",
    limits: "Manual GET; allowlisted groups, NORAD ID or name; <=400 objects; <=1 MiB; same query never re-downloaded within 2 hours (CelesTrak update cadence/policy)",
  }),
  nwsSky: Object.freeze({
    name: "NOAA/NWS gridpoint skyCover forecast",
    endpoint: "https://api.weather.gov/gridpoints/{wfo}/{x},{y}",
    attribution: "Cloud forecast: NOAA/National Weather Service",
    license: "US Government work; NWS API terms; no endorsement",
    licenseUrl: "https://www.weather.gov/disclaimer",
    limits: "Manual GET; US/territories only; <=1 MiB; cached 1 hour per point; >=60 s throttle",
  }),
  openMeteo: Object.freeze({
    name: "Open-Meteo forecast cloud_cover",
    endpoint: "https://api.open-meteo.com/v1/forecast",
    attribution: "Weather data by Open-Meteo.com",
    license: "CC BY 4.0; free API for non-commercial use (commercial use requires an Open-Meteo plan)",
    licenseUrl: "https://open-meteo.com/en/terms",
    limits: "Manual GET; 3-day hourly; cached 1 hour per point; >=60 s throttle",
  }),
  satnogs: Object.freeze({
    name: "SatNOGS Network radio observations",
    endpoint: "https://network.satnogs.org/api/observations/",
    attribution: "Radio observations: SatNOGS Network by Libre Space Foundation and volunteer ground stations",
    license: "SatNOGS data CC BY-SA 4.0",
    licenseUrl: "https://network.satnogs.org/",
    limits: "Via opt-in server relay (UCAS_SPACE_RELAY_ENABLED=1); one NORAD ID; <=25 past observations; cached 10 minutes",
  }),
  launchLibrary: Object.freeze({
    name: "The Space Devs Launch Library 2 (upcoming launches)",
    endpoint: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/",
    attribution: "Launch data: The Space Devs Launch Library 2",
    license: "Launch Library 2 API terms (free tier 15 requests/hour without key)",
    licenseUrl: "https://thespacedevs.com/llapi",
    limits: "Manual GET; <=10 launches; cached 15 minutes; keyless browser reads >=10 min apart; optional server-side UCAS_LAUNCH_LIBRARY_API_KEY via relay",
  }),
});

export const CELESTRAK_GROUPS = Object.freeze([
  "stations",
  "visual",
  "weather",
  "goes",
  "resource",
  "sarsat",
  "amateur",
  "cubesat",
  "science",
  "geodetic",
  "engineering",
  "education",
  "gps-ops",
  "glo-ops",
  "galileo",
  "beidou",
  "last-30-days",
] as const);
export type CelestrakGroup = (typeof CELESTRAK_GROUPS)[number];
export type CatalogQuery =
  | { kind: "group"; value: CelestrakGroup }
  | { kind: "catnr"; value: number }
  | { kind: "name"; value: string };

export const CELESTRAK_MIN_INTERVAL_MS = 2 * 3_600_000;
const MAX_BYTES = 1_048_576;
const MAX_OBJECTS = 400;
const WEATHER_CACHE_MS = 3_600_000;
const WEATHER_MIN_INTERVAL_MS = 60_000;
const LAUNCH_CACHE_MS = 15 * 60_000;
const LAUNCH_DIRECT_MIN_INTERVAL_MS = 10 * 60_000;
const ALLOWED_ORIGINS = new Set([
  "https://celestrak.org",
  "https://api.weather.gov",
  "https://api.open-meteo.com",
  "https://ll.thespacedevs.com",
]);
export const SPACE_RELAY_PREFIX = "/api/v1/worldview/space";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const safeError = (e: unknown) =>
  e instanceof Error ? (e.name === "AbortError" ? "Request timed out or was cancelled" : e.message.slice(0, 200)) : "Request failed";
const nowOf = (o: SpaceOptions) => (o.now ? o.now() : Date.now());
const iso = (ms: number) => new Date(ms).toISOString();
const parseTime = (v: unknown): number | null => {
  if (typeof v !== "string" || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const trustedTime = (v: unknown, nowMs: number): number | null => {
  const t = parseTime(v);
  return t !== null && t <= nowMs + 5 * 60_000 ? t : null;
};
const str = (v: unknown, max = 160) => (typeof v === "string" ? v.slice(0, max) : "");
function defaultStorage(): SpaceOptions["storage"] {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Bounded GET: https allowlist (or same-origin relay path), no redirects, size cap. */
async function boundedGet(
  url: string,
  options: SpaceOptions,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  if (options.network !== true) throw new Error("Network access is opt-in");
  if (!url.startsWith(SPACE_RELAY_PREFIX + "/")) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !ALLOWED_ORIGINS.has(u.origin) || u.username || u.password)
      throw new Error("URL is not on the HTTPS provider allowlist");
  }
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20_000, options.timeoutMs ?? 10_000)));
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
      headers,
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("Provider response exceeds 1 MiB");
    if (!response.body) return { status: response.status, text: "" };
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
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return { status: response.status, text: new TextDecoder().decode(bytes) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ CelesTrak ------------------------------ */

export type CatalogEntry = {
  kind: "orbital-elements";
  noradId: number;
  name: string;
  objectId: string;
  epoch: string;
  elementAgeDays: number;
  ageStatus: ElementAgeStatus;
  ageNote: string;
  satrec: SatRec;
};
export type CatalogResult = SpaceSourceMeta & {
  query: string;
  entries: CatalogEntry[];
  nextAllowedAt: string | null;
};

export function catalogQueryString(q: CatalogQuery): string {
  if (q.kind === "group") {
    if (!(CELESTRAK_GROUPS as readonly string[]).includes(q.value)) throw new Error("CelesTrak group is not allowlisted");
    return `GROUP=${q.value}`;
  }
  if (q.kind === "catnr") {
    if (!Number.isSafeInteger(q.value) || q.value < 1 || q.value > 999_999_999) throw new Error("Invalid NORAD catalog number");
    return `CATNR=${q.value}`;
  }
  const name = typeof q.value === "string" ? q.value.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9 ()\-./]{2,23}$/.test(name)) throw new Error("Name search must be 3-24 letters, digits, spaces or -./()");
  return `NAME=${encodeURIComponent(name)}`;
}

type CachedCatalog = { retrievedAt: number; body: string };
const memoryCatalog = new Map<string, CachedCatalog>();
const STORAGE_PREFIX = "signalwarden.celestrak.gp.v1:";

function readCatalogCache(key: string, storage: SpaceOptions["storage"]): CachedCatalog | undefined {
  const mem = memoryCatalog.get(key);
  if (mem) return mem;
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + key);
    if (!raw || raw.length > MAX_BYTES * 2) return undefined;
    const parsed = JSON.parse(raw) as CachedCatalog;
    if (!finite(parsed.retrievedAt) || typeof parsed.body !== "string") return undefined;
    memoryCatalog.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}
function writeCatalogCache(key: string, value: CachedCatalog, storage: SpaceOptions["storage"]) {
  memoryCatalog.set(key, value);
  try {
    storage?.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: memory cache still enforces the interval */
  }
}
/** Test helper: forget in-memory caches and throttles. */
export function resetSpaceFeedState() {
  memoryCatalog.clear();
  weatherCache.clear();
  weatherAttempts.clear();
  launchCache = undefined;
  launchAttemptAt = 0;
}

export function parseCatalogBody(body: string, nowMs: number, maxAgeDays?: number): CatalogEntry[] {
  const trimmed = body.trim();
  if (!trimmed.startsWith("[")) return [];
  const data = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(data)) throw new Error("Invalid CelesTrak GP response");
  const entries: CatalogEntry[] = [];
  for (const raw of data.slice(0, MAX_OBJECTS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const norad = r.NORAD_CAT_ID;
    const epochText = str(r.EPOCH, 40);
    const epochMs = parseTime(/Z$|[+-]\d\d:\d\d$/.test(epochText) ? epochText : `${epochText}Z`);
    if (!finite(norad) || !Number.isSafeInteger(norad) || epochMs === null) continue;
    if (
      !["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR"].every((k) =>
        finite(r[k]),
      )
    )
      continue;
    let satrec: SatRec;
    try {
      satrec = satellite.json2satrec({
        OBJECT_NAME: str(r.OBJECT_NAME, 80),
        OBJECT_ID: str(r.OBJECT_ID, 20),
        EPOCH: epochText,
        MEAN_MOTION: r.MEAN_MOTION as number,
        ECCENTRICITY: r.ECCENTRICITY as number,
        INCLINATION: r.INCLINATION as number,
        RA_OF_ASC_NODE: r.RA_OF_ASC_NODE as number,
        ARG_OF_PERICENTER: r.ARG_OF_PERICENTER as number,
        MEAN_ANOMALY: r.MEAN_ANOMALY as number,
        EPHEMERIS_TYPE: 0,
        CLASSIFICATION_TYPE: "U",
        NORAD_CAT_ID: norad,
        ELEMENT_SET_NO: finite(r.ELEMENT_SET_NO) ? r.ELEMENT_SET_NO : 999,
        REV_AT_EPOCH: finite(r.REV_AT_EPOCH) ? r.REV_AT_EPOCH : 0,
        BSTAR: r.BSTAR as number,
        MEAN_MOTION_DOT: finite(r.MEAN_MOTION_DOT) ? r.MEAN_MOTION_DOT : 0,
        MEAN_MOTION_DDOT: finite(r.MEAN_MOTION_DDOT) ? r.MEAN_MOTION_DDOT : 0,
      } as Parameters<typeof satellite.json2satrec>[0]);
    } catch {
      continue;
    }
    if (satrec.error) continue;
    const u = elementUncertainty(satrec, new Date(nowMs), maxAgeDays);
    entries.push({
      kind: "orbital-elements",
      noradId: norad,
      name: str(r.OBJECT_NAME, 80) || `NORAD ${norad}`,
      objectId: str(r.OBJECT_ID, 20),
      epoch: iso(epochMs),
      elementAgeDays: u.elementAgeDays,
      ageStatus: u.status,
      ageNote: u.note,
      satrec,
    });
  }
  return entries;
}

function catalogResult(
  key: string,
  cache: CachedCatalog,
  nowMs: number,
  freshness: SpaceFreshness,
  extra: Partial<SpaceSourceMeta> = {},
): CatalogResult {
  const entries = parseCatalogBody(cache.body, nowMs);
  const newestEpoch = entries.reduce<number | null>((m, e) => {
    const t = Date.parse(e.epoch);
    return m === null || t > m ? t : m;
  }, null);
  const oldest = entries.reduce((m, e) => Math.max(m, Math.abs(e.elementAgeDays)), 0);
  const ageWarning =
    entries.length && oldest > 7
      ? `Some element sets are ${oldest.toFixed(1)} days old; forecasts for those objects are low confidence or refused.`
      : undefined;
  return {
    provider: "CelesTrak",
    kind: "orbital-elements",
    sourceUrl: `${SPACE_PROVIDERS.celestrak.endpoint}?${key}&FORMAT=json`,
    retrievedAt: iso(cache.retrievedAt),
    providerTimestamp: newestEpoch === null ? null : iso(newestEpoch),
    ageSeconds: Math.max(0, Math.round((nowMs - cache.retrievedAt) / 1000)),
    freshness,
    attribution: SPACE_PROVIDERS.celestrak.attribution,
    license: SPACE_PROVIDERS.celestrak.license,
    licenseUrl: SPACE_PROVIDERS.celestrak.licenseUrl,
    note: [extra.note, ageWarning].filter(Boolean).join(" ") || undefined,
    error: extra.error,
    query: key,
    entries,
    nextAllowedAt: iso(cache.retrievedAt + CELESTRAK_MIN_INTERVAL_MS),
  };
}

/** Fetch CelesTrak GP elements, never re-downloading the same query within 2 hours. */
export async function refreshCelestrak(query: CatalogQuery, options: SpaceOptions = {}): Promise<CatalogResult> {
  const nowMs = nowOf(options);
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let key: string;
  const empty = (error: string, freshness: SpaceFreshness = "failed"): CatalogResult => ({
    provider: "CelesTrak",
    kind: "orbital-elements",
    sourceUrl: SPACE_PROVIDERS.celestrak.endpoint,
    retrievedAt: null,
    providerTimestamp: null,
    ageSeconds: null,
    freshness,
    attribution: SPACE_PROVIDERS.celestrak.attribution,
    license: SPACE_PROVIDERS.celestrak.license,
    licenseUrl: SPACE_PROVIDERS.celestrak.licenseUrl,
    error,
    query: "",
    entries: [],
    nextAllowedAt: null,
  });
  try {
    key = catalogQueryString(query);
  } catch (e) {
    return empty(safeError(e));
  }
  const cached = readCatalogCache(key, storage);
  if (cached && nowMs - cached.retrievedAt < CELESTRAK_MIN_INTERVAL_MS && cached.retrievedAt <= nowMs + 60_000)
    return catalogResult(key, cached, nowMs, "cached", {
      note: "Served from local cache: CelesTrak asks clients not to re-download the same data within 2 hours.",
    });
  if (options.network !== true)
    return cached
      ? catalogResult(key, cached, nowMs, "stale", { error: "Network access is opt-in; showing last cached elements" })
      : { ...empty("Network access is opt-in", "disabled"), query: key };
  try {
    const { status, text } = await boundedGet(`${SPACE_PROVIDERS.celestrak.endpoint}?${key}&FORMAT=json`, options, {
      Accept: "application/json",
    });
    if (status === 404 || /^No GP data found/i.test(text.trim())) {
      const value = { retrievedAt: nowMs, body: "[]" };
      writeCatalogCache(key, value, storage);
      return catalogResult(key, value, nowMs, "fresh", { note: "CelesTrak returned no GP data for this query." });
    }
    if (status === 403)
      throw new Error("CelesTrak refused the request (HTTP 403); it may be rate limiting this address. Wait at least 2 hours.");
    if (status < 200 || status > 299) throw new Error(`HTTP ${status}`);
    if (!text.trim().startsWith("[")) throw new Error(`CelesTrak returned a non-JSON message: ${text.trim().slice(0, 120)}`);
    parseCatalogBody(text, nowMs); // validate before caching
    const value = { retrievedAt: nowMs, body: text };
    writeCatalogCache(key, value, storage);
    return catalogResult(key, value, nowMs, "fresh");
  } catch (e) {
    return cached
      ? catalogResult(key, cached, nowMs, "stale", { error: `${safeError(e)}; showing last cached elements as stale` })
      : { ...empty(safeError(e)), query: key };
  }
}

/* ---------------------------- Cloud forecasts ---------------------------- */

export type CloudInterval = { startMs: number; endMs: number; percent: number };
export type CloudForecast = SpaceSourceMeta & {
  providerId: "nws-skycover" | "open-meteo";
  point: { lat: number; lon: number };
  series: CloudInterval[];
};
export type CloudAssessment = {
  kind: "cloud-forecast";
  percent: number | null;
  label: "clear-to-partly-cloudy" | "partly-cloudy-may-interrupt" | "likely-obscured" | "no-forecast";
  provider: string;
};
export const LIKELY_OBSCURED_PERCENT = 70;

const weatherCache = new Map<string, { at: number; value: CloudForecast }>();
const weatherAttempts = new Map<string, number>();

/** Parse ISO-8601 durations of the form PnDTnHnM used by NWS validTime. */
export function parseIsoDurationMs(text: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(text);
  if (!m || text === "P" || text.endsWith("T")) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
}

export function parseNwsSkyCover(body: unknown): { series: CloudInterval[]; updateTime: number | null } {
  const props = (body as { properties?: Record<string, unknown> } | null)?.properties;
  const sky = props?.skyCover as { values?: unknown } | undefined;
  if (!sky || !Array.isArray(sky.values)) throw new Error("NWS gridpoint response has no skyCover series");
  const series: CloudInterval[] = [];
  for (const v of sky.values.slice(0, 500)) {
    const row = v as { validTime?: unknown; value?: unknown };
    if (typeof row?.validTime !== "string" || !finite(row.value)) continue;
    const [start, dur] = row.validTime.split("/");
    const s = parseTime(start);
    const d = dur ? parseIsoDurationMs(dur) : null;
    if (s === null || d === null || d <= 0 || row.value < 0 || row.value > 100) continue;
    series.push({ startMs: s, endMs: s + d, percent: row.value });
  }
  return { series, updateTime: parseTime(props?.updateTime) };
}

export function parseOpenMeteo(body: unknown): CloudInterval[] {
  const hourly = (body as { hourly?: { time?: unknown; cloud_cover?: unknown } } | null)?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.cloud_cover))
    throw new Error("Open-Meteo response has no hourly cloud_cover");
  const out: CloudInterval[] = [];
  const n = Math.min(hourly.time.length, hourly.cloud_cover.length, 400);
  for (let i = 0; i < n; i += 1) {
    const t = hourly.time[i];
    const c = hourly.cloud_cover[i];
    if (!finite(t) || !finite(c) || c < 0 || c > 100) continue;
    // Open-Meteo hourly cloud_cover is an instantaneous value at the hour; use a 1 h window centred on it.
    out.push({ startMs: t * 1000 - 1_800_000, endMs: t * 1000 + 1_800_000, percent: c });
  }
  return out;
}

export function cloudAt(forecast: CloudForecast | null | undefined, timeMs: number): CloudAssessment {
  const hit = forecast?.series.find((s) => timeMs >= s.startMs && timeMs < s.endMs);
  if (!forecast || !hit) return { kind: "cloud-forecast", percent: null, label: "no-forecast", provider: forecast?.provider ?? "none" };
  return {
    kind: "cloud-forecast",
    percent: hit.percent,
    label:
      hit.percent >= LIKELY_OBSCURED_PERCENT
        ? "likely-obscured"
        : hit.percent > 30
          ? "partly-cloudy-may-interrupt"
          : "clear-to-partly-cloudy",
    provider: forecast.provider,
  };
}

function cloudMeta(
  providerId: CloudForecast["providerId"],
  point: { lat: number; lon: number },
  sourceUrl: string,
  nowMs: number,
  series: CloudInterval[],
  providerTs: number | null,
  freshness: SpaceFreshness,
  error?: string,
): CloudForecast {
  const p = providerId === "nws-skycover" ? SPACE_PROVIDERS.nwsSky : SPACE_PROVIDERS.openMeteo;
  return {
    providerId,
    provider: providerId === "nws-skycover" ? "NOAA/NWS" : "Open-Meteo",
    kind: "cloud-forecast",
    sourceUrl,
    retrievedAt: freshness === "failed" || freshness === "disabled" ? null : iso(nowMs),
    providerTimestamp: providerTs === null ? null : iso(providerTs),
    ageSeconds: providerTs === null ? null : Math.max(0, Math.round((nowMs - providerTs) / 1000)),
    freshness,
    attribution: p.attribution,
    license: p.license,
    licenseUrl: p.licenseUrl,
    note:
      providerId === "nws-skycover"
        ? "Forecast total sky cover (%), not an observation."
        : "Forecast total cloud cover (%), not an observation. Open-Meteo does not report a model issue time here.",
    error,
    point,
    series,
  };
}

/** Fetch a cloud-cover FORECAST for an observer point. */
export async function refreshCloudForecast(
  providerId: CloudForecast["providerId"],
  point: { lat: number; lon: number },
  options: SpaceOptions = {},
): Promise<CloudForecast> {
  const nowMs = nowOf(options);
  if (!point || !finite(point.lat) || !finite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180)
    return cloudMeta(providerId, { lat: 0, lon: 0 }, "", nowMs, [], null, "failed", "Invalid observer point");
  const p = { lat: Math.round(point.lat * 1e4) / 1e4, lon: Math.round(point.lon * 1e4) / 1e4 };
  const key = `${providerId}:${p.lat},${p.lon}`;
  if (providerId === "open-meteo" && options.openMeteoTermsConfirmed !== true)
    return cloudMeta(providerId, p, "", nowMs, [], null, "disabled", "Confirm non-commercial Open-Meteo use before requesting cloud data");
  const cached = weatherCache.get(key);
  if (cached && nowMs - cached.at < WEATHER_CACHE_MS) return { ...cached.value, freshness: cached.value.freshness === "fresh" ? "cached" : cached.value.freshness, ageSeconds: cached.value.providerTimestamp ? Math.max(0, Math.round((nowMs - Date.parse(cached.value.providerTimestamp)) / 1000)) : null };
  if (options.network !== true)
    return cached
      ? { ...cached.value, freshness: "stale", error: "Network access is opt-in; showing last forecast" }
      : cloudMeta(providerId, p, "", nowMs, [], null, "disabled", "Network access is opt-in");
  if (nowMs - (weatherAttempts.get(providerId) ?? -Infinity) < WEATHER_MIN_INTERVAL_MS)
    return cached
      ? { ...cached.value, freshness: "stale", error: "Refresh throttled (60 s); showing last forecast" }
      : cloudMeta(providerId, p, "", nowMs, [], null, "failed", "Refresh throttled; wait 60 seconds");
  weatherAttempts.set(providerId, nowMs);
  try {
    let value: CloudForecast;
    if (providerId === "nws-skycover") {
      const meta = await boundedGet(`https://api.weather.gov/points/${p.lat},${p.lon}`, options, {
        Accept: "application/geo+json",
      });
      if (meta.status === 404) throw new Error("NWS has no gridpoint forecast for this location (US/territories only)");
      if (meta.status !== 200) throw new Error(`NWS points HTTP ${meta.status}`);
      const grid = (JSON.parse(meta.text) as { properties?: { forecastGridData?: unknown } })?.properties?.forecastGridData;
      if (typeof grid !== "string") throw new Error("NWS points response has no forecastGridData URL");
      const gu = new URL(grid);
      if (gu.protocol !== "https:" || gu.hostname !== "api.weather.gov" || !/^\/gridpoints\/[A-Z]{3}\/\d{1,3},\d{1,3}$/.test(gu.pathname) || gu.search)
        throw new Error("NWS gridpoint URL is not allowlisted");
      const body = await boundedGet(gu.href, options, { Accept: "application/geo+json" });
      if (body.status !== 200) throw new Error(`NWS gridpoint HTTP ${body.status}`);
      const parsed = parseNwsSkyCover(JSON.parse(body.text));
      value = cloudMeta(providerId, p, gu.href, nowMs, parsed.series, parsed.updateTime, "fresh");
    } else {
      const url = `${SPACE_PROVIDERS.openMeteo.endpoint}?latitude=${p.lat}&longitude=${p.lon}&hourly=cloud_cover&forecast_days=3&timeformat=unixtime&timezone=GMT`;
      const body = await boundedGet(url, options, { Accept: "application/json" });
      if (body.status === 429) throw new Error("Open-Meteo rate limit reached (HTTP 429)");
      if (body.status !== 200) throw new Error(`Open-Meteo HTTP ${body.status}`);
      value = cloudMeta(providerId, p, url, nowMs, parseOpenMeteo(JSON.parse(body.text)), null, "unknown", "Provider model-run timestamp unavailable; cloud model freshness is unknown");
    }
    weatherCache.set(key, { at: nowMs, value });
    return value;
  } catch (e) {
    return cached
      ? { ...cached.value, freshness: "stale", error: `${safeError(e)}; showing last forecast as stale` }
      : cloudMeta(providerId, p, "", nowMs, [], null, "failed", safeError(e));
  }
}

/* ------------------------- SatNOGS (via relay) ------------------------- */

export type RadioObservation = {
  kind: "radio-observation";
  id: number;
  start: string;
  end: string;
  status: "good" | "bad" | "failed" | "unknown";
  stationId: number | null;
  stationName: string;
  transmitter: string;
  mode: string;
  frequencyHz: number | null;
  url: string;
};
export type RadioObservationResult = SpaceSourceMeta & { noradId: number; observations: RadioObservation[] };

async function relayJson(path: string, options: SpaceOptions): Promise<{ status: number; body: any }> {
  const r = await boundedGet(`${SPACE_RELAY_PREFIX}${path}`, options, {
    Accept: "application/json",
    "X-SignalWarden-Space": "enabled",
  });
  let body: any = null;
  try {
    body = r.text ? JSON.parse(r.text) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

function relayFailure(status: number, body: any): { freshness: SpaceFreshness; error: string } {
  const code = str(body?.error?.code, 60);
  const message = str(body?.error?.message, 200);
  if (status === 404 && (code.endsWith("_disabled") || !code))
    return {
      freshness: "disabled",
      error: "Space relay is disabled. Set UCAS_SPACE_RELAY_ENABLED=1 on the local API and route /api/v1/worldview/space to it.",
    };
  return { freshness: "failed", error: message || `Relay HTTP ${status}` };
}

export async function refreshSatnogsObservations(noradId: number, options: SpaceOptions = {}): Promise<RadioObservationResult> {
  const nowMs = nowOf(options);
  const base: RadioObservationResult = {
    provider: "SatNOGS Network",
    kind: "radio-observations",
    sourceUrl: `${SPACE_PROVIDERS.satnogs.endpoint}?norad_cat_id=${noradId}`,
    retrievedAt: null,
    providerTimestamp: null,
    ageSeconds: null,
    freshness: "failed",
    attribution: SPACE_PROVIDERS.satnogs.attribution,
    license: SPACE_PROVIDERS.satnogs.license,
    licenseUrl: SPACE_PROVIDERS.satnogs.licenseUrl,
    note: "Radio observations by volunteer ground stations. These are radio receptions, not optical sightings.",
    noradId,
    observations: [],
  };
  if (!Number.isSafeInteger(noradId) || noradId < 1 || noradId > 999_999_999) return { ...base, error: "Invalid NORAD catalog number" };
  if (options.network !== true) return { ...base, freshness: "disabled", error: "Network access is opt-in" };
  try {
    const { status, body } = await relayJson(`/satnogs/observations?norad=${noradId}`, options);
    if (status !== 200) return { ...base, ...relayFailure(status, body) };
    if (!body || !Array.isArray(body.observations)) throw new Error("Invalid relay response");
    const observations: RadioObservation[] = [];
    for (const o of body.observations.slice(0, 25)) {
      const s = parseTime(o?.start),
        e = parseTime(o?.end);
      if (!Number.isSafeInteger(o?.id) || o.id <= 0 || s === null || e === null || e < s || s > nowMs + 60_000 || e > nowMs + 60_000) continue;
      const st = ["good", "bad", "failed", "unknown"].includes(o.status) ? o.status : "unknown";
      observations.push({
        kind: "radio-observation",
        id: o.id,
        start: iso(s),
        end: iso(e),
        status: st,
        stationId: finite(o.stationId) ? o.stationId : null,
        stationName: str(o.stationName, 80),
        transmitter: str(o.transmitter, 120),
        mode: str(o.mode, 40),
        frequencyHz: finite(o.frequencyHz) ? o.frequencyHz : null,
        url: `https://network.satnogs.org/observations/${o.id}/`,
      });
    }
    if (body.observations.length && !observations.length) throw new Error("No usable timestamped radio observations in provider response");
    const retrieved = trustedTime(body.retrievedAt, nowMs);
    const newest = observations.reduce<number | null>((m, o) => Math.max(m ?? 0, Date.parse(o.end)), null);
    return {
      ...base,
      retrievedAt: retrieved === null ? null : iso(retrieved),
      providerTimestamp: newest === null ? null : iso(newest),
      ageSeconds: newest === null ? null : Math.max(0, Math.round((nowMs - newest) / 1000)),
      freshness: body.stale === true ? "stale" : newest === null || retrieved === null ? "unknown" : body.cached === true ? "cached" : "fresh",
      error: body.stale === true ? "Relay returned a stale fallback snapshot" : newest === null || retrieved === null ? "No usable provider timestamp; radio observation freshness is unknown" : undefined,
      observations,
    };
  } catch (e) {
    return { ...base, error: safeError(e) };
  }
}

/* --------------------------- Launch Library 2 --------------------------- */

export type LaunchEvent = {
  kind: "scheduled-launch";
  id: string;
  name: string;
  net: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  statusDescription: string;
  provider: string;
  mission: string;
  pad: string;
  location: string;
  lastUpdated: string | null;
  url: string;
};
export type LaunchResult = SpaceSourceMeta & { launches: LaunchEvent[]; keyConfigured: boolean | null; via: "direct" | "relay" };
let launchCache: { at: number; value: LaunchResult } | undefined;
let launchAttemptAt = 0;

export function parseLaunches(body: unknown): LaunchEvent[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error("Invalid Launch Library response");
  const out: LaunchEvent[] = [];
  for (const r of results.slice(0, 10)) {
    const x = r as Record<string, any>;
    const net = parseTime(x?.net);
    const id = str(x?.id, 64);
    if (!id || !/^[0-9a-f-]{8,64}$/i.test(id) || net === null) continue;
    const ws = parseTime(x.window_start),
      we = parseTime(x.window_end),
      lu = parseTime(x.last_updated);
    out.push({
      kind: "scheduled-launch",
      id,
      name: str(x.name, 160),
      net: iso(net),
      windowStart: ws === null ? null : iso(ws),
      windowEnd: we === null ? null : iso(we),
      status: str(x.status?.abbrev ?? x.status?.name, 40) || "unknown",
      statusDescription: str(x.status?.description, 200),
      provider: str(x.lsp_name ?? x.launch_service_provider?.name, 120),
      mission: str(typeof x.mission === "string" ? x.mission : x.mission?.name, 160),
      pad: str(typeof x.pad === "string" ? x.pad : x.pad?.name, 160),
      location: str(typeof x.location === "string" ? x.location : x.pad?.location?.name, 160),
      lastUpdated: lu === null ? null : iso(lu),
      url: `https://ll.thespacedevs.com/2.2.0/launch/${id}/`,
    });
  }
  if (results.length && !out.length) throw new Error("No usable launch events in provider response");
  return out;
}

export async function refreshLaunches(via: "direct" | "relay", options: SpaceOptions = {}): Promise<LaunchResult> {
  const nowMs = nowOf(options);
  const base: LaunchResult = {
    provider: "Launch Library 2",
    kind: "launch-schedule",
    sourceUrl: `${SPACE_PROVIDERS.launchLibrary.endpoint}?limit=10&mode=list`,
    retrievedAt: null,
    providerTimestamp: null,
    ageSeconds: null,
    freshness: "failed",
    attribution: SPACE_PROVIDERS.launchLibrary.attribution,
    license: SPACE_PROVIDERS.launchLibrary.license,
    licenseUrl: SPACE_PROVIDERS.launchLibrary.licenseUrl,
    note: "Scheduled launch events (NET = no earlier than). Schedules change; this is not a confirmation that a launch occurred.",
    launches: [],
    keyConfigured: null,
    via,
  };
  if (launchCache && launchCache.value.via === via && nowMs - launchCache.at < LAUNCH_CACHE_MS)
    return { ...launchCache.value, freshness: launchCache.value.freshness === "fresh" ? "cached" : launchCache.value.freshness, ageSeconds: launchCache.value.providerTimestamp ? Math.max(0, Math.round((nowMs - Date.parse(launchCache.value.providerTimestamp)) / 1000)) : null };
  if (options.network !== true)
    return launchCache
      ? { ...launchCache.value, freshness: "stale", error: "Network access is opt-in; showing last schedule" }
      : { ...base, freshness: "disabled", error: "Network access is opt-in" };
  if (via === "direct" && nowMs - launchAttemptAt < LAUNCH_DIRECT_MIN_INTERVAL_MS)
    return launchCache
      ? { ...launchCache.value, freshness: "stale", error: "Keyless Launch Library reads are limited; wait 10 minutes" }
      : { ...base, error: "Keyless Launch Library reads are limited; wait 10 minutes" };
  launchAttemptAt = nowMs;
  try {
    let launches: LaunchEvent[];
    let keyConfigured: boolean | null = null;
    let retrieved: number | null = nowMs;
    let stale = false;
    let relayCached = false;
    if (via === "relay") {
      const { status, body } = await relayJson("/launches/upcoming", options);
      if (status !== 200) return { ...base, ...relayFailure(status, body) };
      launches = parseLaunches(body);
      keyConfigured = body?.keyConfigured === true;
      retrieved = trustedTime(body?.retrievedAt, nowMs);
      stale = body?.stale === true;
      relayCached = body?.cached === true;
    } else {
      const r = await boundedGet(base.sourceUrl, options, { Accept: "application/json" });
      if (r.status === 429) throw new Error("Launch Library rate limit reached (HTTP 429); keyless tier allows ~15 requests/hour");
      if (r.status !== 200) throw new Error(`Launch Library HTTP ${r.status}`);
      launches = parseLaunches(JSON.parse(r.text));
    }
    const lastUpdated = launches.reduce<number | null>((m, l) => {
      const t = trustedTime(l.lastUpdated, nowMs);
      return t === null ? m : Math.max(m ?? 0, t);
    }, null);
    const value: LaunchResult = {
      ...base,
      retrievedAt: retrieved === null ? null : iso(retrieved),
      providerTimestamp: lastUpdated === null ? null : iso(lastUpdated),
      ageSeconds: lastUpdated === null ? null : Math.max(0, Math.round((nowMs - lastUpdated) / 1000)),
      freshness: stale ? "stale" : !launches.length || lastUpdated === null || retrieved === null ? "unknown" : relayCached ? "cached" : "fresh",
      error: stale ? "Relay returned a stale fallback schedule" : !launches.length || lastUpdated === null || retrieved === null ? "No usable provider update timestamp; launch-schedule freshness is unknown" : undefined,
      launches,
      keyConfigured,
    };
    launchCache = { at: nowMs, value };
    return value;
  } catch (e) {
    return launchCache
      ? { ...launchCache.value, freshness: "stale", error: `${safeError(e)}; showing last schedule as stale` }
      : { ...base, error: safeError(e) };
  }
}
