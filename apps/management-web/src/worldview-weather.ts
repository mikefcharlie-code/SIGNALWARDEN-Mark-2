/* WorldView weather models, air quality and aviation enrichment.
 * Read-only, manually opted-in, bounded. Keyless Open-Meteo reads may go
 * direct from the browser (CORS "*"); keyed, credentialed or identity-bearing
 * providers (OpenAQ, OpenSky, adsbdb, Open-Meteo commercial) go only through
 * the disabled-by-default same-origin relay, which holds keys server-side and
 * strips identity fields before responding. No keys ever exist in this bundle.
 */
import type { Freshness, GeoPoint, ProviderResult, WorldObservation } from "./worldview-core";
import { haversineKm, validatePoint } from "./worldview-core";

export const WEATHER_RELAY_PREFIX = "/api/v1/worldview-weather";
const OPEN_METEO_ORIGINS = ["https://api.open-meteo.com", "https://air-quality-api.open-meteo.com"];
const MAX_BYTES = 1_000_000;
const MIN_DIRECT_INTERVAL_MS = 10_000;
const FORECAST_HOURS = 48;
const MODEL_RUN_STALE_MS = 18 * 3600_000;
const AQ_MEASURED_STALE_MS = 3 * 3600_000;
const AIRCRAFT_STALE_MS = 2 * 60_000;

export const WEATHER_MODELS = Object.freeze({
  gfs_seamless: Object.freeze({ label: "NOAA GFS", meta: "ncep_gfs025", attribution: "NOAA Global Forecast System (GFS) via Open-Meteo; NOAA does not endorse this product" }),
  ecmwf_ifs025: Object.freeze({
    label: "ECMWF IFS 0.25°",
    meta: "ecmwf_ifs025",
    attribution:
      "© ECMWF. Source: www.ecmwf.int. ECMWF IFS open data, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), served and re-gridded by Open-Meteo (modified: point-sampled and unit-converted). ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use.",
  }),
  icon_seamless: Object.freeze({ label: "DWD ICON", meta: "dwd_icon", attribution: "Deutscher Wetterdienst (DWD) ICON via Open-Meteo, CC BY 4.0" }),
});
export type WeatherModel = keyof typeof WEATHER_MODELS;
export const isWeatherModel = (v: unknown): v is WeatherModel => typeof v === "string" && Object.hasOwn(WEATHER_MODELS, v);

export const WEATHER_SOURCES = Object.freeze({
  openMeteo: Object.freeze({
    providerId: "open-meteo", name: "Open-Meteo Forecast API", attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    termsUrl: "https://open-meteo.com/en/terms", licenseUrl: "https://open-meteo.com/en/licence",
    limits: "Free tier: non-commercial only, <10,000 calls/day, 5,000/hour, 600/min per IP; commercial use needs UCAS_OPEN_METEO_API_KEY on the server",
  }),
  openMeteoAq: Object.freeze({
    providerId: "open-meteo-aq", name: "Open-Meteo Air Quality API (CAMS)",
    attribution: "Air quality: CAMS / Copernicus Atmosphere Monitoring Service via Open-Meteo.com (CC BY 4.0); modelled, not measured",
    termsUrl: "https://open-meteo.com/en/terms", licenseUrl: "https://open-meteo.com/en/licence",
  }),
  openAq: Object.freeze({
    providerId: "openaq", name: "OpenAQ v3 station measurements", attribution: "OpenAQ (openaq.org); per-station licence listed with each record",
    termsUrl: "https://docs.openaq.org/about/terms", keyEnv: "UCAS_OPENAQ_API_KEY",
  }),
  openSky: Object.freeze({
    providerId: "opensky", name: "OpenSky Network state vectors", attribution: "The OpenSky Network, https://opensky-network.org",
    termsUrl: "https://opensky-network.org/about/terms-of-use", keyEnv: "UCAS_OPENSKY_CLIENT_ID / UCAS_OPENSKY_CLIENT_SECRET (optional)",
  }),
  adsbdb: Object.freeze({
    providerId: "adsbdb", name: "adsbdb aircraft type lookup", attribution: "Aircraft type from adsbdb.com", termsUrl: "https://www.adsbdb.com/",
  }),
});

