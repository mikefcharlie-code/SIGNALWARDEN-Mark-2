/**
 * Imagery, basemap and terrain providers for the WorldView globe.
 *
 * Everything here is read-only and opt-in: no module import, render or
 * default state performs a network request. Tiles are requested lazily for the
 * visible viewport only (bounded count, bounded bytes, bounded rate) and are
 * kept in a bounded in-memory LRU cache. Keys for keyed providers never reach
 * this module: Esri and Google tiles are requested through the same-origin
 * relay under /api/v1/public-imagery/basemap, which holds the key server-side.
 */
import type { GlobeBounds } from "./worldview-globe-viewport";

export const MAX_TILES_PER_VIEW = 48;
export const MAX_TILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CACHE_ENTRIES = 128;
export const MAX_MERCATOR_LAT = 85.0511287798066;
export const RELAY_BASE = "/api/v1/public-imagery/basemap";
export const RELAY_HEADER = "X-SignalWarden-Basemap";
export const GIBS_ORIGIN = "https://gibs.earthdata.nasa.gov";
export const TERRARIUM_PREFIX = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/";
export const DEFAULT_OSM_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const GIBS_ATTRIBUTION = "NASA EOSDIS GIBS / Worldview";
export const TERRAIN_ATTRIBUTION =
  "Terrain Tiles (AWS Open Data Registry): Mapzen; 3DEP, SRTM and GMTED2010 courtesy of the U.S. Geological Survey; ETOPO1 NOAA; " +
  "EU-DEM produced using Copernicus data and information funded by the European Union; Canada: contains information licensed under the Open Government Licence – Canada; " +
  "© Commonwealth of Australia (Geoscience Australia) 2017; © Kartverket; LINZ Crown copyright; © Environment Agency 2015; INEGI; ArcticDEM (DigitalGlobe imagery, NSF awards 1043681, 1559691, 1542736); " +
  "© offene Daten Österreichs";
export const TERRAIN_TERMS_URL = "https://github.com/tilezen/joerd/blob/master/docs/attribution.md";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

export type TileCoord = Readonly<{ z: number; x: number; y: number }>;
export type ProviderKind = "gibs" | "xyz" | "relay" | "terrain";
export type BasemapProviderId =
  | "gibs-viirs-truecolor"
  | "gibs-modis-terra-truecolor"
  | "gibs-viirs-dnb"
  | "gibs-black-marble"
  | "gibs-modis-lst-day"
  | "osm-standard"
  | "esri-world-imagery"
  | "google-2d-satellite";

export type BasemapProvider = Readonly<{
  id: BasemapProviderId;
  kind: Exclude<ProviderKind, "terrain">;
  label: string;
  category: "true-color" | "night-lights" | "thermal" | "basemap" | "keyed-imagery";
  attribution: string;
  termsUrl: string;
  licenseNote: string;
  maxZoom: number;
  /** GIBS only */
  gibsLayer?: string;
  gibsMatrixSet?: string;
  gibsFormat?: "jpg" | "png";
  /** earliest date offered by this adapter (YYYY-MM-DD) */
  minDate?: string;
  /** fixed composite date (non-daily product) */
  fixedDate?: string;
  /** relay path segment for keyed providers */
  relay?: "esri" | "google";
  envVar?: string;
  concurrency: number;
  perMinute: number;
  coverageNote: string;
}>;

