/* WorldView air-quality map layers.
 * 1. Modelled heatmap: Open-Meteo Air Quality (CAMS) sampled on a bounded grid
 *    over the viewport (≤100 points, one request). MODELLED, not measured.
 * 2. Measured stations: OpenAQ v3 locations in a ≤4° box via the weather relay
 *    (key server-side only; not_configured without UCAS_OPENAQ_API_KEY).
 * 3. Satellite layers: NASA GIBS daily aerosol / NO2 / dust tiles, draped on
 *    the globe through the existing bounded GIBS tile loader.
 * All manual opt-in; nothing is requested until the user presses a button.
 */
import type { Freshness, WorldObservation } from "./worldview-core";
import type { GlobeBounds } from "./worldview-globe-viewport";
import { GIBS_ATTRIBUTION, GIBS_ORIGIN, utcDate, type TileCoord, type TileFreshness, type TileSource } from "./worldview-basemap";
import { WEATHER_RELAY_PREFIX, WEATHER_SOURCES, openAqLicenseCovers, validOpenAqLicense } from "./worldview-weather";
import {
  GRID_HOURS, fetchGrid, fetchGridJson, gridStatusFromError,
  type GridOptions, type GridResult, type GridShape, type GridSpan, type GridField, type GridStatus,
} from "./worldview-windfield";

// ---------------------------------------------------------------- CAMS grid

export const AIR_GRID_VARIABLES = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "us_aqi", "dust", "aerosol_optical_depth"] as const;
export type AirVariable = (typeof AIR_GRID_VARIABLES)[number];
type Stop = readonly [number, readonly [number, number, number]];

const AQI_COLORS = {
  good: [0, 228, 0], moderate: [255, 255, 0], usg: [255, 126, 0], unhealthy: [255, 0, 0], very: [143, 63, 151], hazardous: [126, 0, 35],
} as const;
const epa = (b: readonly [number, number, number, number, number]): Stop[] => [
  [0, AQI_COLORS.good], [b[0], AQI_COLORS.good], [b[1], AQI_COLORS.moderate], [b[2], AQI_COLORS.usg],
  [b[3], AQI_COLORS.unhealthy], [b[4], AQI_COLORS.very], [b[4] * 1.5, AQI_COLORS.hazardous],
];
const ramp = (values: readonly number[]): Stop[] => {
  const colors: ReadonlyArray<readonly [number, number, number]> = [[40, 70, 120], [50, 150, 190], [90, 200, 140], [235, 220, 80], [240, 140, 50], [200, 50, 60], [120, 20, 90]];
  return values.map((v, i) => [v, colors[Math.min(colors.length - 1, i)]] as const);
};

export const AIR_VARIABLES: Readonly<Record<AirVariable, { label: string; units: string; stops: Stop[]; scaleNote: string }>> = Object.freeze({
  us_aqi: { label: "US AQI (CAMS-derived)", units: "US AQI", stops: [[0, AQI_COLORS.good], [50, AQI_COLORS.good], [100, AQI_COLORS.moderate], [150, AQI_COLORS.usg], [200, AQI_COLORS.unhealthy], [300, AQI_COLORS.very], [400, AQI_COLORS.hazardous]], scaleNote: "US EPA AQI category colours, computed by Open-Meteo from modelled concentrations" },
  pm2_5: { label: "PM2.5", units: "µg/m³", stops: epa([9, 35.4, 55.4, 125.4, 225.4]), scaleNote: "Colours follow US EPA 24-h PM2.5 AQI breakpoints (2024); applied to hourly model values for orientation only" },
  pm10: { label: "PM10", units: "µg/m³", stops: epa([54, 154, 254, 354, 424]), scaleNote: "Colours follow US EPA 24-h PM10 AQI breakpoints; hourly model values, orientation only" },
  ozone: { label: "Ozone (O₃)", units: "µg/m³", stops: ramp([0, 40, 80, 120, 160, 240, 360]), scaleNote: "Illustrative scale, not an AQI category" },
  nitrogen_dioxide: { label: "Nitrogen dioxide (NO₂)", units: "µg/m³", stops: ramp([0, 5, 15, 30, 60, 120, 240]), scaleNote: "Illustrative scale, not an AQI category" },
  dust: { label: "Dust (surface)", units: "µg/m³", stops: ramp([0, 10, 30, 75, 150, 400, 1000]), scaleNote: "Illustrative scale" },
  aerosol_optical_depth: { label: "Aerosol optical depth (550 nm)", units: "—", stops: ramp([0, 0.05, 0.15, 0.3, 0.6, 1.2, 2.5]), scaleNote: "Illustrative scale; column aerosol, not surface concentration" },
});
export const isAirVariable = (v: unknown): v is AirVariable => typeof v === "string" && Object.hasOwn(AIR_VARIABLES, v);

