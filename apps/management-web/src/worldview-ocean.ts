/* Ocean maps and data for WorldView: read-only, manually opted-in, bounded.
 *
 * Map layers (draped on the globe as an overlay above any basemap, visible
 * viewport tiles only): GEBCO WMS bathymetry, NOAA NCEI DEM hillshade, NASA
 * GIBS Blue Marble shaded relief + bathymetry, NOAA ENC Direct (Maritime Chart
 * Service) nautical chart rendering, and NASA GIBS ocean products (GHRSST MUR
 * sea surface temperature and anomaly, VIIRS NOAA-20 chlorophyll-a, MUR sea ice
 * concentration) with a date picker.
 *
 * Point/grid data: Open-Meteo Marine API (browser-direct, CORS "*", keyless free
 * non-commercial tier), NOAA CO-OPS Tides & Currents (browser-direct, CORS "*",
 * keyless) and NOAA NDBC buoy latest observations (no CORS upstream, so via the
 * disabled-by-default same-origin relay /api/v1/worldview-ocean).
 *
 * Nothing here runs on import or render. Every request needs { network: true }.
 * NOT FOR NAVIGATION: charts, depths, tides, currents and waves shown here are
 * situational-awareness context only, never a substitute for official charts,
 * notices to mariners or tide tables.
 */
import type { Freshness, GeoPoint, Primitive, ProviderResult, RefreshOptions, WorldObservation } from "./worldview-core";
import { LruCache, type TileCoord } from "./worldview-basemap";

export const OCEAN_RELAY = "/api/v1/worldview-ocean";
export const OCEAN_RELAY_HEADER = "X-SignalWarden-Ocean";
export const NOT_FOR_NAVIGATION = "Not for navigation. Charts, depths, tides, currents and waves here are context only; use official NOAA/UKHO/national charts, tide tables and notices to mariners for navigation.";
export const OCEAN_LAYER = "ocean";
const GIBS_ORIGIN = "https://gibs.earthdata.nasa.gov";
const GEBCO_URL = "https://wms.gebco.net/mapserv";
const NCEI_HILLSHADE_URL = "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic_hillshade/ImageServer/exportImage";
const ENC_URL = "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer/export";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const COOPS_DATA_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const COOPS_STATIONS_URL = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels";
export const MAX_OCEAN_TILES = 48;
export const MAX_TILE_BYTES = 2 * 1024 * 1024;
const JSON_MAX = 1_000_000;
const STATION_LIST_MAX = 2_000_000;
const MERC_R = 20037508.342789244;
const MAX_MERC_LAT = 85.0511287798066;
const NASA_TERMS = "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance";

// ---------------------------------------------------------------- map layers
export type OceanLayerId =
  | "gebco-relief" | "gebco-colour" | "ncei-hillshade" | "gibs-bathymetry" | "noaa-enc"
  | "gibs-mur-sst" | "gibs-mur-sst-anomaly" | "gibs-chlorophyll" | "gibs-mur-sea-ice";
export type OceanTileFreshness = "recent" | "stale" | "historical" | "static-dataset" | "unknown";
export type OceanTileLayer = Readonly<{
  id: OceanLayerId;
  label: string;
  category: "bathymetry" | "chart" | "ocean-product";
  kind: "gibs" | "gebco-wms" | "arcgis-image" | "arcgis-map";
  provider: string;
  attribution: string;
  termsUrl: string;
  licenseNote: string;
  maxZoom: number;
  opacity: number;
  gibsLayer?: string;
  gibsMatrixSet?: string;
  gibsFormat?: "png" | "jpg";
  wmsLayer?: string;
  /** Daily product with a date picker. */
  dated: boolean;
  minDate?: string;
  /** Days behind UTC today the newest complete product usually is. */
  lagDays?: number;
  staticDataset: boolean;
  concurrency: number;
  perMinute: number;
  coverageNote: string;
  legend?: string;
}>;