const NASA_TERMS = "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance";
export const BASEMAP_PROVIDERS: Readonly<Record<BasemapProviderId, BasemapProvider>> = Object.freeze({
  "gibs-viirs-truecolor": {
    id: "gibs-viirs-truecolor", kind: "gibs", label: "NASA GIBS · VIIRS SNPP true color (daily)", category: "true-color",
    attribution: GIBS_ATTRIBUTION, termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 9, gibsLayer: "VIIRS_SNPP_CorrectedReflectance_TrueColor", gibsMatrixSet: "GoogleMapsCompatible_Level9", gibsFormat: "jpg",
    minDate: "2015-11-24", concurrency: 4, perMinute: 240,
    coverageNote: "Daily composite of satellite swaths; swath gaps, clouds and partial current-day coverage are normal.",
  },
  "gibs-modis-terra-truecolor": {
    id: "gibs-modis-terra-truecolor", kind: "gibs", label: "NASA GIBS · MODIS Terra true color (daily)", category: "true-color",
    attribution: GIBS_ATTRIBUTION, termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 9, gibsLayer: "MODIS_Terra_CorrectedReflectance_TrueColor", gibsMatrixSet: "GoogleMapsCompatible_Level9", gibsFormat: "jpg",
    minDate: "2000-02-24", concurrency: 4, perMinute: 240,
    coverageNote: "Daily composite of satellite swaths; swath gaps, clouds and partial current-day coverage are normal.",
  },
  "gibs-viirs-dnb": {
    id: "gibs-viirs-dnb", kind: "gibs", label: "NASA GIBS · VIIRS SNPP Day/Night Band radiance (nightly)", category: "night-lights",
    attribution: GIBS_ATTRIBUTION, termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 8, gibsLayer: "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance", gibsMatrixSet: "GoogleMapsCompatible_Level8", gibsFormat: "png",
    minDate: "2020-11-18", concurrency: 4, perMinute: 240,
    coverageNote: "At-sensor night radiance; moonlight, clouds and aurora affect brightness. Not a population or activity measure.",
  },
  "gibs-black-marble": {
    id: "gibs-black-marble", kind: "gibs", label: "NASA GIBS · VIIRS Black Marble night lights (2016 composite)", category: "night-lights",
    attribution: GIBS_ATTRIBUTION, termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 8, gibsLayer: "VIIRS_Black_Marble", gibsMatrixSet: "GoogleMapsCompatible_Level8", gibsFormat: "png",
    fixedDate: "2016-01-01", concurrency: 4, perMinute: 240,
    coverageNote: "Static 2016 annual composite; it is not current.",
  },
  "gibs-modis-lst-day": {
    id: "gibs-modis-lst-day", kind: "gibs", label: "NASA GIBS · MODIS Terra land surface temperature, day (thermal)", category: "thermal",
    attribution: GIBS_ATTRIBUTION, termsUrl: NASA_TERMS, licenseNote: "NASA open data; no copyright restriction; credit requested",
    maxZoom: 7, gibsLayer: "MODIS_Terra_Land_Surface_Temp_Day", gibsMatrixSet: "GoogleMapsCompatible_Level7", gibsFormat: "png",
    minDate: "2000-02-24", concurrency: 4, perMinute: 240,
    coverageNote: "Colour-mapped ~1 km land surface temperature product; cloud-masked gaps. Not a fire detector or sensor-derived FLIR view.",
  },
  "osm-standard": {
    id: "osm-standard", kind: "xyz", label: "OpenStreetMap standard tiles (configurable tile URL)", category: "basemap",
    attribution: OSM_ATTRIBUTION, termsUrl: "https://www.openstreetmap.org/copyright", licenseNote: "ODbL 1.0 data; tile usage policy https://operations.osmfoundation.org/policies/tiles/",
    maxZoom: 19, concurrency: 2, perMinute: 60,
    coverageNote: "Community-maintained map; completeness varies. Visible tiles only, no bulk prefetch.",
  },
  "esri-world-imagery": {
    id: "esri-world-imagery", kind: "relay", label: "Esri World Imagery (keyed, server relay)", category: "keyed-imagery",
    attribution: "Powered by Esri · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    termsUrl: "https://www.esri.com/en-us/legal/terms/full-master-agreement", licenseNote: "Esri/ArcGIS Location Platform terms; key required",
    maxZoom: 19, relay: "esri", envVar: "UCAS_ESRI_API_KEY", concurrency: 4, perMinute: 240,
    coverageNote: "Mosaic of mixed-date imagery; capture dates vary by location and are not per-tile timestamps.",
  },
  "google-2d-satellite": {
    id: "google-2d-satellite", kind: "relay", label: "Google Map Tiles · 2D satellite (keyed, server relay)", category: "keyed-imagery",
    attribution: "Google", termsUrl: "https://cloud.google.com/maps-platform/terms", licenseNote: "Google Maps Platform terms, key and billing",
    maxZoom: 22, relay: "google", envVar: "UCAS_GOOGLE_MAPS_API_KEY", concurrency: 4, perMinute: 240,
    coverageNote: "Mixed-date mosaic; copyright text comes from the Map Tiles viewport API. Photorealistic 3D Tiles are not rendered by this globe.",
  },
});

export const TERRAIN_SOURCE = Object.freeze({
  id: "aws-terrarium" as const,
  label: "AWS Terrain Tiles (Terrarium encoding)",
  attribution: TERRAIN_ATTRIBUTION,
  termsUrl: TERRAIN_TERMS_URL,
  registryUrl: "https://registry.opendata.aws/terrain-tiles/",
  licenseNote: "Per-source licenses listed in the Mapzen/tilezen attribution document",
  maxZoom: 15,
  concurrency: 4,
  perMinute: 240,
  coverageNote: "Bare-earth heights merged from multiple DEMs (static dataset, built 2017-2018); resolution and accuracy vary by region. Not for navigation.",
});

// ---------------------------------------------------------------- tile math
const clampLat = (lat: number) => Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
const validZ = (z: number) => Number.isInteger(z) && z >= 0 && z <= 22;

export function tileKey(t: TileCoord): string { return `${t.z}/${t.x}/${t.y}`; }