export type EnrichmentStatus = "live" | "stale" | "unknown" | "failed" | "not_configured" | "disabled" | "throttled";
export interface ForecastHour {
  time: string;
  [variable: string]: string | number | null;
}
export interface EnrichmentResult extends ProviderResult {
  status: EnrichmentStatus;
  sourceUrl?: string;
  attribution: string;
  termsUrl: string;
  /** Hourly forecast/AQ series for the panel (forecast and modelled AQ only). */
  series?: ForecastHour[];
  units?: Record<string, string>;
  modelRun?: string;
  route?: "direct" | "relay";
}
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface WeatherOptions {
  network?: boolean;
  relay?: boolean;
  /** Explicit non-commercial consent, or a verified commercial relay entitlement. */
  openMeteoTermsConfirmed?: boolean;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  now?: () => number;
}
export interface RelayStatus {
  enabled: boolean;
  providers: Record<string, { status: string; tier?: string; mode?: string }>;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validLicenseDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};
/** License terms must be explicit; unknown permissions are never inferred. */
export function validOpenAqLicense(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const l = value as Record<string, unknown>;
  if (!Number.isSafeInteger(l.id) || (l.id as number) <= 0 || typeof l.name !== "string" || !l.name.trim()
    || typeof l.sourceUrl !== "string" || l.sourceUrl.length > 500 || typeof l.attribution !== "string") return false;
  try {
    const url = new URL(l.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
  } catch { return false; }
  const rights = ["commercialUseAllowed", "attributionRequired", "shareAlikeRequired", "modificationAllowed", "redistributionAllowed"];
  if (rights.some((key) => typeof l[key] !== "boolean")) return false;
  if (l.commercialUseAllowed !== true || l.redistributionAllowed !== true || l.modificationAllowed !== true || l.shareAlikeRequired !== false) return false;
  if (l.attributionRequired === true && !l.attribution.trim()) return false;
  if (!validLicenseDate(l.dateFrom)) return false;
  if (l.dateTo !== "" && l.dateTo !== null && l.dateTo !== undefined && !validLicenseDate(l.dateTo)) return false;
  return true;
}
export function openAqLicenseCovers(license: Record<string, unknown>, timestamp: string): boolean {
  const observed = Date.parse(timestamp);
  const start = license.dateFrom;
  const end = license.dateTo;
  if (!Number.isFinite(observed) || !validLicenseDate(start)) return false;
  const day = new Date(observed).toISOString().slice(0, 10);
  return day >= start && (end === "" || end === null || end === undefined || (validLicenseDate(end) && day <= end));
}
const lastDirect = new Map<string, number>();
const typeCache = new Map<string, { at: number; value: AircraftType }>();
export function resetWeatherState(): void {
  lastDirect.clear();
  typeCache.clear();
}

class RelayError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function readBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("Provider response exceeds 1 MB");
  if (!response.body) throw new Error("Provider returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Provider response exceeds 1 MB");
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
}

async function getJson(url: string, options: WeatherOptions, relay: boolean): Promise<unknown> {
  if (options.network !== true) throw new Error("Network access is opt-in");
  if (relay) {
    if (!url.startsWith(`${WEATHER_RELAY_PREFIX}/`)) throw new Error("Relay path is not allowlisted");
  } else {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !OPEN_METEO_ORIGINS.includes(parsed.origin) || parsed.username || parsed.password)
      throw new Error("URL is not on the HTTPS provider allowlist");
  }
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetcher(url, {
      method: "GET", redirect: "error", credentials: relay ? "same-origin" : "omit", referrerPolicy: "no-referrer", cache: "no-store", signal,
      headers: relay ? { Accept: "application/json", "X-SignalWarden-Weather": "enabled" } : { Accept: "application/json" },
    });
    if (!response.ok) {
      let code = "provider_error", message = `HTTP ${response.status}`;
      try {
        const body = (await readBounded(response)) as { error?: { code?: unknown; message?: unknown }; reason?: unknown };
        if (typeof body?.error?.code === "string") code = body.error.code.slice(0, 64);
        if (typeof body?.error?.message === "string") message = body.error.message.slice(0, 240);
        else if (typeof body?.reason === "string") message = `HTTP ${response.status}: ${body.reason.slice(0, 200)}`;
      } catch { /* keep generic message */ }
      throw new RelayError(response.status, code, message);
    }
    return await readBounded(response);
  } finally {
    clearTimeout(timer);
  }
}