const GEBCO_ATTR = "Imagery reproduced from the GEBCO_2026 Grid, GEBCO Compilation Group (2026) GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa); WMS by BODC";
export const OCEAN_TILE_LAYERS: Readonly<Record<OceanLayerId, OceanTileLayer>> = Object.freeze({
  "gebco-relief": {
    id: "gebco-relief", label: "GEBCO bathymetry · shaded relief (WMS)", category: "bathymetry", kind: "gebco-wms", provider: "GEBCO / BODC WMS",
    attribution: GEBCO_ATTR, termsUrl: "https://www.gebco.net/data-products/gridded-bathymetry-data", licenseNote: "GEBCO Grid: public domain, acknowledgement requested; WMS not for navigation, no warranty",
    maxZoom: 10, opacity: 0.9, wmsLayer: "GEBCO_LATEST", dated: false, staticDataset: true, concurrency: 3, perMinute: 120,
    coverageNote: "Global 15 arc-second grid, mostly deep water; much of the sea floor is interpolated, not surveyed. Shallow and coastal water is not detailed.",
  },
  "gebco-colour": {
    id: "gebco-colour", label: "GEBCO bathymetry · colour-shaded depth (WMS)", category: "bathymetry", kind: "gebco-wms", provider: "GEBCO / BODC WMS",
    attribution: GEBCO_ATTR, termsUrl: "https://www.gebco.net/data-products/gridded-bathymetry-data", licenseNote: "GEBCO Grid: public domain, acknowledgement requested; WMS not for navigation, no warranty",
    maxZoom: 10, opacity: 0.85, wmsLayer: "GEBCO_LATEST_2", dated: false, staticDataset: true, concurrency: 3, perMinute: 120,
    coverageNote: "Colour by elevation/depth from the GEBCO grid; interpolated where no soundings exist.",
  },
  "ncei-hillshade": {
    id: "ncei-hillshade", label: "NOAA NCEI global DEM mosaic · hillshade", category: "bathymetry", kind: "arcgis-image", provider: "NOAA NCEI",
    attribution: "NOAA National Centers for Environmental Information (NCEI) DEM global mosaic hillshade (ETOPO and coastal DEMs)",
    termsUrl: "https://www.ncei.noaa.gov/products/etopo-global-relief-model", licenseNote: "U.S. Government work (NOAA); no endorsement; not for navigation",
    maxZoom: 10, opacity: 0.75, dated: false, staticDataset: true, concurrency: 2, perMinute: 90,
    coverageNote: "Grey hillshade of NCEI's mosaic of ETOPO 2022 and higher-resolution coastal DEMs where available; resolution varies by region.",
  },
  "gibs-bathymetry": {
    id: "gibs-bathymetry", label: "NASA GIBS · Blue Marble shaded relief & bathymetry", category: "bathymetry", kind: "gibs", provider: "NASA GIBS",
    attribution: "NASA Earth Observatory Blue Marble (shaded relief and bathymetry) via NASA EOSDIS GIBS", termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 8, opacity: 1, gibsLayer: "BlueMarble_ShadedRelief_Bathymetry", gibsMatrixSet: "GoogleMapsCompatible_Level8", gibsFormat: "jpg",
    dated: false, staticDataset: true, concurrency: 4, perMinute: 240,
    coverageNote: "Static global composite (opaque); a cartographic relief rendering, not depth soundings.",
  },
  "noaa-enc": {
    id: "noaa-enc", label: "NOAA ENC Direct · nautical chart display (U.S. waters)", category: "chart", kind: "arcgis-map", provider: "NOAA Office of Coast Survey",
    attribution: "NOAA Office of Coast Survey, ENC Online / Maritime Chart Service (S-57 ENC rendered in S-52 style)",
    termsUrl: "https://nauticalcharts.noaa.gov/data/gis-data-and-services.html", licenseNote: "U.S. Government work; NOAA states this display is NOT to be used for navigation",
    maxZoom: 12, opacity: 0.95, dated: false, staticDataset: false, concurrency: 2, perMinute: 60,
    coverageNote: "U.S. and territorial waters only. At globe zoom you mostly see chart cell boundaries and coarse overview charts; soundings and aids appear at larger scales. Not an official chart product.",
  },
  "gibs-mur-sst": {
    id: "gibs-mur-sst", label: "NASA GIBS · GHRSST MUR sea surface temperature (daily L4)", category: "ocean-product", kind: "gibs", provider: "NASA GIBS",
    attribution: "GHRSST Level 4 MUR SST, NASA JPL PO.DAAC, via NASA EOSDIS GIBS", termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 7, opacity: 0.8, gibsLayer: "GHRSST_L4_MUR_Sea_Surface_Temperature", gibsMatrixSet: "GoogleMapsCompatible_Level7", gibsFormat: "png",
    dated: true, minDate: "2002-06-01", lagDays: 2, staticDataset: false, concurrency: 4, perMinute: 240,
    coverageNote: "Gap-free daily analysis (~1 km) blended from several satellites; usually 1-2 days behind today.", legend: "Colour scale: about -2 °C (purple) to 32 °C (red)",
  },
  "gibs-mur-sst-anomaly": {
    id: "gibs-mur-sst-anomaly", label: "NASA GIBS · GHRSST MUR SST anomaly (daily)", category: "ocean-product", kind: "gibs", provider: "NASA GIBS",
    attribution: "GHRSST Level 4 MUR SST anomaly, NASA JPL PO.DAAC, via NASA EOSDIS GIBS", termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 7, opacity: 0.8, gibsLayer: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies", gibsMatrixSet: "GoogleMapsCompatible_Level7", gibsFormat: "png",
    dated: true, minDate: "2019-07-23", lagDays: 2, staticDataset: false, concurrency: 4, perMinute: 240,
    coverageNote: "Difference from a multi-year daily climatology; blue = cooler, red = warmer than usual.", legend: "Colour scale: about -5 °C (blue) to +5 °C (red)",
  },
  "gibs-chlorophyll": {
    id: "gibs-chlorophyll", label: "NASA GIBS · VIIRS NOAA-20 chlorophyll-a (daily)", category: "ocean-product", kind: "gibs", provider: "NASA GIBS",
    attribution: "NASA OB.DAAC VIIRS NOAA-20 chlorophyll-a via NASA EOSDIS GIBS", termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 7, opacity: 0.85, gibsLayer: "VIIRS_NOAA20_Chlorophyll_a", gibsMatrixSet: "GoogleMapsCompatible_Level7", gibsFormat: "png",
    dated: true, minDate: "2018-02-24", lagDays: 1, staticDataset: false, concurrency: 4, perMinute: 240,
    coverageNote: "Daily ocean-colour retrieval; clouds, sun glint and night leave large gaps. A proxy for phytoplankton, not a water-quality or bloom-toxicity measurement.", legend: "Colour scale: log chlorophyll-a, about 0.01 (blue) to 20+ mg/m³ (red)",
  },
  "gibs-mur-sea-ice": {
    id: "gibs-mur-sea-ice", label: "NASA GIBS · GHRSST MUR sea ice concentration (daily)", category: "ocean-product", kind: "gibs", provider: "NASA GIBS",
    attribution: "GHRSST Level 4 MUR sea ice fraction, NASA JPL PO.DAAC, via NASA EOSDIS GIBS", termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 7, opacity: 0.85, gibsLayer: "GHRSST_L4_MUR_Sea_Ice_Concentration", gibsMatrixSet: "GoogleMapsCompatible_Level7", gibsFormat: "png",
    dated: true, minDate: "2002-06-01", lagDays: 2, staticDataset: false, concurrency: 4, perMinute: 240,
    coverageNote: "Ice fraction used as the MUR SST mask; coarse at the ice edge. The globe's Web Mercator tiles stop at ±85°.", legend: "Colour scale: ice fraction 0-100 %",
  },
});
export const OCEAN_LAYER_ORDER: readonly OceanLayerId[] = ["gebco-relief", "gebco-colour", "ncei-hillshade", "gibs-bathymetry", "noaa-enc", "gibs-mur-sst", "gibs-mur-sst-anomaly", "gibs-chlorophyll", "gibs-mur-sea-ice"];

// ---------------------------------------------------------------- dates
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function defaultOceanDate(layer: OceanTileLayer, now = Date.now()): string { return utcDay(now - (layer.lagDays ?? 1) * 86_400_000); }
export function validateOceanDate(layer: OceanTileLayer, date: string, now = Date.now()): string {
  if (!layer.dated) return "default";
  if (typeof date !== "string" || !DATE_RE.test(date) || utcDay(Date.parse(`${date}T00:00:00Z`)) !== date) throw new Error("Date must be a real YYYY-MM-DD date");
  if (layer.minDate && date < layer.minDate) throw new Error(`Date must be on or after ${layer.minDate} for this layer`);
  if (date > utcDay(now)) throw new Error("Date cannot be in the future");
  return date;
}