/** Fractional Web Mercator tile coordinates for a WGS84 point. */
export function lonLatToTileFraction(lat: number, lon: number, z: number): { x: number; y: number } {
  if (!validZ(z) || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("invalid tile coordinate request");
  const n = 2 ** z;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const r = (clampLat(lat) * Math.PI) / 180;
  const x = ((wrapped + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x: Math.min(n - 1e-9, Math.max(0, x)), y: Math.min(n - 1e-9, Math.max(0, y)) };
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

export function tileBounds(t: TileCoord): GlobeBounds {
  const n = 2 ** t.z;
  return { west: (t.x / n) * 360 - 180, east: ((t.x + 1) / n) * 360 - 180, north: tileYToLat(t.y, t.z), south: tileYToLat(t.y + 1, t.z) };
}

/** Tile zoom for the globe's 0.65-1.8 camera zoom, capped by the provider. */
export function chooseTileZoom(globeZoom: number, providerMax: number): number {
  const z = !Number.isFinite(globeZoom) ? 2 : globeZoom >= 1.5 ? 4 : globeZoom >= 1.05 ? 3 : 2;
  return Math.max(0, Math.min(providerMax, z));
}

/**
 * Visible tiles for one or two viewport rectangles, ordered nearest the view
 * centre first and capped. Never returns tiles outside the viewport (no
 * prefetch ring), so a pan only requests what becomes visible.
 */
export function tilesForBounds(
  bounds: ReadonlyArray<GlobeBounds>,
  z: number,
  center: Readonly<{ lat: number; lon: number }>,
  maxTiles = MAX_TILES_PER_VIEW,
): TileCoord[] {
  if (!validZ(z) || z > 8 || !Array.isArray(bounds) || !Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 256) return [];
  const n = 2 ** z;
  const seen = new Map<string, TileCoord>();
  for (const b of bounds.slice(0, 2)) {
    if (![b.west, b.east, b.south, b.north].every(Number.isFinite) || b.west >= b.east || b.south >= b.north) continue;
    const nw = lonLatToTileFraction(Math.min(b.north, MAX_MERCATOR_LAT), b.west, z);
    const se = lonLatToTileFraction(Math.max(b.south, -MAX_MERCATOR_LAT), Math.min(b.east, 180 - 1e-9), z);
    const x0 = Math.floor(nw.x), x1 = Math.floor(se.x), y0 = Math.floor(nw.y), y1 = Math.floor(se.y);
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) seen.set(`${z}/${x}/${y}`, { z, x, y });
  }
  const c = lonLatToTileFraction(center.lat, center.lon, z);
  const dist = (t: TileCoord) => {
    let dx = Math.abs(t.x + 0.5 - c.x);
    dx = Math.min(dx, n - dx);
    return dx * dx + (t.y + 0.5 - c.y) ** 2;
  };
  return [...seen.values()].sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x).slice(0, maxTiles);
}

// ---------------------------------------------------------------- dates
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function utcDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
/** Yesterday (UTC): today's daily composite is usually still filling in. */
export function defaultGibsDate(now = Date.now()): string { return utcDate(now - 86_400_000); }

export function validateGibsDate(provider: BasemapProvider, date: string, now = Date.now()): string {
  if (provider.fixedDate) return provider.fixedDate;
  if (typeof date !== "string" || !DATE_RE.test(date) || utcDate(Date.parse(`${date}T00:00:00Z`)) !== date)
    throw new Error("GIBS date must be a real YYYY-MM-DD date");
  if (provider.minDate && date < provider.minDate) throw new Error(`GIBS date must be on or after ${provider.minDate} for this layer`);
  if (date > utcDate(now)) throw new Error("GIBS date cannot be in the future");
  return date;
}

// ---------------------------------------------------------------- URLs
const assertTile = (t: TileCoord, maxZoom: number) => {
  if (!validZ(t.z) || t.z > maxZoom || !Number.isInteger(t.x) || !Number.isInteger(t.y) || t.x < 0 || t.y < 0 || t.x >= 2 ** t.z || t.y >= 2 ** t.z)
    throw new Error("tile coordinate out of range");
};

export function gibsTileUrl(provider: BasemapProvider, date: string, t: TileCoord, now = Date.now()): string {
  if (provider.kind !== "gibs" || !provider.gibsLayer || !provider.gibsMatrixSet || !provider.gibsFormat) throw new Error("not a GIBS provider");
  assertTile(t, provider.maxZoom);
  const day = validateGibsDate(provider, date, now);
  return `${GIBS_ORIGIN}/wmts/epsg3857/best/${provider.gibsLayer}/default/${day}/${provider.gibsMatrixSet}/${t.z}/${t.y}/${t.x}.${provider.gibsFormat}`;
}

export function terrainTileUrl(t: TileCoord): string {
  assertTile(t, TERRAIN_SOURCE.maxZoom);
  return `${TERRARIUM_PREFIX}${t.z}/${t.x}/${t.y}.png`;
}

export function relayTileUrl(provider: BasemapProvider, t: TileCoord): string {
  if (provider.kind !== "relay" || !provider.relay) throw new Error("not a relay provider");
  assertTile(t, Math.min(provider.maxZoom, 8));
  return `${RELAY_BASE}/${provider.relay}/tile?z=${t.z}&x=${t.x}&y=${t.y}`;
}

const SECRETISH = /(key|token|secret|signature|session|auth|password|access)/i;
/**
 * Validates a user-supplied XYZ tile template (OSM by default). HTTPS only,
 * standard port, no credentials, no query string or fragment (so no API keys
 * can ride in a scene or log), and exactly one each of {z}, {x}, {y}.
 */
export function validateTileTemplate(template: string): string {
  if (typeof template !== "string" || template.length < 12 || template.length > 300) throw new Error("Tile URL template must be 12-300 characters");
  const text = template.trim();
  for (const token of ["{z}", "{x}", "{y}"]) if (text.split(token).length !== 2) throw new Error("Tile URL template needs exactly one {z}, {x} and {y}");
  if (/[{}]/.test(text.replace(/\{[zxy]\}/g, ""))) throw new Error("Only {z}, {x} and {y} placeholders are supported");
  let url: URL;
  try { url = new URL(text.replace(/\{([zxy])\}/g, "0")); } catch { throw new Error("Tile URL template is not a valid URL"); }
  if (url.protocol !== "https:") throw new Error("Tile URL template must use HTTPS");
  if (url.username || url.password) throw new Error("Tile URL template must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("Tile URL template must use the standard HTTPS port");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) throw new Error("Tile URL template must not contain a query string or fragment (keys belong server-side)");
  if (SECRETISH.test(url.pathname)) throw new Error("Tile URL template looks like it embeds a credential");
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".")) throw new Error("Tile URL template host is invalid");
  return text;
}