function statusFromError(e: unknown): { status: EnrichmentStatus; error: string } {
  if (e instanceof RelayError) {
    if (e.code === "not_configured") return { status: "not_configured", error: e.message };
    if (e.code === "weather_relay_disabled" || (e.status === 404 && e.code === "not_found"))
      return { status: "disabled", error: "Relay disabled: set UCAS_WORLDVIEW_WEATHER_ENABLED=1 on the API server and route /api/v1/worldview-weather to it" };
    if (e.status === 429) return { status: "throttled", error: e.message };
    return { status: "failed", error: e.message };
  }
  return { status: "failed", error: e instanceof Error ? e.message : "Request failed" };
}

function failure(providerId: string, attribution: string, termsUrl: string, now: number, e: unknown, route?: "direct" | "relay"): EnrichmentResult {
  const { status, error } = statusFromError(e);
  return { providerId, observations: [], retrievedAt: new Date(now).toISOString(), freshness: "failed", status, error, attribution, termsUrl, route };
}

function isoUtcHour(raw: string): string | undefined {
  // Open-Meteo returns "YYYY-MM-DDTHH:MM" in the requested GMT timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}:00Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function parseSeries(data: unknown, variables: readonly string[]): { series: ForecastHour[]; units: Record<string, string>; lat?: number; lon?: number } {
  const d = data as { hourly?: Record<string, unknown>; hourly_units?: Record<string, unknown>; latitude?: unknown; longitude?: unknown };
  const hourly = d?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) throw new Error("Open-Meteo response has no hourly series");
  const series: ForecastHour[] = [];
  for (const [i, raw] of hourly.time.slice(0, FORECAST_HOURS).entries()) {
    const time = typeof raw === "string" ? isoUtcHour(raw) : undefined;
    if (!time) continue;
    const row: ForecastHour = { time };
    for (const v of variables) {
      const s = hourly[v];
      row[v] = Array.isArray(s) && finite(s[i]) ? s[i] : null;
    }
    series.push(row);
  }
  if (!series.length) throw new Error("Open-Meteo response has no valid hours");
  const units: Record<string, string> = {};
  for (const v of variables) if (typeof d.hourly_units?.[v] === "string") units[v] = String(d.hourly_units[v]).slice(0, 16);
  return { series, units, lat: finite(d.latitude) ? d.latitude : undefined, lon: finite(d.longitude) ? d.longitude : undefined };
}

function currentHour(series: ForecastHour[], now: number): ForecastHour | undefined {
  let best: ForecastHour | undefined;
  for (const row of series) if (Date.parse(row.time) <= now) best = row;
  return best && now - Date.parse(best.time) < 3600_000 ? best : undefined;
}

export const FORECAST_VARIABLES = [
  "temperature_2m", "wind_speed_10m", "wind_direction_10m", "wind_speed_80m", "wind_direction_80m",
  "wind_speed_120m", "wind_direction_120m", "wind_gusts_10m", "cloud_cover", "precipitation",
] as const;
export const AIR_QUALITY_VARIABLES = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "us_aqi"] as const;

function directThrottle(key: string, now: number): void {
  const last = lastDirect.get(key);
  if (last !== undefined && now - last < MIN_DIRECT_INTERVAL_MS)
    throw new RelayError(429, "client_throttled", `Refresh throttled; wait ${Math.ceil((MIN_DIRECT_INTERVAL_MS - (now - last)) / 1000)}s`);
  lastDirect.set(key, now);
}

function point4(point: GeoPoint) {
  return { lat: Math.round(point.lat * 1e4) / 1e4, lon: Math.round(point.lon * 1e4) / 1e4 };
}

export const forecastSource = (model: WeatherModel) => `Open-Meteo model · ${WEATHER_MODELS[model].label}`;