/** GIBS `layer-time-actual` header (ISO) or the requested date, as an ISO instant. */
export function parseProviderTime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const t = Date.parse(DATE_RE.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function oceanTileFreshness(layer: OceanTileLayer, providerTime: string | undefined, now = Date.now()): { freshness: OceanTileFreshness; ageMs: number | null } {
  if (layer.staticDataset) return { freshness: "static-dataset", ageMs: null };
  if (!layer.dated || !providerTime) return { freshness: "unknown", ageMs: null };
  const t = Date.parse(providerTime);
  if (!Number.isFinite(t) || t > now + 86_400_000) return { freshness: "unknown", ageMs: null };
  const ageMs = Math.max(0, now - t);
  return { freshness: ageMs <= 3 * 86_400_000 ? "recent" : ageMs <= 30 * 86_400_000 ? "stale" : "historical", ageMs };
}

// ---------------------------------------------------------------- tile URLs
const validTile = (t: TileCoord, maxZoom: number) =>
  Number.isInteger(t.z) && t.z >= 0 && t.z <= maxZoom && Number.isInteger(t.x) && Number.isInteger(t.y) && t.x >= 0 && t.y >= 0 && t.x < 2 ** t.z && t.y < 2 ** t.z;

/** EPSG:3857 bounds (metres) of a Web Mercator tile. */
export function tileMercatorBounds(t: TileCoord): { west: number; south: number; east: number; north: number } {
  const span = (2 * MERC_R) / 2 ** t.z;
  const west = -MERC_R + t.x * span, north = MERC_R - t.y * span;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { west: r(west), south: r(north - span), east: r(west + span), north: r(north) };
}

export function oceanTileUrl(layer: OceanTileLayer, t: TileCoord, date = "default"): string {
  if (!validTile(t, layer.maxZoom)) throw new Error("tile coordinate out of range");
  if (layer.kind === "gibs") {
    const day = layer.dated ? date : "default";
    if (layer.dated && !DATE_RE.test(day)) throw new Error("GIBS date must be YYYY-MM-DD");
    return `${GIBS_ORIGIN}/wmts/epsg3857/best/${layer.gibsLayer}/default/${day}/${layer.gibsMatrixSet}/${t.z}/${t.y}/${t.x}.${layer.gibsFormat}`;
  }
  const b = tileMercatorBounds(t);
  const bbox = `${b.west},${b.south},${b.east},${b.north}`;
  if (layer.kind === "gebco-wms")
    return `${GEBCO_URL}?${new URLSearchParams({ service: "WMS", version: "1.3.0", request: "GetMap", layers: layer.wmsLayer!, styles: "", crs: "EPSG:3857", bbox, width: "256", height: "256", format: "image/png" })}`;
  const params = new URLSearchParams({ bbox, bboxSR: "3857", imageSR: "3857", size: "256,256", format: "png", ...(layer.kind === "arcgis-map" ? { transparent: "true" } : {}), f: "image" });
  return `${layer.kind === "arcgis-image" ? NCEI_HILLSHADE_URL : ENC_URL}?${params}`;
}

const GIBS_LAYERS = new Set(Object.values(OCEAN_TILE_LAYERS).map((l) => l.gibsLayer).filter(Boolean));
/** Exact host + path allowlist for every request this module can make. */
export function allowedOceanUrl(url: string): boolean {
  if (url.startsWith(`${OCEAN_RELAY}/`)) return /^\/api\/v1\/worldview-ocean\/(status|ndbc\/latest\?west=-?[\d.]+&south=-?[\d.]+&east=-?[\d.]+&north=-?[\d.]+)$/.test(url);
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443")) return false;
  const path = `${u.origin}${u.pathname}`;
  if (u.origin === GIBS_ORIGIN) {
    const m = /^\/wmts\/epsg3857\/best\/([A-Za-z0-9_]+)\/default\/(default|\d{4}-\d{2}-\d{2})\/GoogleMapsCompatible_Level\d\/\d{1,2}\/\d{1,6}\/\d{1,6}\.(png|jpg)$/.exec(u.pathname);
    return !!m && GIBS_LAYERS.has(m[1]) && !u.search;
  }
  if (path === GEBCO_URL) return u.searchParams.get("request") === "GetMap" && u.searchParams.get("service") === "WMS";
  if (path === NCEI_HILLSHADE_URL || path === ENC_URL) return u.searchParams.get("f") === "image";
  if (path === MARINE_URL) return !u.searchParams.has("apikey");
  if (path === COOPS_DATA_URL) return true;
  if (url === COOPS_STATIONS_URL) return true;
  return false;
}

// ---------------------------------------------------------------- transport
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const safeError = (e: unknown) => (e instanceof Error ? e.message.slice(0, 300) : "Request failed");
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

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

async function request(url: string, options: RefreshOptions, fetcher: Fetcher, accept: string): Promise<Response> {
  if (options.network !== true) throw new Error("Network access is opt-in; enable ocean requests first");
  if (!allowedOceanUrl(url)) throw new Error("URL is not on the ocean provider allowlist");
  const relay = url.startsWith(OCEAN_RELAY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20_000, options.timeoutMs ?? 12_000)));
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const headers: Record<string, string> = { Accept: accept };
    if (relay) headers[OCEAN_RELAY_HEADER] = "enabled";
    return await fetcher(url, { method: "GET", headers, signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", mode: relay ? "same-origin" : "cors" });
  } finally { clearTimeout(timer); }
}