export function xyzTileUrl(template: string, provider: BasemapProvider, t: TileCoord): string {
  assertTile(t, provider.maxZoom);
  return validateTileTemplate(template).replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y));
}

export function isOsmFoundationTemplate(template: string): boolean {
  try { return new URL(template.replace(/\{([zxy])\}/g, "0")).hostname === "tile.openstreetmap.org"; } catch { return false; }
}

// ---------------------------------------------------------------- terrain
/** Terrarium: metres = (R * 256 + G + B / 256) - 32768. */
export function terrariumElevation(r: number, g: number, b: number): number { return r * 256 + g + b / 256 - 32768; }

export function decodeTerrarium(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 512 || rgba.length < width * height * 4)
    throw new Error("invalid Terrarium tile dimensions");
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = terrariumElevation(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  return out;
}

export function sampleGrid(grid: ArrayLike<number>, width: number, height: number, fx: number, fy: number): number {
  const x = Math.max(0, Math.min(width - 1, fx)), y = Math.max(0, Math.min(height - 1, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const top = grid[y0 * width + x0] * (1 - tx) + grid[y0 * width + x1] * tx;
  const bottom = grid[y1 * width + x0] * (1 - tx) + grid[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function metersPerPixel(lat: number, z: number, tileSize = 256): number {
  return (Math.cos((clampLat(lat) * Math.PI) / 180) * 2 * Math.PI * 6378137) / (tileSize * 2 ** z);
}

/** Pixel inside the terrain tile that contains (lat, lon) at zoom z. */
export function elevationPixel(lat: number, lon: number, z: number, size = 256) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > MAX_MERCATOR_LAT || Math.abs(lon) > 180) throw new Error("Point must be a finite latitude within ±85.05° and longitude within ±180°");
  const f = lonLatToTileFraction(lat, lon, z);
  const tile = { z, x: Math.floor(f.x), y: Math.floor(f.y) };
  return { tile, px: (f.x - tile.x) * size - 0.5, py: (f.y - tile.y) * size - 0.5 };
}

/**
 * Grey hillshade (RGBA) from an elevation grid. Alpha encodes shade strength
 * so it can overlay imagery; flat terrain is nearly transparent.
 */
export function hillshade(elev: ArrayLike<number>, width: number, height: number, cellMeters: number, exaggeration = 1, azimuth = 315, altitude = 45): Uint8ClampedArray {
  if (!(cellMeters > 0) || !Number.isFinite(exaggeration) || exaggeration <= 0) throw new Error("invalid hillshade parameters");
  const out = new Uint8ClampedArray(width * height * 4);
  const zen = ((90 - altitude) * Math.PI) / 180, az = ((360 - azimuth + 90) * Math.PI) / 180;
  const at = (x: number, y: number) => Math.max(0, elev[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dzdx = ((at(x + 1, y) - at(x - 1, y)) / (2 * cellMeters)) * exaggeration;
      const dzdy = ((at(x, y + 1) - at(x, y - 1)) / (2 * cellMeters)) * exaggeration;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade = Math.max(0, Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect));
      const flat = Math.cos(zen);
      const i = (y * width + x) * 4;
      const v = Math.round(255 * shade);
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = Math.min(255, Math.round(Math.abs(shade - flat) * 600));
    }
  return out;
}

// ---------------------------------------------------------------- freshness
export type TileFreshness = "recent" | "stale" | "historical" | "static-dataset" | "unknown";
export function imageryFreshness(provider: BasemapProvider, providerDate: string | undefined, now = Date.now()): { freshness: TileFreshness; ageMs: number | null } {
  if (provider.fixedDate) return { freshness: "historical", ageMs: now - Date.parse(`${provider.fixedDate}T00:00:00Z`) };
  if (provider.kind !== "gibs" || !providerDate) return { freshness: "unknown", ageMs: null };
  const t = Date.parse(providerDate.length === 10 ? `${providerDate}T00:00:00Z` : providerDate);
  if (!Number.isFinite(t) || t > now + 86_400_000) return { freshness: "unknown", ageMs: null };
  const ageMs = Math.max(0, now - t);
  return { freshness: ageMs <= 3 * 86_400_000 ? "recent" : ageMs <= 30 * 86_400_000 ? "stale" : "historical", ageMs };
}

export function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "age unknown";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 172_800_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}

// ---------------------------------------------------------------- cache
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(readonly maxEntries = DEFAULT_CACHE_ENTRIES, private onEvict?: (key: string, value: V) => void) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) throw new Error("cache size must be 1-1024");
  }
  get size() { return this.map.size; }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  has(key: string) { return this.map.has(key); }
  set(key: string, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const [oldKey, oldValue] = this.map.entries().next().value as [string, V];
      this.map.delete(oldKey);
      this.onEvict?.(oldKey, oldValue);
    }
  }
  clear() { for (const [k, v] of this.map) this.onEvict?.(k, v); this.map.clear(); }
}