/** Hourly 48 h model forecast at a point, with model attribution. */
export async function refreshOpenMeteoForecast(point: GeoPoint, model: WeatherModel, options: WeatherOptions = {}): Promise<EnrichmentResult> {
  const now = (options.now ?? Date.now)();
  const src = WEATHER_SOURCES.openMeteo;
  const route = options.relay ? "relay" : "direct";
  if (!isWeatherModel(model)) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Unknown model"), route);
  const attribution = `${src.attribution}; ${WEATHER_MODELS[model].attribution}`;
  if (options.network !== true) return failure(src.providerId, attribution, src.termsUrl, now, new Error("Network access is opt-in"), route);
  if (options.openMeteoTermsConfirmed !== true) return failure(src.providerId, attribution, src.termsUrl, now, new Error("Confirm Open-Meteo non-commercial terms or a verified commercial relay before requesting data"), route);
  if (!validatePoint(point)) return failure(src.providerId, attribution, src.termsUrl, now, new Error("Invalid point"), route);
  const p = point4(point);
  try {
    let data: unknown, sourceUrl: string, modelRun: string | undefined, tier = "free_non_commercial";
    if (options.relay) {
      const body = (await getJson(`${WEATHER_RELAY_PREFIX}/open-meteo/forecast?${new URLSearchParams({ lat: String(p.lat), lon: String(p.lon), model })}`, options, true)) as Record<string, unknown>;
      if (typeof body?.sourceUrl !== "string") throw new Error("Relay response missing source URL");
      data = body.data; sourceUrl = body.sourceUrl;
      modelRun = typeof body.modelRun === "string" && Number.isFinite(Date.parse(body.modelRun)) ? new Date(body.modelRun).toISOString() : undefined;
      if (typeof body.tier === "string") tier = body.tier;
    } else {
      directThrottle(`forecast:${model}`, now);
      const params = new URLSearchParams({
        latitude: String(p.lat), longitude: String(p.lon), hourly: FORECAST_VARIABLES.join(","), models: model,
        forecast_hours: String(FORECAST_HOURS), wind_speed_unit: "ms", timezone: "GMT",
      });
      sourceUrl = `https://api.open-meteo.com/v1/forecast?${params}`;
      data = await getJson(sourceUrl, options, false);
      try {
        const meta = (await getJson(`https://api.open-meteo.com/data/${WEATHER_MODELS[model].meta}/static/meta.json`, options, false)) as { last_run_initialisation_time?: unknown };
        if (finite(meta?.last_run_initialisation_time)) modelRun = new Date(meta.last_run_initialisation_time * 1000).toISOString();
      } catch { /* model-run time unknown; disclosed below */ }
    }
    const parsed = parseSeries(data, FORECAST_VARIABLES);
    const hour = currentHour(parsed.series, now);
    const runAge = modelRun ? now - Date.parse(modelRun) : NaN;
    const freshness: Freshness = !hour ? "stale" : !modelRun ? "unknown" : runAge > MODEL_RUN_STALE_MS || runAge < -300_000 ? "stale" : "fresh";
    const retrievedAt = new Date(now).toISOString();
    const observations: WorldObservation[] = hour
      ? [{
          id: `open-meteo-${model}-${p.lat.toFixed(3)}-${p.lon.toFixed(3)}`,
          layer: "weather",
          point: { lat: parsed.lat ?? p.lat, lon: parsed.lon ?? p.lon },
          observedAt: modelRun ?? retrievedAt,
          source: forecastSource(model),
          label: `${WEATHER_MODELS[model].label} model forecast · valid ${hour.time.slice(11, 16)}Z`,
          freshness,
          properties: {
            ...Object.fromEntries(FORECAST_VARIABLES.map((v) => [v, hour[v] ?? null])),
            validTime: hour.time, model, tier, dataKind: "model forecast (not an observation)",
            provider: src.name, sourceUrl, retrievedAt, providerTimestamp: modelRun ?? null,
            providerTimestampKind: modelRun ? "model run initialisation" : "unknown",
            ageSeconds: modelRun ? Math.round(runAge / 1000) : null,
            attribution, termsUrl: src.termsUrl, licenseUrl: src.licenseUrl,
          },
        }]
      : [];
    return {
      providerId: src.providerId, observations, retrievedAt, freshness, status: freshness === "fresh" ? "live" : freshness === "unknown" ? "unknown" : "stale",
      sourceUrl, attribution, termsUrl: src.termsUrl, series: parsed.series, units: parsed.units, modelRun, route,
      ...(hour ? {} : { error: "Forecast does not cover the current hour" }),
    };
  } catch (e) {
    return failure(src.providerId, attribution, src.termsUrl, now, e, route);
  }
}