export function scaleColor(stops: ReadonlyArray<Stop>, value: number): readonly [number, number, number] {
  if (!Number.isFinite(value) || value <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
      const t = v1 === v0 ? 1 : (value - v0) / (v1 - v0);
      return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t)) as unknown as readonly [number, number, number];
    }
  }
  return stops[stops.length - 1][1];
}

/** CAMS modelled air quality on the viewport grid (24 h). */
export async function refreshAirGrid(span: GridSpan, shape: GridShape, options: GridOptions = {}): Promise<GridResult> {
  const src = WEATHER_SOURCES.openMeteoAq;
  return fetchGrid({
    kind: "air", variables: AIR_GRID_VARIABLES, provider: src.name, providerId: "open-meteo-aq",
    dataKind: "modelled air quality (CAMS; not measured)", attribution: src.attribution, termsUrl: src.termsUrl, licenseUrl: src.licenseUrl,
    cacheKey: "air:cams",
    directUrl: (lats, lons) => `https://air-quality-api.open-meteo.com/v1/air-quality?${new URLSearchParams({
      latitude: lats, longitude: lons, hourly: AIR_GRID_VARIABLES.join(","), forecast_hours: String(GRID_HOURS), timezone: "GMT",
    })}`,
    relayPath: (bbox, grid) => `${WEATHER_RELAY_PREFIX}/open-meteo/air-grid?${new URLSearchParams({ bbox, grid })}`,
  }, span, shape, options);
}

/** Hour index in `field` whose valid time matches `iso` (wind and air share the time slider). */
export function hourIndexFor(field: GridField | undefined, iso: string | undefined): number {
  if (!field || !iso) return 0;
  const i = field.times.indexOf(iso);
  return i >= 0 ? i : 0;
}

// ---------------------------------------------------------------- OpenAQ measured stations

export const OPENAQ_BBOX_MAX_SPAN = 4;
const OPENAQ_STALE_MS = 3 * 3600_000;
export const OPENAQ_MAP_SOURCE = "Measured AQ · OpenAQ map";

/** ≤4°×4° box centred in the viewport (OpenAQ bbox cap), clipped to it; null across the antimeridian. */
export function openAqBox(span: GridSpan | null): GlobeBounds | null {
  if (!span) return null;
  const cLat = (span.south + span.north) / 2;
  const cLon = (span.west + span.east) / 2;
  const h = OPENAQ_BBOX_MAX_SPAN / 2;
  const west = Math.max(span.west, cLon - h), east = Math.min(span.east, cLon + h);
  const south = Math.max(span.south, cLat - h, -90), north = Math.min(span.north, cLat + h, 90);
  const norm = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
  let w = norm(west), e = norm(east);
  if (e <= w) { if (east - west >= 359.99) { w = -180; e = 180; } else return null; }
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { west: r(w), south: r(south), east: r(e), north: r(north) };
}

export interface StationResult {
  status: GridStatus;
  observations: WorldObservation[];
  retrievedAt: string;
  sourceUrl?: string;
  attribution: string;
  termsUrl: string;
  truncated?: boolean;
  error?: string;
}