// ---------------------------------------------------------------- loader
export type TileSource = Readonly<{
  sourceId: string;
  provider: string;
  attribution: string;
  termsUrl: string;
  licenseNote: string;
  urlFor: (t: TileCoord) => string;
  /** Provider date requested (GIBS) used when no layer-time-actual header. */
  requestedDate?: string;
  freshnessFor?: (providerTime: string | undefined, now: number) => { freshness: TileFreshness; ageMs: number | null };
  concurrency: number;
  perMinute: number;
  relay?: boolean;
  /** OSM tile policy wants a valid Referer; other providers get no referrer. */
  sendReferrer?: boolean;
  /** Origin of a validated user-configured XYZ template (the only extra host allowed). */
  allowOrigin?: string;
  /** Keyed Esri/Google tiles are displayed but never retained in the client LRU or browser HTTP cache. */
  cache?: RequestCache;
}>;

export type TileRecord<T> = Readonly<{
  key: string;
  tile: TileCoord;
  data: T;
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  providerTime?: string;
  freshness: TileFreshness;
  ageMs: number | null;
  attribution: string;
  termsUrl: string;
  licenseNote: string;
  live: boolean;
}>;

export type LoadResult<T> = {
  loaded: TileRecord<T>[];
  failed: { key: string; error: string }[];
  throttled: number;
  fromCache: number;
  fetched: number;
};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type LoaderOptions<T> = {
  network: boolean;
  fetcher?: Fetcher;
  decode: (blob: Blob, contentType: string) => Promise<T>;
  cacheEntries?: number;
  now?: () => number;
  timeoutMs?: number;
  onEvict?: (key: string, value: TileRecord<T>) => void;
};

const allowedTileUrl = (url: string, allowOrigin?: string): boolean => {
  if (url.startsWith(`${RELAY_BASE}/`)) return /^\/api\/v1\/public-imagery\/basemap\/(esri|google)\/tile\?z=\d{1,2}&x=\d{1,6}&y=\d{1,6}$/.test(url);
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443")) return false;
  if (parsed.origin === GIBS_ORIGIN) return parsed.pathname.startsWith("/wmts/epsg3857/best/") && !parsed.search;
  if (url.startsWith(TERRARIUM_PREFIX)) return /^\/elevation-tiles-prod\/terrarium\/\d{1,2}\/\d{1,6}\/\d{1,6}\.png$/.test(parsed.pathname) && !parsed.search;
  // Any other host is allowed only when it is the origin of a validated, user-configured template.
  return !!allowOrigin && parsed.origin === allowOrigin && !parsed.search && !url.startsWith("https://s3.amazonaws.com/");
};