/** Modelled (CAMS) air quality at a point: PM2.5/PM10/O3/NO2/US AQI. */
export async function refreshOpenMeteoAirQuality(point: GeoPoint, options: WeatherOptions = {}): Promise<EnrichmentResult> {
  const now = (options.now ?? Date.now)();
  const src = WEATHER_SOURCES.openMeteoAq;
  const route = options.relay ? "relay" : "direct";
  if (options.network !== true) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Network access is opt-in"), route);
  if (options.openMeteoTermsConfirmed !== true) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Confirm Open-Meteo non-commercial terms or a verified commercial relay before requesting data"), route);
  if (!validatePoint(point)) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Invalid point"), route);
  const p = point4(point);
  try {
    let data: unknown, sourceUrl: string, modelRun: string | undefined;
    if (options.relay) {
      const body = (await getJson(`${WEATHER_RELAY_PREFIX}/open-meteo/air-quality?${new URLSearchParams({ lat: String(p.lat), lon: String(p.lon) })}`, options, true)) as Record<string, unknown>;
      if (typeof body?.sourceUrl !== "string") throw new Error("Relay response missing source URL");
      data = body.data; sourceUrl = body.sourceUrl;
      modelRun = typeof body.modelRun === "string" && Number.isFinite(Date.parse(body.modelRun)) ? new Date(body.modelRun).toISOString() : undefined;
    } else {
      directThrottle("air-quality", now);
      const params = new URLSearchParams({ latitude: String(p.lat), longitude: String(p.lon), hourly: AIR_QUALITY_VARIABLES.join(","), forecast_hours: String(FORECAST_HOURS), timezone: "GMT" });
      sourceUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
      data = await getJson(sourceUrl, options, false);
    }
    const parsed = parseSeries(data, AIR_QUALITY_VARIABLES);
    const hour = currentHour(parsed.series, now);
    const retrievedAt = new Date(now).toISOString();
    const runAge = modelRun ? now - Date.parse(modelRun) : NaN;
    const freshness: Freshness = !hour ? "stale" : !modelRun ? "unknown" : runAge > MODEL_RUN_STALE_MS || runAge < -300_000 ? "stale" : "fresh";
    const observations: WorldObservation[] = hour
      ? [{
          id: `open-meteo-aq-${p.lat.toFixed(3)}-${p.lon.toFixed(3)}`,
          layer: "weather",
          point: { lat: parsed.lat ?? p.lat, lon: parsed.lon ?? p.lon },
          observedAt: hour.time,
          source: "Open-Meteo CAMS air quality (modelled)",
          label: `Air quality (MODELLED) · US AQI ${hour.us_aqi ?? "n/a"} · valid ${hour.time.slice(11, 16)}Z`,
          freshness,
          properties: {
            ...Object.fromEntries(AIR_QUALITY_VARIABLES.map((v) => [v, hour[v] ?? null])),
            dataKind: "modelled", validTime: hour.time, provider: src.name, sourceUrl, retrievedAt, providerTimestamp: modelRun ?? null,
            providerTimestampKind: modelRun ? "model run initialisation" : "unknown", ageSeconds: modelRun ? Math.round(runAge / 1000) : null,
            attribution: src.attribution, termsUrl: src.termsUrl, licenseUrl: src.licenseUrl,
          },
        }]
      : [];
    return { providerId: src.providerId, observations, retrievedAt, freshness, status: freshness === "fresh" ? "live" : freshness === "unknown" ? "unknown" : "stale", sourceUrl, attribution: src.attribution, termsUrl: src.termsUrl, series: parsed.series, units: parsed.units, modelRun, route, ...(!hour ? { error: "Air-quality series does not cover the current hour" } : !modelRun ? { error: "Provider model-run timestamp unavailable; freshness is unknown" } : {}) };
  } catch (e) {
    return failure(src.providerId, src.attribution, src.termsUrl, now, e, route);
  }
}