/** Measured OpenAQ stations in a ≤4° box (relay only; key server-side). */
export async function refreshOpenAqStations(box: GlobeBounds | null, options: GridOptions = {}): Promise<StationResult> {
  const now = (options.now ?? Date.now)();
  const src = WEATHER_SOURCES.openAq;
  const base = { observations: [] as WorldObservation[], retrievedAt: new Date(now).toISOString(), attribution: src.attribution, termsUrl: src.termsUrl };
  if (options.network !== true) return { ...base, status: "failed", error: "Network access is opt-in" };
  if (!box || box.west >= box.east || box.south >= box.north || box.east - box.west > OPENAQ_BBOX_MAX_SPAN + 1e-6 || box.north - box.south > OPENAQ_BBOX_MAX_SPAN + 1e-6)
    return { ...base, status: "failed", error: "Station box must be ≤4° and not cross the antimeridian" };
  try {
    const bbox = [box.west, box.south, box.east, box.north].join(",");
    const body = (await fetchGridJson(`${WEATHER_RELAY_PREFIX}/openaq/bbox?${new URLSearchParams({ bbox })}`, options, true)) as Record<string, unknown>;
    if (!Array.isArray(body?.stations) || typeof body.sourceUrl !== "string") throw new Error("Invalid OpenAQ relay response");
    const sourceUrl = new URL(body.sourceUrl);
    const retrievedMs = typeof body.retrievedAt === "string" ? Date.parse(body.retrievedAt) : NaN;
    if (sourceUrl.origin !== "https://api.openaq.org" || !Number.isFinite(retrievedMs) || retrievedMs > now + 60_000)
      throw new Error("OpenAQ source or retrieval timestamp is invalid");
    const retrievedAt = new Date(retrievedMs).toISOString();
    const observations: WorldObservation[] = [];
    for (const raw of body.stations.slice(0, 8)) {
      const s = raw as Record<string, unknown>;
      if (typeof s?.lat !== "number" || typeof s.lon !== "number" || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180
        || s.lat < box.south || s.lat > box.north || s.lon < box.west || s.lon > box.east) continue;
      if (typeof s.locationId !== "number" || !Number.isSafeInteger(s.locationId) || !Array.isArray(s.measurements)) continue;
      const licenses = Array.isArray(s.licenses) ? (s.licenses as unknown[]).filter(validOpenAqLicense) : [];
      const byLicense = new Map(licenses.map((l) => [l.id as number, l]));
      const ms = (s.measurements as Array<Record<string, unknown>>).filter((m) => typeof m?.parameter === "string"
        && ["pm25", "pm10", "o3", "no2", "so2", "co"].includes(m.parameter) && typeof m.value === "number" && Number.isFinite(m.value)
        && typeof m.datetimeUtc === "string" && Number.isFinite(Date.parse(m.datetimeUtc)) && Date.parse(m.datetimeUtc) <= now + 60_000
        && Number.isSafeInteger(m.licenseId) && byLicense.has(m.licenseId as number)
        && openAqLicenseCovers(byLicense.get(m.licenseId as number)!, m.datetimeUtc));
      if (!ms.length) continue;
      const newest = Math.max(...ms.map((m) => Date.parse(String(m.datetimeUtc))));
      const usedIds = new Set(ms.map((m) => m.licenseId as number));
      const usedLicenses = licenses.filter((l) => usedIds.has(l.id as number));
      const licenseText = usedLicenses.map((l) => [l.name, l.attribution].filter((x) => typeof x === "string" && x).join(" — ")).join("; ");
      const licenseUrls = usedLicenses.map((l) => `${String(l.name)}: ${String(l.sourceUrl)}`).join("; ");
      const freshness: Freshness = now - newest <= OPENAQ_STALE_MS && now - retrievedMs <= 10 * 60_000 ? "fresh" : "stale";
      const props: Record<string, string | number | boolean | null> = {
        dataKind: "measured", stationType: s.isMonitor === true ? "reference monitor" : "low-cost / community sensor",
        dataProvider: typeof s.dataProvider === "string" ? s.dataProvider.slice(0, 80) : null,
        provider: src.name, sourceUrl: typeof s.sourceUrl === "string" && s.sourceUrl.startsWith("https://explore.openaq.org/") ? s.sourceUrl : body.sourceUrl,
        retrievedAt, providerTimestamp: new Date(newest).toISOString(), providerTimestampKind: "latest measurement (UTC)",
        ageSeconds: Math.round((now - newest) / 1000), attribution: `${src.attribution}${licenseText ? `; ${licenseText}` : ""}`,
        licenseUrls, termsUrl: src.termsUrl,
      };
      for (const m of ms.slice(0, 8)) {
        const key = String(m.parameter).replace(/[^a-z0-9_]/gi, "").slice(0, 16);
        props[key] = m.value as number;
        props[`${key}_units`] = typeof m.units === "string" ? m.units.slice(0, 16) : "";
      }
      observations.push({
        id: `openaq-map-${s.locationId}`, layer: "weather", point: { lat: s.lat, lon: s.lon }, observedAt: new Date(newest).toISOString(),
        source: OPENAQ_MAP_SOURCE, label: `Air quality (MEASURED) · ${typeof s.label === "string" ? s.label.slice(0, 60) : "station"}`, freshness, properties: props,
      });
    }
    const allFresh = observations.length > 0 && observations.every((o) => o.freshness === "fresh");
    return {
      ...base, retrievedAt, observations, status: observations.length ? (allFresh ? "live" : "stale") : "stale", sourceUrl: body.sourceUrl,
      truncated: body.truncated === true, ...(observations.length ? {} : { error: "No OpenAQ station with recent values in this box" }),
    };
  } catch (e) {
    return { ...base, ...gridStatusFromError(e) };
  }
}