export async function fetchTileBytes(url: string, opts: { network: boolean; fetcher?: Fetcher; signal?: AbortSignal; timeoutMs?: number; relay?: boolean; sendReferrer?: boolean; allowOrigin?: string; cache?: RequestCache }): Promise<{ blob: Blob; contentType: string; layerTime?: string; lastModified?: string }> {
  if (opts.network !== true) throw new Error("Network access is opt-in; enable provider requests first");
  if (!allowedTileUrl(url, opts.allowOrigin)) throw new Error("Tile URL is not on the provider allowlist");
  const fetcher = opts.fetcher ?? ((u: string, i: RequestInit) => fetch(u, i));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20_000, opts.timeoutMs ?? 10_000)));
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: opts.cache,
      // OSM's tile policy asks for an identifying Referer; browsers send their own User-Agent.
      referrerPolicy: opts.sendReferrer ? "strict-origin-when-cross-origin" : "no-referrer",
      mode: opts.relay ? "same-origin" : "cors",
      signal,
      headers: opts.relay ? { Accept: "image/*", [RELAY_HEADER]: "enabled" } : { Accept: "image/*" },
    });
    if (!response.ok) {
      let code = "";
      if (opts.relay) { try { const body = await response.json(); code = typeof body?.error?.code === "string" ? body.error.code : ""; } catch { /* ignore */ } }
      throw new Error(code ? `HTTP ${response.status} (${code})` : `HTTP ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error("Provider returned a non-image tile");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_TILE_BYTES || !response.body) throw new Error("Tile exceeds 2 MiB or has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_TILE_BYTES) { await reader.cancel(); throw new Error("Tile exceeds 2 MiB"); }
      chunks.push(part.value);
    }
    const layerTime = response.headers.get("layer-time-actual") ?? undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;
    return { blob: new Blob(chunks as BlobPart[], { type: contentType }), contentType, layerTime, lastModified };
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded, rate-limited, cached tile loader. No requests unless network is true. */
export class TileLoader<T> {
  readonly cache: LruCache<TileRecord<T>>;
  private stamps: number[] = [];
  constructor(private opts: LoaderOptions<T>) {
    this.cache = new LruCache<TileRecord<T>>(opts.cacheEntries ?? DEFAULT_CACHE_ENTRIES, opts.onEvict);
  }
  private now() { return this.opts.now?.() ?? Date.now(); }
  private allow(perMinute: number): boolean {
    const now = this.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= perMinute) return false;
    this.stamps.push(now);
    return true;
  }
  async load(source: TileSource, tiles: ReadonlyArray<TileCoord>, signal?: AbortSignal): Promise<LoadResult<T>> {
    const result: LoadResult<T> = { loaded: [], failed: [], throttled: 0, fromCache: 0, fetched: 0 };
    const wanted = tiles.slice(0, MAX_TILES_PER_VIEW);
    const todo: TileCoord[] = [];
    const retain = source.cache !== "no-store";
    for (const t of wanted) {
      const cached = retain ? this.cache.get(`${source.sourceId}|${tileKey(t)}`) : undefined;
      if (cached) { result.loaded.push(cached); result.fromCache++; }
      else todo.push(t);
    }
    if (todo.length && this.opts.network !== true) {
      for (const t of todo) result.failed.push({ key: tileKey(t), error: "Network access is opt-in" });
      return result;
    }
    let index = 0;
    const worker = async () => {
      while (index < todo.length) {
        const t = todo[index++];
        if (signal?.aborted) return;
        if (!this.allow(Math.max(1, Math.min(600, source.perMinute)))) { result.throttled++; continue; }
        const url = source.urlFor(t);
        try {
          const bytes = await fetchTileBytes(url, { network: this.opts.network, fetcher: this.opts.fetcher, signal, timeoutMs: this.opts.timeoutMs, relay: source.relay, sendReferrer: source.sendReferrer, allowOrigin: source.allowOrigin, cache: source.cache });
          const data = await this.opts.decode(bytes.blob, bytes.contentType);
          const now = this.now();
          const providerTime = bytes.layerTime ?? source.requestedDate ?? bytes.lastModified;
          const fresh = source.freshnessFor?.(providerTime, now) ?? { freshness: "unknown" as TileFreshness, ageMs: null };
          const record: TileRecord<T> = {
            key: tileKey(t), tile: t, data, provider: source.provider, sourceUrl: url, retrievedAt: new Date(now).toISOString(),
            providerTime, freshness: fresh.freshness, ageMs: fresh.ageMs, attribution: source.attribution, termsUrl: source.termsUrl,
            licenseNote: source.licenseNote, live: fresh.freshness === "recent",
          };
          if (retain) this.cache.set(`${source.sourceId}|${record.key}`, record);
          result.loaded.push(record);
          result.fetched++;
        } catch (error) {
          if (signal?.aborted) return;
          result.failed.push({ key: tileKey(t), error: error instanceof Error ? error.message : "Tile request failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(6, source.concurrency, todo.length || 1)) }, worker));
    return result;
  }
}

/** Source descriptor for a basemap/imagery provider. */
export function imagerySource(providerId: BasemapProviderId, opts: { date?: string; template?: string; now?: number } = {}): TileSource {
  const provider = BASEMAP_PROVIDERS[providerId];
  if (!provider) throw new Error("unknown imagery provider");
  const now = opts.now ?? Date.now();
  if (provider.kind === "gibs") {
    const date = validateGibsDate(provider, opts.date ?? defaultGibsDate(now), now);
    return {
      sourceId: `${provider.id}@${date}`, provider: provider.label, attribution: provider.attribution, termsUrl: provider.termsUrl,
      licenseNote: provider.licenseNote, requestedDate: date, urlFor: (t) => gibsTileUrl(provider, date, t, now),
      freshnessFor: (time, at) => imageryFreshness(provider, time, at), concurrency: provider.concurrency, perMinute: provider.perMinute,
    };
  }
  if (provider.kind === "xyz") {
    const template = validateTileTemplate(opts.template ?? DEFAULT_OSM_TEMPLATE);
    return {
      sourceId: `${provider.id}@${template}`, provider: provider.label, attribution: provider.attribution, termsUrl: provider.termsUrl,
      licenseNote: provider.licenseNote, urlFor: (t) => xyzTileUrl(template, provider, t), concurrency: provider.concurrency,
      perMinute: provider.perMinute, sendReferrer: true, allowOrigin: new URL(template.replace(/\{([zxy])\}/g, "0")).origin,
    };
  }
  return {
    sourceId: provider.id, provider: provider.label, attribution: provider.attribution, termsUrl: provider.termsUrl,
    licenseNote: provider.licenseNote, urlFor: (t) => relayTileUrl(provider, t), concurrency: provider.concurrency,
    perMinute: provider.perMinute, relay: true, cache: "no-store",
  };
}

export function terrainSource(): TileSource {
  return {
    sourceId: TERRAIN_SOURCE.id, provider: TERRAIN_SOURCE.label, attribution: TERRAIN_SOURCE.attribution, termsUrl: TERRAIN_SOURCE.termsUrl,
    licenseNote: TERRAIN_SOURCE.licenseNote, urlFor: terrainTileUrl, concurrency: TERRAIN_SOURCE.concurrency, perMinute: TERRAIN_SOURCE.perMinute,
    freshnessFor: () => ({ freshness: "static-dataset", ageMs: null }),
  };
}

// ---------------------------------------------------------------- elevation readout
export type ElevationReading = Readonly<{
  lat: number;
  lon: number;
  meters: number;
  zoom: number;
  approxCellMeters: number;
  provider: string;
  sourceUrl: string;
  retrievedAt: string;
  providerTime?: string;
  freshness: TileFreshness;
  attribution: string;
  termsUrl: string;
  licenseNote: string;
  note: string;
  live: boolean;
}>;

export type ElevationGrid = { width: number; height: number; heights: Float32Array };

export async function readElevation(
  lat: number,
  lon: number,
  opts: { network: boolean; fetcher?: Fetcher; decodePixels: (blob: Blob) => Promise<{ width: number; height: number; rgba: ArrayLike<number> }>; signal?: AbortSignal; now?: () => number; zoom?: number },
): Promise<ElevationReading> {
  const z = opts.zoom ?? 12;
  if (!Number.isInteger(z) || z < 0 || z > 14) throw new Error("elevation zoom must be 0-14");
  const { tile, px, py } = elevationPixel(lat, lon, z);
  const url = terrainTileUrl(tile);
  const bytes = await fetchTileBytes(url, { network: opts.network, fetcher: opts.fetcher, signal: opts.signal });
  if (bytes.contentType !== "image/png") throw new Error("Terrain tile was not a PNG");
  const pixels = await opts.decodePixels(bytes.blob);
  const heights = decodeTerrarium(pixels.rgba, pixels.width, pixels.height);
  const scale = pixels.width / 256;
  const meters = sampleGrid(heights, pixels.width, pixels.height, (px + 0.5) * scale - 0.5, (py + 0.5) * scale - 0.5);
  const now = opts.now?.() ?? Date.now();
  return {
    lat, lon, meters: Math.round(meters * 10) / 10, zoom: z, approxCellMeters: Math.round(metersPerPixel(lat, z)),
    provider: TERRAIN_SOURCE.label, sourceUrl: url, retrievedAt: new Date(now).toISOString(), providerTime: bytes.lastModified,
    freshness: "static-dataset", attribution: TERRAIN_SOURCE.attribution, termsUrl: TERRAIN_SOURCE.termsUrl, licenseNote: TERRAIN_SOURCE.licenseNote,
    note: "Bare-earth DEM height above mean sea level (approx.), interpolated from a ~" + Math.round(metersPerPixel(lat, z)) + " m grid; not surveyed, not for navigation or flight altitude.",
    live: false,
  };
}

// ---------------------------------------------------------------- keyed relay status
export type RelayProviderStatus = Readonly<{ status: "configured" | "not_configured" | "disabled" | "not_implemented" | "unreachable" | "unknown"; detail: string; envVar?: string; attribution?: string }>;
export type RelayStatus = Readonly<{ relayEnabled: boolean; providers: Readonly<Record<string, RelayProviderStatus>>; checkedAt: string }>;

const STATUS_VALUES = new Set(["configured", "not_configured", "disabled", "not_implemented", "unreachable", "unknown"]);
export async function fetchRelayStatus(opts: { network: boolean; fetcher?: Fetcher; now?: () => number; signal?: AbortSignal }): Promise<RelayStatus> {
  const checkedAt = new Date(opts.now?.() ?? Date.now()).toISOString();
  const unreachable = (detail: string): RelayStatus => ({
    relayEnabled: false, checkedAt,
    providers: {
      esri: { status: "unreachable", detail, envVar: "UCAS_ESRI_API_KEY" },
      google2d: { status: "unreachable", detail, envVar: "UCAS_GOOGLE_MAPS_API_KEY" },
      google3d: { status: "not_implemented", detail: "Photorealistic 3D Tiles are not rendered by the Three.js globe." },
    },
  });
  if (opts.network !== true) throw new Error("Network access is opt-in; enable provider requests first");
  const fetcher = opts.fetcher ?? ((u: string, i: RequestInit) => fetch(u, i));
  let response: Response;
  try {
    response = await fetcher(`${RELAY_BASE}/status`, { method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", mode: "same-origin", signal: opts.signal, cache: "no-store", headers: { Accept: "application/json", [RELAY_HEADER]: "enabled" } });
  } catch {
    return unreachable("Local management API relay could not be reached.");
  }
  if (response.status === 404) return unreachable("Basemap relay route is not available (management API not running or route not proxied).");
  if (!response.ok) return unreachable(`Relay status returned HTTP ${response.status}.`);
  let body: any;
  try { body = await response.json(); } catch { return unreachable("Relay status was not JSON."); }
  const providers: Record<string, RelayProviderStatus> = {};
  for (const name of ["esri", "google2d", "google3d"]) {
    const p = body?.providers?.[name];
    const status = typeof p?.status === "string" && STATUS_VALUES.has(p.status) ? p.status : "unknown";
    providers[name] = {
      status, detail: typeof p?.detail === "string" ? p.detail.slice(0, 300) : "",
      ...(typeof p?.envVar === "string" ? { envVar: p.envVar.slice(0, 64) } : {}),
      ...(typeof p?.attribution === "string" ? { attribution: p.attribution.slice(0, 300) } : {}),
    };
  }
  return { relayEnabled: body?.relayEnabled === true, providers, checkedAt };
}

export async function fetchGoogleCopyright(bounds: GlobeBounds, zoom: number, opts: { network: boolean; fetcher?: Fetcher; signal?: AbortSignal }): Promise<string> {
  if (opts.network !== true) throw new Error("Network access is opt-in");
  const f = (n: number) => n.toFixed(4);
  if (![bounds.west, bounds.east, bounds.south, bounds.north].every(Number.isFinite) || !Number.isInteger(zoom) || zoom < 0 || zoom > 8) throw new Error("invalid viewport");
  const fetcher = opts.fetcher ?? ((u: string, i: RequestInit) => fetch(u, i));
  const response = await fetcher(`${RELAY_BASE}/google/attribution?zoom=${zoom}&north=${f(bounds.north)}&south=${f(bounds.south)}&east=${f(bounds.east)}&west=${f(bounds.west)}`, { method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", mode: "same-origin", signal: opts.signal, cache: "no-store", headers: { Accept: "application/json", [RELAY_HEADER]: "enabled" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: any = await response.json();
  return typeof body?.copyright === "string" ? body.copyright.slice(0, 300) : "";
}

// ---------------------------------------------------------------- globe hand-off
export type GlobeBasemapTile = Readonly<{
  key: string;
  tile: TileCoord;
  /** ImageBitmap / canvas in the browser; opaque to this module. */
  image?: unknown;
  /** Hillshade RGBA overlay (256x256) */
  shade?: Uint8ClampedArray;
  /** Elevation grid for relief displacement */
  heights?: ElevationGrid;
}>;

export type GlobeBasemap = Readonly<{
  /** Changes whenever provider/date/template changes, so the globe drops old textures. */
  sourceId: string;
  tiles: ReadonlyArray<GlobeBasemapTile>;
  reliefExaggeration: number;
  credits: ReadonlyArray<Readonly<{ provider: string; text: string; termsUrl: string }>>;
  note?: string;
}>;