/** Measured station values from OpenAQ v3 (relay only; key is server-side). */
export async function refreshOpenAq(point: GeoPoint, options: WeatherOptions = {}): Promise<EnrichmentResult> {
  const now = (options.now ?? Date.now)();
  const src = WEATHER_SOURCES.openAq;
  if (options.network !== true) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Network access is opt-in"), "relay");
  if (!validatePoint(point)) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Invalid point"), "relay");
  const p = point4(point);
  try {
    const body = (await getJson(`${WEATHER_RELAY_PREFIX}/openaq/latest?${new URLSearchParams({ lat: String(p.lat), lon: String(p.lon) })}`, options, true)) as Record<string, unknown>;
    if (!Array.isArray(body?.stations) || typeof body.sourceUrl !== "string") throw new Error("Invalid OpenAQ relay response");
    const sourceUrl = new URL(body.sourceUrl);
    const retrievedMs = typeof body.retrievedAt === "string" ? Date.parse(body.retrievedAt) : NaN;
    if (sourceUrl.origin !== "https://api.openaq.org" || !Number.isFinite(retrievedMs) || retrievedMs > now + 60_000)
      throw new Error("OpenAQ source or retrieval timestamp is invalid");
    const retrievedAt = new Date(retrievedMs).toISOString();
    const observations: WorldObservation[] = [];
    for (const raw of body.stations.slice(0, 5)) {
      const s = raw as Record<string, unknown>;
      if (!finite(s?.lat) || !finite(s?.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180
        || !Number.isSafeInteger(s?.locationId) || !Array.isArray(s.measurements)) continue;
      if (haversineKm(p, { lat: s.lat, lon: s.lon }) > 25.5) continue;
      const licenses = Array.isArray(s.licenses) ? (s.licenses as unknown[]).filter(validOpenAqLicense) : [];
      const byLicense = new Map(licenses.map((l) => [l.id as number, l]));
      const ms = (s.measurements as Array<Record<string, unknown>>).filter((m) => typeof m?.parameter === "string"
        && ["pm25", "pm10", "o3", "no2", "so2", "co"].includes(m.parameter) && finite(m.value)
        && typeof m.datetimeUtc === "string" && Number.isFinite(Date.parse(m.datetimeUtc)) && Date.parse(m.datetimeUtc) <= now + 60_000
        && Number.isSafeInteger(m.licenseId) && byLicense.has(m.licenseId as number)
        && openAqLicenseCovers(byLicense.get(m.licenseId as number)!, m.datetimeUtc));
      if (!ms.length) continue;
      const newest = Math.max(...ms.map((m) => Date.parse(String(m.datetimeUtc))));
      const usedIds = new Set(ms.map((m) => m.licenseId as number));
      const usedLicenses = licenses.filter((l) => usedIds.has(l.id as number));
      const licenseText = usedLicenses.map((l) => [l.name, l.attribution].filter((x) => typeof x === "string" && x).join(" — ")).join("; ");
      const licenseUrls = usedLicenses.map((l) => `${String(l.name)}: ${String(l.sourceUrl)}`).join("; ");
      const freshness: Freshness = now - newest <= AQ_MEASURED_STALE_MS && now - retrievedMs <= 10 * 60_000 ? "fresh" : "stale";
      const props: Record<string, string | number | boolean | null> = {
        dataKind: "measured", stationType: s.isMonitor === true ? "reference monitor" : "low-cost / community sensor",
        dataProvider: typeof s.dataProvider === "string" ? s.dataProvider : null,
        provider: src.name, sourceUrl: typeof s.sourceUrl === "string" ? s.sourceUrl : body.sourceUrl, retrievedAt,
        providerTimestamp: new Date(newest).toISOString(), providerTimestampKind: "latest measurement (UTC)",
        ageSeconds: Math.round((now - newest) / 1000), attribution: `${src.attribution}${licenseText ? `; ${licenseText}` : ""}`,
        licenseUrls, termsUrl: src.termsUrl,
      };
      for (const m of ms.slice(0, 8)) {
        props[String(m.parameter)] = m.value as number;
        props[`${m.parameter}_units`] = typeof m.units === "string" ? m.units : "";
      }
      observations.push({
        id: `openaq-${s.locationId}`, layer: "weather", point: { lat: s.lat, lon: s.lon }, observedAt: new Date(newest).toISOString(),
        source: "OpenAQ (measured)", label: `Air quality (MEASURED) · ${typeof s.label === "string" ? s.label.slice(0, 60) : "station"}`, freshness, properties: props,
      });
    }
    const freshness: Freshness = observations.length && observations.every((o) => o.freshness === "fresh") ? "fresh" : "stale";
    return { providerId: src.providerId, observations, retrievedAt, freshness, status: observations.length ? (freshness === "fresh" ? "live" : "stale") : "stale", sourceUrl: body.sourceUrl, attribution: src.attribution, termsUrl: src.termsUrl, route: "relay", ...(observations.length ? {} : { error: "No OpenAQ station with recent PM/O3/NO2 values within 25 km" }) };
  } catch (e) {
    return failure(src.providerId, src.attribution, src.termsUrl, now, e, "relay");
  }
}

export interface Bbox { lamin: number; lomin: number; lamax: number; lomax: number }
/** Square-ish box around a point, clamped to ≤5° spans (one OpenSky credit). */
export function bboxAround(point: GeoPoint, halfSpanDeg: number): Bbox {
  const h = Math.min(2.5, Math.max(0.1, halfSpanDeg));
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { lamin: r(Math.max(-90, point.lat - h)), lamax: r(Math.min(90, point.lat + h)), lomin: r(Math.max(-180, point.lon - h)), lomax: r(Math.min(180, point.lon + h)) };
}

/** OpenSky aircraft in a bbox via relay. Callsign/squawk/country stripped server-side and re-checked here. */
export async function refreshOpenSky(bbox: Bbox, options: WeatherOptions = {}): Promise<EnrichmentResult> {
  const now = (options.now ?? Date.now)();
  const src = WEATHER_SOURCES.openSky;
  if (options.network !== true) return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Network access is opt-in"), "relay");
  const values = [bbox?.lamin, bbox?.lomin, bbox?.lamax, bbox?.lomax];
  if (!values.every(finite) || bbox.lamin >= bbox.lamax || bbox.lomin >= bbox.lomax || bbox.lamax - bbox.lamin > 5 || bbox.lomax - bbox.lomin > 5)
    return failure(src.providerId, src.attribution, src.termsUrl, now, new Error("Bounding box must be valid with spans ≤5°"), "relay");
  try {
    const qs = new URLSearchParams({ lamin: String(bbox.lamin), lomin: String(bbox.lomin), lamax: String(bbox.lamax), lomax: String(bbox.lomax) });
    const body = (await getJson(`${WEATHER_RELAY_PREFIX}/opensky/states?${qs}`, options, true)) as Record<string, unknown>;
    if (!Array.isArray(body?.states) || typeof body.sourceUrl !== "string" || typeof body.providerTime !== "string") throw new Error("Invalid OpenSky relay response");
    const providerTime = Date.parse(body.providerTime);
    if (!Number.isFinite(providerTime) || providerTime > now + 30_000) throw new Error("OpenSky timestamp missing or in the future");
    const retrievedAt = new Date(now).toISOString();
    const observations: WorldObservation[] = [];
    for (const raw of body.states.slice(0, 500)) {
      const s = raw as Record<string, unknown>;
      const hex = typeof s?.icao24 === "string" && /^[0-9a-f]{6}$/.test(s.icao24) ? s.icao24 : undefined;
      if (!hex || !finite(s.lat) || !finite(s.lon) || !validatePoint({ lat: s.lat, lon: s.lon }) || !finite(s.timePosition)) continue;
      const posMs = s.timePosition * 1000;
      if (posMs > now + 5000) continue;
      const alt = finite(s.baroAltitudeM) ? s.baroAltitudeM : undefined;
      observations.push({
        id: `opensky-${hex}`, layer: "aircraft",
        point: { lat: s.lat, lon: s.lon, ...(alt === undefined ? {} : { altM: alt }) },
        observedAt: new Date(posMs).toISOString(), source: "OpenSky Network", label: "Reported aircraft (OpenSky)",
        freshness: now - posMs <= AIRCRAFT_STALE_MS ? "fresh" : "stale",
        properties: {
          opaqueContactHex: hex, onGround: s.onGround === true,
          velocityMs: finite(s.velocityMs) ? s.velocityMs : null, trueTrackDeg: finite(s.trueTrackDeg) ? s.trueTrackDeg : null,
          verticalRateMs: finite(s.verticalRateMs) ? s.verticalRateMs : null,
          provider: src.name, sourceUrl: body.sourceUrl, retrievedAt, providerTimestamp: new Date(posMs).toISOString(),
          providerTimestampKind: "last position report", ageSeconds: Math.round((now - posMs) / 1000),
          attribution: src.attribution, termsUrl: src.termsUrl, accessMode: typeof body.mode === "string" ? body.mode : "unknown",
          disclosure: "Crowdsourced ADS-B position; not identity or ownership data",
        },
      });
    }
    const freshness: Freshness = observations.length === 0 || observations.every((o) => o.freshness === "fresh") ? "fresh" : "stale";
    return { providerId: src.providerId, observations, retrievedAt, freshness, status: "live", sourceUrl: body.sourceUrl, attribution: src.attribution, termsUrl: src.termsUrl, route: "relay" };
  } catch (e) {
    return failure(src.providerId, src.attribution, src.termsUrl, now, e, "relay");
  }
}

export interface AircraftType {
  icao24: string;
  found: boolean;
  type?: string;
  icaoType?: string;
  manufacturer?: string;
  retrievedAt: string;
  sourceUrl: string;
  attribution: string;
}
/** Single selected aircraft → TYPE only (no registration/owner). Cached 24 h client-side too. */
export async function lookupAircraftType(icao24: string, options: WeatherOptions = {}): Promise<AircraftType> {
  const now = (options.now ?? Date.now)();
  if (options.network !== true) throw new Error("Network access is opt-in");
  if (typeof icao24 !== "string" || !/^[0-9a-f]{6}$/.test(icao24)) throw new Error("Select an aircraft with a 6-digit transponder hex");
  const hit = typeCache.get(icao24);
  if (hit && now - hit.at < 24 * 3600_000) return hit.value;
  try {
    const body = (await getJson(`${WEATHER_RELAY_PREFIX}/adsbdb/aircraft?${new URLSearchParams({ icao24 })}`, options, true)) as Record<string, unknown>;
    if (body?.icao24 !== icao24 || typeof body.found !== "boolean" || typeof body.sourceUrl !== "string") throw new Error("Invalid adsbdb relay response");
    const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 80) : undefined);
    // Only these fields are ever copied, even if a relay misbehaves.
    const value: AircraftType = {
      icao24, found: body.found, type: str(body.type), icaoType: str(body.icaoType), manufacturer: str(body.manufacturer),
      retrievedAt: typeof body.retrievedAt === "string" ? body.retrievedAt : new Date(now).toISOString(), sourceUrl: body.sourceUrl,
      attribution: WEATHER_SOURCES.adsbdb.attribution,
    };
    if (typeCache.size >= 256) typeCache.delete(typeCache.keys().next().value as string);
    typeCache.set(icao24, { at: now, value });
    return value;
  } catch (e) {
    throw new Error(statusFromError(e).error);
  }
}

export async function fetchWeatherRelayStatus(options: WeatherOptions = {}): Promise<RelayStatus | { enabled: false; error: string }> {
  try {
    const body = (await getJson(`${WEATHER_RELAY_PREFIX}/status`, options, true)) as RelayStatus;
    if (typeof body?.enabled !== "boolean" || !body.providers || typeof body.providers !== "object") throw new Error("Invalid relay status");
    return body;
  } catch (e) {
    return { enabled: false, error: statusFromError(e).error };
  }
}

/** Merge provider observations into a record list, replacing only that provider's prior records. */
export function mergeProviderObservations(records: WorldObservation[], result: EnrichmentResult, sourcePrefix: string): WorldObservation[] {
  if (result.observations.length || (!result.error && result.status === "live"))
    return [...records.filter((o) => !o.source.startsWith(sourcePrefix)), ...result.observations];
  // Failed/throttled: keep last snapshot but mark it stale so no live claim remains.
  return records.map((o) => (o.source.startsWith(sourcePrefix) ? { ...o, freshness: "stale" as const, stale: true } : o));
}