async function readJson(url: string, options: RefreshOptions, fetcher: Fetcher, max = JSON_MAX): Promise<unknown> {
  const response = await request(url, options, fetcher, "application/json");
  const bytes = await readBounded(response, max);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Object.assign(new Error(`HTTP ${response.status}: invalid JSON`), { status: response.status }); }
  if (!response.ok) {
    const err = obj(body) && obj(body.error) ? body.error : undefined;
    const code = str(err?.code, 60), message = str(err?.message, 240) ?? (obj(body) ? str(body.reason, 240) : undefined);
    throw Object.assign(new Error(code ? `${code}: ${message ?? `HTTP ${response.status}`}` : message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`), { code, status: response.status });
  }
  return body;
}

export async function fetchOceanTile(url: string, options: RefreshOptions, fetcher: Fetcher = fetch): Promise<{ blob: Blob; contentType: string; layerTime?: string }> {
  const response = await request(url, options, fetcher, "image/*");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg"].includes(contentType)) throw new Error("Provider returned a non-image tile (often a WMS/ArcGIS error)");
  const bytes = await readBounded(response, MAX_TILE_BYTES);
  return { blob: new Blob([bytes as BlobPart], { type: contentType }), contentType, layerTime: parseProviderTime(response.headers.get("layer-time-actual")) };
}

// ---------------------------------------------------------------- tile loader
export type OceanTileRecord<T> = Readonly<{
  key: string; tile: TileCoord; data: T; provider: string; sourceUrl: string; retrievedAt: string; providerTime?: string;
  freshness: OceanTileFreshness; ageMs: number | null; attribution: string; termsUrl: string; licenseNote: string; live: true;
}>;
export type OceanLoadResult<T> = { loaded: OceanTileRecord<T>[]; failed: { key: string; error: string }[]; throttled: number; fromCache: number; fetched: number };

/** Bounded, rate-limited, LRU-cached tile loader. No request unless network is true. */
export class OceanTileLoader<T> {
  readonly cache: LruCache<OceanTileRecord<T>>;
  private stamps: number[] = [];
  constructor(private opts: { network: boolean; decode: (blob: Blob, type: string) => Promise<T>; fetcher?: Fetcher; cacheEntries?: number; now?: () => number; onEvict?: (key: string, v: OceanTileRecord<T>) => void }) {
    this.cache = new LruCache<OceanTileRecord<T>>(opts.cacheEntries ?? 128, opts.onEvict);
  }
  private now() { return this.opts.now?.() ?? Date.now(); }
  private allow(perMinute: number) {
    const now = this.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= perMinute) return false;
    this.stamps.push(now);
    return true;
  }
  async load(layer: OceanTileLayer, date: string, tiles: ReadonlyArray<TileCoord>, signal?: AbortSignal): Promise<OceanLoadResult<T>> {
    const result: OceanLoadResult<T> = { loaded: [], failed: [], throttled: 0, fromCache: 0, fetched: 0 };
    const day = validateOceanDate(layer, date, this.now());
    const todo: TileCoord[] = [];
    for (const t of tiles.slice(0, MAX_OCEAN_TILES)) {
      const hit = this.cache.get(`${layer.id}@${day}|${t.z}/${t.x}/${t.y}`);
      if (hit) { result.loaded.push(hit); result.fromCache++; } else todo.push(t);
    }
    if (todo.length && this.opts.network !== true) {
      todo.forEach((t) => result.failed.push({ key: `${t.z}/${t.x}/${t.y}`, error: "Network access is opt-in" }));
      return result;
    }
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const t = todo[i++];
        if (signal?.aborted) return;
        const key = `${t.z}/${t.x}/${t.y}`;
        if (!this.allow(Math.max(1, Math.min(600, layer.perMinute)))) { result.throttled++; continue; }
        try {
          const url = oceanTileUrl(layer, t, day);
          const bytes = await fetchOceanTile(url, { network: this.opts.network, signal }, this.opts.fetcher ?? fetch);
          const data = await this.opts.decode(bytes.blob, bytes.contentType);
          const now = this.now();
          const providerTime = layer.dated ? bytes.layerTime ?? parseProviderTime(day) : undefined;
          const fresh = oceanTileFreshness(layer, providerTime, now);
          const record: OceanTileRecord<T> = {
            key, tile: t, data, provider: layer.provider, sourceUrl: url, retrievedAt: new Date(now).toISOString(), providerTime,
            freshness: fresh.freshness, ageMs: fresh.ageMs, attribution: layer.attribution, termsUrl: layer.termsUrl, licenseNote: layer.licenseNote, live: true,
          };
          this.cache.set(`${layer.id}@${day}|${key}`, record);
          result.loaded.push(record);
          result.fetched++;
        } catch (e) {
          if (signal?.aborted) return;
          result.failed.push({ key, error: safeError(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(6, layer.concurrency, todo.length || 1)) }, worker));
    return result;
  }
}

// ---------------------------------------------------------------- throttle/cache for data feeds
export type OceanBbox = Readonly<{ west: number; south: number; east: number; north: number }>;
export type OceanStatus = "live" | "stale" | "failed" | "throttled" | "disabled" | "not_configured";
export interface OceanResult extends ProviderResult {
  status: OceanStatus;
  sourceUrl?: string;
  attribution: string;
  termsUrl: string;
  truncated?: boolean;
  keyStatus: "not_required";
}
type Entry = { key: string; at: number; result: OceanResult };
const caches = new Map<string, Entry>();
const attempts = new Map<string, number>();
let stationList: { at: number; stations: CoopsStation[] } | null = null;
export function resetOceanState(): void { caches.clear(); attempts.clear(); stationList = null; }

function failed(providerId: string, meta: { attribution: string; termsUrl: string }, error: string, status: OceanStatus = "failed"): OceanResult {
  const cached = caches.get(providerId);
  if (cached) return { ...cached.result, status: "stale", freshness: "stale", error: `${error}; showing last successful snapshot as stale`, observations: cached.result.observations.map((o) => ({ ...o, freshness: "stale", stale: true })) };
  return { providerId, observations: [], retrievedAt: new Date().toISOString(), freshness: "failed", status, error, keyStatus: "not_required", ...meta };
}

async function throttled<R extends OceanResult>(providerId: string, key: string, minMs: number, meta: { attribution: string; termsUrl: string }, run: () => Promise<R>, now = Date.now()): Promise<R | OceanResult> {
  const last = attempts.get(providerId) ?? 0;
  if (now - last < minMs) {
    const wait = Math.ceil((minMs - (now - last)) / 1000);
    const cached = caches.get(providerId);
    if (cached && cached.key === key) return { ...cached.result, error: `Refresh throttled for ${wait}s; showing cached data` };
    return failed(providerId, meta, `Refresh throttled; wait ${wait}s (≥${Math.round(minMs / 1000)}s between requests)`, "throttled");
  }
  attempts.set(providerId, now);
  try {
    const result = await run();
    caches.set(providerId, { key, at: now, result });
    return result;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404 && (e as { code?: string }).code === "ocean_relay_disabled")
      return failed(providerId, meta, "Ocean relay disabled on the server (set UCAS_WORLDVIEW_OCEAN_ENABLED=1)", "disabled");
    return failed(providerId, meta, safeError(e));
  }
}

export function validateOceanBbox(b: OceanBbox, maxSpan = 60): OceanBbox {
  const { west, south, east, north } = b ?? ({} as OceanBbox);
  if (![west, south, east, north].every(finite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north)
    throw new Error("Bounding box must be west<east, south<north within WGS84 degrees (no antimeridian wrap)");
  if (east - west > maxSpan || north - south > maxSpan) throw new Error(`Bounding box span is capped at ${maxSpan} degrees per side`);
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { west: r(west), south: r(south), east: r(east), north: r(north) };
}
/** Clamp a viewport rectangle to the cap around its centre (no wrap). */
export function boundedOceanBbox(view: OceanBbox, maxSpan = 60): OceanBbox {
  const cx = (view.west + view.east) / 2, cy = (view.south + view.north) / 2;
  const hw = Math.min(maxSpan, view.east - view.west) / 2, hh = Math.min(maxSpan, view.north - view.south) / 2;
  return validateOceanBbox({ west: Math.max(-180, cx - hw), east: Math.min(180, cx + hw), south: Math.max(-90, cy - hh), north: Math.min(90, cy + hh) }, maxSpan);
}

function ageMinutes(iso: string, now: number) { return Math.max(0, Math.round((now - Date.parse(iso)) / 60000)); }
function validPast(iso: unknown, now: number): string | undefined {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > now + 5 * 60_000) return undefined;
  return new Date(Math.min(t, now)).toISOString();
}
function provenance(p: { provider: string; sourceUrl: string; retrievedAt: string; providerTimestamp: string; now: number; attribution: string; termsUrl: string; disclosure: string }): Record<string, Primitive> {
  return {
    provider: p.provider, sourceUrl: p.sourceUrl.slice(0, 500), retrievedAt: p.retrievedAt, providerTimestamp: p.providerTimestamp,
    ageMinutesAtRetrieval: ageMinutes(p.providerTimestamp, p.now), attribution: p.attribution.slice(0, 400), license: p.termsUrl,
    disclosure: p.disclosure.slice(0, 400), notForNavigation: true, live: true,
  };
}
const round = (v: number | null | undefined, d = 2) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// ---------------------------------------------------------------- Open-Meteo Marine
export const MARINE_SOURCE = Object.freeze({
  providerId: "open-meteo-marine", name: "Open-Meteo Marine API",
  attribution: "Marine data by Open-Meteo.com (CC BY 4.0); MeteoFrance MFWAM waves and SMOC currents/SST generated using E.U. Copernicus Marine Service Information; ECMWF WAM; NOAA NCEP GFS Wave; DWD EWAM/GWAM",
  termsUrl: "https://open-meteo.com/en/terms", licenseUrl: "https://open-meteo.com/en/licence",
  limits: "Free tier: non-commercial only, <10,000 calls/day (each grid location counts); commercial use needs an Open-Meteo plan",
});
export const MARINE_VARIABLES = ["wave_height", "wave_direction", "wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period", "wind_wave_height", "wind_wave_direction", "ocean_current_velocity", "ocean_current_direction", "sea_surface_temperature"] as const;
export type MarineVariable = (typeof MARINE_VARIABLES)[number];
export type MarineCell = Readonly<{ lat: number; lon: number; requestedLat: number; requestedLon: number; time: string; values: Readonly<Record<MarineVariable, number | null>>; noData: boolean }>;
export interface MarineResult extends OceanResult { cells: MarineCell[]; units: Record<string, string>; grid?: { bbox: OceanBbox; n: number; dLat: number; dLon: number } }
export const MAX_GRID = 8;
const MARINE_FRESH_MS = 3 * 3600_000;

export function marineGridPoints(bbox: OceanBbox, n: number): GeoPoint[] {
  const b = validateOceanBbox(bbox);
  if (!Number.isInteger(n) || n < 2 || n > MAX_GRID) throw new Error(`Grid must be 2-${MAX_GRID} cells per side`);
  const dLat = (b.north - b.south) / n, dLon = (b.east - b.west) / n;
  const out: GeoPoint[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++)
    out.push({ lat: Math.round((b.north - (j + 0.5) * dLat) * 1e4) / 1e4, lon: Math.round((b.west + (i + 0.5) * dLon) * 1e4) / 1e4 });
  return out;
}
export function marineUrl(points: readonly GeoPoint[]): string {
  if (!points.length || points.length > MAX_GRID * MAX_GRID) throw new Error(`1-${MAX_GRID * MAX_GRID} locations per request`);
  for (const p of points) if (!finite(p.lat) || !finite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) throw new Error("Invalid marine coordinate");
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(","), longitude: points.map((p) => p.lon.toFixed(4)).join(","),
    current: MARINE_VARIABLES.join(","), timezone: "GMT", cell_selection: "sea",
  });
  return `${MARINE_URL}?${q}`;
}
export function parseMarine(body: unknown, requested: readonly GeoPoint[], now: number): { cells: MarineCell[]; units: Record<string, string> } {
  const list = Array.isArray(body) ? body : [body];
  if (!list.length || !list.every(obj)) throw new Error("Invalid Open-Meteo Marine response schema");
  if (list.length !== requested.length) throw new Error("Open-Meteo Marine returned a different number of locations than requested");
  const cells: MarineCell[] = [];
  let units: Record<string, string> = {};
  list.forEach((loc, i) => {
    const r = loc as Record<string, unknown>;
    const cur = obj(r.current) ? r.current : null;
    if (!cur || !finite(r.latitude) || !finite(r.longitude)) throw new Error("Open-Meteo Marine location has no current block");
    if (r.utc_offset_seconds !== 0) throw new Error("Open-Meteo Marine times were not returned in GMT");
    const time = validPast(typeof cur.time === "string" ? `${cur.time}${cur.time.length === 16 ? ":00Z" : ""}` : undefined, now);
    if (!time) throw new Error("Open-Meteo Marine current time is missing or in the future");
    const values = Object.fromEntries(MARINE_VARIABLES.map((v) => [v, finite(cur[v]) ? (cur[v] as number) : null])) as Record<MarineVariable, number | null>;
    if (obj(r.current_units)) units = Object.fromEntries(Object.entries(r.current_units).filter(([k, v]) => (MARINE_VARIABLES as readonly string[]).includes(k) && typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 12)]));
    cells.push({ lat: r.latitude, lon: r.longitude, requestedLat: requested[i].lat, requestedLon: requested[i].lon, time, values, noData: MARINE_VARIABLES.every((v) => values[v] === null) });
  });
  return { cells, units };
}

const kmhToMs = (v: number | null) => (v === null ? null : Math.round((v / 3.6) * 100) / 100);
function marineObservation(c: MarineCell, sourceUrl: string, retrievedAt: string, units: Record<string, string>, now: number): WorldObservation {
  const v = c.values;
  const currentUnit = units.ocean_current_velocity ?? "km/h";
  const currentMs = currentUnit === "km/h" ? kmhToMs(v.ocean_current_velocity) : currentUnit === "m/s" ? v.ocean_current_velocity : null;
  const parts = [v.wave_height !== null ? `Hs ${v.wave_height.toFixed(1)} m` : null, v.sea_surface_temperature !== null ? `SST ${v.sea_surface_temperature.toFixed(1)} °C` : null, currentMs !== null ? `current ${currentMs.toFixed(2)} m/s` : null].filter(Boolean);
  return {
    id: `marine-${c.lat.toFixed(3)}-${c.lon.toFixed(3)}`, layer: OCEAN_LAYER, point: { lat: c.lat, lon: c.lon, uncertaintyM: 8000 }, observedAt: c.time,
    source: "Open-Meteo Marine", label: `Marine model: ${parts.join(" · ") || "no ocean data at this cell (land or outside model)"}`,
    freshness: Math.abs(now - Date.parse(c.time)) <= MARINE_FRESH_MS ? "fresh" : "stale",
    properties: {
      ...provenance({ provider: "Open-Meteo Marine", sourceUrl, retrievedAt, providerTimestamp: c.time, now, attribution: MARINE_SOURCE.attribution, termsUrl: MARINE_SOURCE.termsUrl, disclosure: "Model analysis/forecast at the nearest ~5-25 km sea grid cell, not a measurement; coastal accuracy is limited" }),
      dataKind: "model", waveHeightM: round(v.wave_height), waveDirectionFromDeg: round(v.wave_direction, 0), wavePeriodS: round(v.wave_period, 1),
      swellHeightM: round(v.swell_wave_height), swellDirectionFromDeg: round(v.swell_wave_direction, 0), swellPeriodS: round(v.swell_wave_period, 1),
      windWaveHeightM: round(v.wind_wave_height), windWaveDirectionFromDeg: round(v.wind_wave_direction, 0),
      currentSpeedMs: currentMs, currentDirectionTowardDeg: round(v.ocean_current_direction, 0), seaSurfaceTempC: round(v.sea_surface_temperature, 1),
      requestedLat: c.requestedLat, requestedLon: c.requestedLon,
    },
  };
}

export async function refreshMarinePoint(center: GeoPoint, options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<MarineResult | OceanResult> {
  const providerId = "open-meteo-marine-point";
  const meta = { attribution: MARINE_SOURCE.attribution, termsUrl: MARINE_SOURCE.termsUrl };
  if (options.network !== true) return failed(providerId, meta, "Network access is opt-in");
  let url: string;
  const point = { lat: Math.round(center.lat * 1e4) / 1e4, lon: Math.round(center.lon * 1e4) / 1e4 };
  try { url = marineUrl([point]); } catch (e) { return failed(providerId, meta, safeError(e)); }
  return throttled(providerId, url, 15_000, meta, async () => {
    const body = await readJson(url, options, fetcher);
    const now = Date.now(), retrievedAt = new Date(now).toISOString();
    const { cells, units } = parseMarine(body, [point], now);
    const observations = cells.map((c) => marineObservation(c, url, retrievedAt, units, now));
    const fresh = observations.every((o) => o.freshness === "fresh");
    return { providerId, observations, cells, units, retrievedAt, freshness: fresh ? "fresh" : "stale", status: fresh ? "live" : "stale", sourceUrl: url, keyStatus: "not_required", ...meta } satisfies MarineResult;
  });
}

export async function refreshMarineGrid(bbox: OceanBbox, n: number, options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<MarineResult | OceanResult> {
  const providerId = "open-meteo-marine-grid";
  const meta = { attribution: MARINE_SOURCE.attribution, termsUrl: MARINE_SOURCE.termsUrl };
  if (options.network !== true) return failed(providerId, meta, "Network access is opt-in");
  let points: GeoPoint[], url: string, b: OceanBbox;
  try { b = validateOceanBbox(bbox); points = marineGridPoints(b, n); url = marineUrl(points); } catch (e) { return failed(providerId, meta, safeError(e)); }
  return throttled(providerId, url, 60_000, meta, async () => {
    const body = await readJson(url, options, fetcher);
    const now = Date.now(), retrievedAt = new Date(now).toISOString();
    const { cells, units } = parseMarine(body, points, now);
    const times = cells.map((c) => Date.parse(c.time));
    const fresh = times.every((t) => Math.abs(now - t) <= MARINE_FRESH_MS);
    return {
      providerId, observations: [], cells, units, retrievedAt, freshness: fresh ? "fresh" : "stale", status: fresh ? "live" : "stale", sourceUrl: url, keyStatus: "not_required",
      grid: { bbox: b, n, dLat: (b.north - b.south) / n, dLon: (b.east - b.west) / n }, ...meta,
    } satisfies MarineResult;
  });
}

// ---------------------------------------------------------------- grid painting (pure; canvas drawing lives in the component)
export type GridMetric = "wave_height" | "sea_surface_temperature" | "ocean_current_velocity" | "swell_wave_height";
export type GridArrows = "current" | "wave" | "swell" | "none";
export type Rgba = readonly [number, number, number, number];
export type PaintOp = { kind: "cell"; x: number; y: number; w: number; h: number; rgba: Rgba } | { kind: "arrow"; x: number; y: number; angleRad: number; length: number; rgba: Rgba };
const ramp = (t: number, stops: ReadonlyArray<readonly [number, number, number]>, alpha = 150): Rgba => {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f), alpha];
};
const COOL_WARM = [[49, 54, 149], [69, 117, 180], [116, 173, 209], [254, 224, 144], [244, 109, 67], [165, 0, 38]] as const;
const SEA = [[13, 59, 102], [33, 145, 140], [94, 201, 98], [253, 231, 37], [240, 80, 60]] as const;
export const GRID_SCALES: Readonly<Record<GridMetric, { min: number; max: number; unit: string; label: string }>> = Object.freeze({
  wave_height: { min: 0, max: 8, unit: "m", label: "Significant wave height" },
  swell_wave_height: { min: 0, max: 6, unit: "m", label: "Swell wave height" },
  sea_surface_temperature: { min: -2, max: 32, unit: "°C", label: "Sea surface temperature (model)" },
  ocean_current_velocity: { min: 0, max: 7.2, unit: "km/h", label: "Ocean current speed" },
});
export function metricColor(metric: GridMetric, value: number | null): Rgba | null {
  if (value === null || !finite(value)) return null;
  const s = GRID_SCALES[metric];
  return ramp((value - s.min) / (s.max - s.min), metric === "sea_surface_temperature" ? COOL_WARM : SEA);
}
const mercX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const mercY = (lat: number, z: number) => {
  const r = (Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
/** Paint operations (cells, then arrows) for one Web Mercator tile, in tile pixels. */
export function gridPaintOps(cells: readonly MarineCell[], grid: { dLat: number; dLon: number }, metric: GridMetric, arrows: GridArrows, tile: TileCoord, size = 256): PaintOp[] {
  const ops: PaintOp[] = [], arrowOps: PaintOp[] = [];
  const px = (lon: number) => (mercX(lon, tile.z) - tile.x) * size, py = (lat: number) => (mercY(lat, tile.z) - tile.y) * size;
  for (const c of cells) {
    // Cells are drawn at the requested grid position (the model cell may be up to ~25 km away).
    const x0 = px(c.requestedLon - grid.dLon / 2), x1 = px(c.requestedLon + grid.dLon / 2);
    const y0 = py(c.requestedLat + grid.dLat / 2), y1 = py(c.requestedLat - grid.dLat / 2);
    if (x1 < 0 || x0 > size || y1 < 0 || y0 > size) continue;
    const rgba = metricColor(metric, c.values[metric]);
    if (rgba) ops.push({ kind: "cell", x: x0, y: y0, w: x1 - x0, h: y1 - y0, rgba });
    const dir = arrows === "current" ? c.values.ocean_current_direction : arrows === "wave" ? c.values.wave_direction : arrows === "swell" ? c.values.swell_wave_direction : null;
    if (dir === null || !finite(dir)) continue;
    // Current direction is "toward"; wave/swell direction is "from", so the arrow points downwind (+180°).
    const toward = arrows === "current" ? dir : (dir + 180) % 360;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (cx < -8 || cx > size + 8 || cy < -8 || cy > size + 8) continue;
    const length = Math.max(6, Math.min(Math.min(x1 - x0, y1 - y0) * 0.8, 48));
    arrowOps.push({ kind: "arrow", x: cx, y: cy, angleRad: (toward * Math.PI) / 180, length, rgba: [245, 250, 255, 235] });
  }
  return [...ops, ...arrowOps];
}

// ---------------------------------------------------------------- NDBC (relay)
export const NDBC_SOURCE = Object.freeze({
  providerId: "noaa-ndbc", name: "NOAA NDBC buoy & station latest observations",
  attribution: "NOAA National Data Buoy Center (NDBC) and partner station owners; provisional real-time data",
  termsUrl: "https://www.ndbc.noaa.gov/disclaimer.shtml", endpoint: "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt",
});
const NDBC_FRESH_MS = 3 * 3600_000;
export async function refreshNdbcBuoys(bbox: OceanBbox, options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<OceanResult> {
  const providerId = "noaa-ndbc";
  const meta = { attribution: NDBC_SOURCE.attribution, termsUrl: NDBC_SOURCE.termsUrl };
  if (options.network !== true) return failed(providerId, meta, "Network access is opt-in");
  let b: OceanBbox;
  try { b = validateOceanBbox(bbox); } catch (e) { return failed(providerId, meta, safeError(e)); }
  const url = `${OCEAN_RELAY}/ndbc/latest?${new URLSearchParams({ west: String(b.west), south: String(b.south), east: String(b.east), north: String(b.north) })}`;
  return throttled(providerId, url, 60_000, meta, async () => {
    const body = await readJson(url, options, fetcher);
    if (!obj(body) || body.provider !== "noaa-ndbc" || !Array.isArray(body.stations)) throw new Error("Invalid NDBC relay response");
    const now = Date.now();
    const retrievedAt = validPast(body.retrievedAt, now) ?? new Date(now).toISOString();
    const observations: WorldObservation[] = [];
    for (const s of body.stations.slice(0, 300)) {
      if (!obj(s) || typeof s.station !== "string" || !/^[A-Z0-9]{3,8}$/.test(s.station) || !finite(s.lat) || !finite(s.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) continue;
      const observed = validPast(s.observedAt, now);
      if (!observed) continue;
      const v = obj(s.values) ? s.values : {};
      const n = (k: string) => (finite(v[k]) ? (v[k] as number) : null);
      const parts = [n("waveHeightM") !== null ? `Hs ${n("waveHeightM")} m` : null, n("waterTempC") !== null ? `water ${n("waterTempC")} °C` : null, n("windSpeedMs") !== null ? `wind ${n("windSpeedMs")} m/s` : null].filter(Boolean);
      const name = str(s.name, 120);
      const stationUrl = typeof s.sourceUrl === "string" && s.sourceUrl.startsWith("https://www.ndbc.noaa.gov/station_page.php?station=") ? s.sourceUrl.slice(0, 200) : NDBC_SOURCE.endpoint;
      observations.push({
        id: `ndbc-${s.station}`, layer: OCEAN_LAYER, point: { lat: s.lat, lon: s.lon }, observedAt: observed, source: "NOAA NDBC",
        label: `NDBC ${str(s.stationType, 24) ?? "station"} ${s.station}${name ? ` (${name})` : ""}: ${parts.join(" · ") || "no wave/water/wind fields in latest report"}`,
        title: name ?? `NDBC ${s.station}`, freshness: now - Date.parse(observed) <= NDBC_FRESH_MS ? "fresh" : "stale",
        properties: {
          ...provenance({ provider: "NOAA NDBC", sourceUrl: stationUrl, retrievedAt, providerTimestamp: observed, now, attribution: `${NDBC_SOURCE.attribution}${str(s.owner, 120) ? `; station owner: ${str(s.owner, 120)}` : ""}`, termsUrl: NDBC_SOURCE.termsUrl, disclosure: "Measured, provisional latest report; missing fields mean the station did not report them" }),
          dataKind: "measured", station: s.station, stationOwner: str(s.owner, 120) ?? null, stationType: str(s.stationType, 24) ?? null,
          feedUrl: NDBC_SOURCE.endpoint, fileLastModified: validPast(body.fileLastModified, now) ?? null,
          windDirDeg: n("windDirDeg"), windSpeedMs: n("windSpeedMs"), gustMs: n("gustMs"), waveHeightM: n("waveHeightM"),
          dominantPeriodS: n("dominantPeriodS"), averagePeriodS: n("averagePeriodS"), meanWaveDirFromDeg: n("meanWaveDirDeg"),
          pressureHpa: n("pressureHpa"), airTempC: n("airTempC"), waterTempC: n("waterTempC"), dewPointC: n("dewPointC"), tideFt: n("tideFt"),
        },
      });
    }
    if (observations.length === 0) {
      return { providerId, observations, retrievedAt, freshness: "failed", status: "failed", error: "No current usable observations returned by NOAA NDBC", sourceUrl: NDBC_SOURCE.endpoint, truncated: body.truncated === true, keyStatus: "not_required", ...meta };
    }
    const fresh = observations.some((o) => o.freshness === "fresh");
    return { providerId, observations, retrievedAt, freshness: fresh ? "fresh" : "stale", status: fresh ? "live" : "stale", sourceUrl: NDBC_SOURCE.endpoint, truncated: body.truncated === true, keyStatus: "not_required", ...meta };
  });
}

export type OceanRelayStatus = { state: "enabled" | "disabled" | "error"; message: string };
export async function fetchOceanRelayStatus(options: RefreshOptions = {}, fetcher: Fetcher = fetch): Promise<OceanRelayStatus> {
  try {
    const body = await readJson(`${OCEAN_RELAY}/status`, options, fetcher);
    return obj(body) && body.enabled === true ? { state: "enabled", message: "Ocean relay enabled (NDBC buoys, keyless)" } : { state: "error", message: "Unexpected relay status" };
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { state: "disabled", message: "Ocean relay disabled on the server (set UCAS_WORLDVIEW_OCEAN_ENABLED=1)" };
    return { state: "error", message: safeError(e) };
  }
}

// ---------------------------------------------------------------- NOAA CO-OPS tides & water levels
export const COOPS_SOURCE = Object.freeze({
  providerId: "noaa-coops", name: "NOAA CO-OPS Tides & Currents (water levels and tide predictions)",
  attribution: "NOAA National Ocean Service, Center for Operational Oceanographic Products and Services (CO-OPS)",
  termsUrl: "https://tidesandcurrents.noaa.gov/disclaimers.html", endpoint: COOPS_DATA_URL,
});
export type CoopsStation = Readonly<{ id: string; name: string; lat: number; lon: number; state?: string; tidal: boolean; greatLakes: boolean }>;
export type TidePrediction = Readonly<{ time: string; heightM: number; type: "H" | "L" }>;
export type TideStationReading = Readonly<{ station: CoopsStation; datum: string; waterLevelM: number | null; waterLevelTime: string | null; quality: string | null; predictions: TidePrediction[]; error?: string; pageUrl: string }>;
export interface TideResult extends OceanResult { stations: TideStationReading[] }
const STATION_LIST_TTL = 24 * 3600_000;
const COOPS_FRESH_MS = 60 * 60_000;
/** CO-OPS "YYYY-MM-DD HH:MM" in GMT; predictions may be up to 3 days ahead, observations may not be in the future. */
function coopsTime(t: unknown, now: number, allowFuture = false): string | undefined {
  if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)) return undefined;
  const ms = Date.parse(`${t.replace(" ", "T")}:00Z`);
  if (!Number.isFinite(ms) || ms > now + (allowFuture ? 3 * 86_400_000 : 5 * 60_000)) return undefined;
  return new Date(ms).toISOString();
}

export function parseCoopsStations(body: unknown): CoopsStation[] {
  if (!obj(body) || !Array.isArray(body.stations)) throw new Error("Invalid CO-OPS station list");
  const out: CoopsStation[] = [];
  for (const s of body.stations.slice(0, 5000)) {
    if (!obj(s) || typeof s.id !== "string" || !/^\d{7}$/.test(s.id) || !finite(s.lat) || !finite(s.lng) || Math.abs(s.lat) > 90 || Math.abs(s.lng) > 180) continue;
    out.push({ id: s.id, name: str(s.name, 80) ?? s.id, lat: s.lat, lon: s.lng, state: str(s.state, 4), tidal: s.tidal === true, greatLakes: s.greatlakes === true });
  }
  return out;
}
export function coopsDataUrl(station: string, product: "water_level" | "predictions", datum: string, beginDate?: string): string {
  if (!/^\d{7}$/.test(station) || !/^(MLLW|IGLD)$/.test(datum)) throw new Error("Invalid CO-OPS station or datum");
  const q: Record<string, string> = { station, product, datum, units: "metric", time_zone: "gmt", format: "json", application: "SignalWarden_WorldView" };
  if (product === "water_level") q.date = "latest";
  else { q.begin_date = beginDate ?? ""; q.range = "48"; q.interval = "hilo"; if (!/^\d{8}$/.test(q.begin_date)) throw new Error("Invalid begin date"); }
  return `${COOPS_DATA_URL}?${new URLSearchParams(q)}`;
}

export async function refreshCoopsTides(bbox: OceanBbox, center: GeoPoint, options: RefreshOptions = {}, fetcher: Fetcher = fetch, maxStations = 5): Promise<TideResult | OceanResult> {
  const providerId = "noaa-coops";
  const meta = { attribution: COOPS_SOURCE.attribution, termsUrl: COOPS_SOURCE.termsUrl };
  if (options.network !== true) return failed(providerId, meta, "Network access is opt-in");
  let b: OceanBbox;
  try { b = validateOceanBbox(bbox); } catch (e) { return failed(providerId, meta, safeError(e)); }
  const limit = Math.max(1, Math.min(8, Math.round(maxStations)));
  const key = `${b.west},${b.south},${b.east},${b.north}|${limit}`;
  return throttled(providerId, key, 60_000, meta, async () => {
    const now = Date.now();
    if (!stationList || now - stationList.at > STATION_LIST_TTL) stationList = { at: now, stations: parseCoopsStations(await readJson(COOPS_STATIONS_URL, options, fetcher, STATION_LIST_MAX)) };
    const d2 = (s: CoopsStation) => (s.lat - center.lat) ** 2 + (s.lon - center.lon) ** 2;
    const inside = stationList.stations.filter((s) => s.lon >= b.west && s.lon <= b.east && s.lat >= b.south && s.lat <= b.north).sort((a, z) => d2(a) - d2(z));
    const chosen = inside.slice(0, limit);
    const begin = new Date(now - 6 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
    const readings: TideStationReading[] = [];
    for (const s of chosen) {
      if (options.signal?.aborted) break;
      const datum = s.greatLakes ? "IGLD" : "MLLW";
      const pageUrl = `https://tidesandcurrents.noaa.gov/stationhome.html?id=${s.id}`;
      let waterLevelM: number | null = null, waterLevelTime: string | null = null, quality: string | null = null, error: string | undefined;
      try {
        const wl = await readJson(coopsDataUrl(s.id, "water_level", datum), options, fetcher);
        if (obj(wl) && obj(wl.error)) error = str(wl.error.message, 160) ?? "No data";
        else if (obj(wl) && Array.isArray(wl.data) && obj(wl.data[0])) {
          const row = wl.data[0];
          const v = typeof row.v === "string" && row.v.trim() !== "" ? Number(row.v) : NaN;
          waterLevelM = Number.isFinite(v) ? v : null;
          waterLevelTime = coopsTime(row.t, now) ?? null;
          quality = row.q === "v" ? "verified" : row.q === "p" ? "preliminary" : null;
        }
      } catch (e) { error = safeError(e); }
      const predictions: TidePrediction[] = [];
      if (s.tidal && !s.greatLakes) {
        try {
          const p = await readJson(coopsDataUrl(s.id, "predictions", datum, begin), options, fetcher);
          if (obj(p) && Array.isArray(p.predictions))
            for (const row of p.predictions.slice(0, 12)) {
              if (!obj(row)) continue;
              const t = coopsTime(row.t, now, true), h = typeof row.v === "string" ? Number(row.v) : NaN;
              if (t && Number.isFinite(h) && (row.type === "H" || row.type === "L")) predictions.push({ time: t, heightM: h, type: row.type });
            }
        } catch (e) { error = error ?? `predictions: ${safeError(e)}`; }
      }
      readings.push({ station: s, datum, waterLevelM, waterLevelTime, quality, predictions, error, pageUrl });
    }
    const retrievedAt = new Date(now).toISOString();
    const observations: WorldObservation[] = [];
    for (const r of readings) {
      const stamp = r.waterLevelTime ?? (r.predictions[0]?.time && Date.parse(r.predictions[0].time) <= now ? r.predictions[0].time : null);
      if (!stamp) continue;
      const nextHigh = r.predictions.find((p) => p.type === "H" && Date.parse(p.time) > now), nextLow = r.predictions.find((p) => p.type === "L" && Date.parse(p.time) > now);
      const sourceUrl = r.waterLevelTime ? coopsDataUrl(r.station.id, "water_level", r.datum) : r.pageUrl;
      observations.push({
        id: `coops-${r.station.id}`, layer: OCEAN_LAYER, point: { lat: r.station.lat, lon: r.station.lon }, observedAt: stamp, source: "NOAA CO-OPS",
        label: `Tide station ${r.station.name}${r.station.state ? `, ${r.station.state}` : ""}: ${r.waterLevelM !== null ? `water level ${r.waterLevelM.toFixed(2)} m ${r.datum}` : "no latest water level"}${nextHigh ? ` · next high ${nextHigh.time.slice(11, 16)}Z` : ""}`,
        title: r.station.name, freshness: r.waterLevelTime && now - Date.parse(r.waterLevelTime) <= COOPS_FRESH_MS ? "fresh" : "stale",
        properties: {
          ...provenance({ provider: "NOAA CO-OPS", sourceUrl, retrievedAt, providerTimestamp: stamp, now, attribution: COOPS_SOURCE.attribution, termsUrl: COOPS_SOURCE.termsUrl, disclosure: "Water level is a measured 6-minute value (preliminary unless verified); tide predictions are astronomical and exclude weather effects" }),
          dataKind: r.waterLevelTime ? "measured" : "prediction", station: r.station.id, stationPage: r.pageUrl, datum: r.datum,
          waterLevelM: r.waterLevelM, qualityFlag: r.quality, nextHighTime: nextHigh?.time ?? null, nextHighM: nextHigh?.heightM ?? null,
          nextLowTime: nextLow?.time ?? null, nextLowM: nextLow?.heightM ?? null, stationError: r.error ?? null,
        },
      });
    }
    if (observations.length === 0) {
      return { providerId, observations, stations: readings, retrievedAt, freshness: "failed", status: "failed", error: "No current usable observations returned by NOAA CO-OPS", sourceUrl: COOPS_DATA_URL, truncated: inside.length > chosen.length, keyStatus: "not_required", ...meta } satisfies TideResult;
    }
    const fresh = observations.some((o) => o.freshness === "fresh");
    return { providerId, observations, stations: readings, retrievedAt, freshness: fresh ? "fresh" : "stale", status: fresh ? "live" : "stale", sourceUrl: COOPS_DATA_URL, truncated: inside.length > chosen.length, keyStatus: "not_required", ...meta } satisfies TideResult;
  });
}

export const OCEAN_FEED_INFO = Object.freeze({ marine: MARINE_SOURCE, ndbc: NDBC_SOURCE, coops: COOPS_SOURCE });
export type { Freshness };