// ---------------------------------------------------------------- GIBS satellite air layers

export type AirSatLayerId = "modis-aod" | "viirs-noaa20-aod" | "viirs-snpp-aod-dt" | "tropomi-no2" | "omi-no2" | "omps-aerosol-index" | "airs-dust";
export interface AirSatLayer {
  id: AirSatLayerId;
  label: string;
  gibsLayer: string;
  matrixSet: "GoogleMapsCompatible_Level6";
  maxZoom: 6;
  minDate: string;
  /** Typical latency; the default date is today minus this many days (UTC). */
  lagDays: number;
  legendUrl: string;
  kind: "aerosol" | "no2" | "smoke-dust";
  note: string;
}
const NASA_TERMS = "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance";
export const AIR_SAT_LAYERS: Readonly<Record<AirSatLayerId, AirSatLayer>> = Object.freeze({
  "modis-aod": { id: "modis-aod", label: "Aerosol optical depth · MODIS Terra+Aqua (value-added, daily)", gibsLayer: "MODIS_Combined_Value_Added_AOD", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2017-04-19", lagDays: 1, legendUrl: `${GIBS_ORIGIN}/legends/MODIS_Combined_Value_Added_AOD_H.svg`, kind: "aerosol", note: "Daytime swaths; cloud and bright-surface gaps are normal." },
  "viirs-noaa20-aod": { id: "viirs-noaa20-aod", label: "Aerosol optical depth · VIIRS NOAA-20 Deep Blue (daily)", gibsLayer: "VIIRS_NOAA20_AOD_Deep_Blue_Land_Ocean", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2018-01-05", lagDays: 1, legendUrl: `${GIBS_ORIGIN}/legends/MODIS_VIIRS_AOD_H.svg`, kind: "aerosol", note: "Land + ocean retrieval; swath gaps between orbits." },
  "viirs-snpp-aod-dt": { id: "viirs-snpp-aod-dt", label: "Aerosol optical depth · VIIRS Suomi NPP Dark Target (daily)", gibsLayer: "VIIRS_SNPP_AOD_Dark_Target_Land_Ocean", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2012-03-01", lagDays: 1, legendUrl: `${GIBS_ORIGIN}/legends/MODIS_VIIRS_AOD_H.svg`, kind: "aerosol", note: "Dark Target algorithm; no retrieval over bright deserts/snow." },
  "tropomi-no2": { id: "tropomi-no2", label: "NO₂ tropospheric column · TROPOMI Sentinel-5P (L2, daily)", gibsLayer: "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2018-05-06", lagDays: 1, legendUrl: `${GIBS_ORIGIN}/legends/OMI_Nitrogen_Dioxide_Tropo_Column_H.svg`, kind: "no2", note: "Column amount, not surface concentration; GIBS archive has date gaps." },
  "omi-no2": { id: "omi-no2", label: "NO₂ tropospheric column · OMI Aura (daily, ~5-day latency)", gibsLayer: "OMI_Nitrogen_Dioxide_Tropo_Column", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2004-10-01", lagDays: 6, legendUrl: `${GIBS_ORIGIN}/legends/OMI_Nitrogen_Dioxide_Tropo_Column_H.svg`, kind: "no2", note: "Coarse (~13×24 km) and several days behind; row-anomaly stripes are instrument artefacts." },
  "omps-aerosol-index": { id: "omps-aerosol-index", label: "UV aerosol index (smoke / dust) · OMPS Suomi NPP (daily)", gibsLayer: "OMPS_Aerosol_Index", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2012-01-26", lagDays: 1, legendUrl: `${GIBS_ORIGIN}/legends/OMPS_Aerosol_Index_H.svg`, kind: "smoke-dust", note: "Absorbing aerosol (smoke, dust, ash) signal; unitless index, elevated plumes show most." },
  "airs-dust": { id: "airs-dust", label: "Dust score (day) · AIRS Aqua (L2, daily)", gibsLayer: "AIRS_L2_Dust_Score_Day", matrixSet: "GoogleMapsCompatible_Level6", maxZoom: 6, minDate: "2002-08-30", lagDays: 1, legendUrl: `${GIBS_ORIGIN}/legends/AIRS_Dust_Score_H.svg`, kind: "smoke-dust", note: "Infrared dust detection score; swath coverage only." },
});
export const isAirSatLayer = (v: unknown): v is AirSatLayerId => typeof v === "string" && Object.hasOwn(AIR_SAT_LAYERS, v);

export function defaultAirSatDate(layer: AirSatLayer, now = Date.now()): string {
  return utcDate(now - layer.lagDays * 86_400_000);
}
export function validateAirSatDate(layer: AirSatLayer, date: string, now = Date.now()): string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || utcDate(Date.parse(`${date}T00:00:00Z`)) !== date) throw new Error("Date must be a real YYYY-MM-DD date");
  if (date < layer.minDate) throw new Error(`Date must be on or after ${layer.minDate} for this layer`);
  if (date > utcDate(now)) throw new Error("Date cannot be in the future");
  return date;
}
export function airSatTileUrl(layer: AirSatLayer, date: string, t: TileCoord, now = Date.now()): string {
  if (!Number.isInteger(t.z) || t.z < 0 || t.z > layer.maxZoom || !Number.isInteger(t.x) || !Number.isInteger(t.y) || t.x < 0 || t.y < 0 || t.x >= 2 ** t.z || t.y >= 2 ** t.z)
    throw new Error("tile coordinate out of range");
  const day = validateAirSatDate(layer, date, now);
  return `${GIBS_ORIGIN}/wmts/epsg3857/best/${layer.gibsLayer}/default/${day}/${layer.matrixSet}/${t.z}/${t.y}/${t.x}.png`;
}
export function airSatFreshness(providerTime: string | undefined, now: number): { freshness: TileFreshness; ageMs: number | null } {
  if (!providerTime) return { freshness: "unknown", ageMs: null };
  const t = Date.parse(providerTime.length === 10 ? `${providerTime}T00:00:00Z` : providerTime);
  if (!Number.isFinite(t) || t > now + 86_400_000) return { freshness: "unknown", ageMs: null };
  const ageMs = Math.max(0, now - t);
  return { freshness: ageMs <= 3 * 86_400_000 ? "recent" : ageMs <= 30 * 86_400_000 ? "stale" : "historical", ageMs };
}
/** TileSource for the shared, bounded GIBS TileLoader (allowlist: /wmts/epsg3857/best/ on gibs.earthdata.nasa.gov). */
export function airSatSource(id: AirSatLayerId, date: string, now = Date.now()): TileSource {
  const layer = AIR_SAT_LAYERS[id];
  if (!layer) throw new Error("unknown satellite air layer");
  const day = validateAirSatDate(layer, date, now);
  return {
    sourceId: `air:${layer.gibsLayer}@${day}`, provider: `NASA GIBS · ${layer.label}`, attribution: GIBS_ATTRIBUTION, termsUrl: NASA_TERMS,
    licenseNote: "NASA open data; no copyright restriction; credit requested", requestedDate: day,
    urlFor: (t) => airSatTileUrl(layer, day, t, now), freshnessFor: airSatFreshness, concurrency: 4, perMinute: 120,
  };
}
export const AIR_SAT_TERMS_URL = NASA_TERMS;
