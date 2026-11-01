const ASF_API_ORIGIN = "https://api.daac.asf.alaska.edu";
const ASF_BROWSE_ORIGIN = "https://datapool.asf.alaska.edu";
const ASF_SEARCH_PATH = "/services/search/param";
const MAX_RESULTS = 50;
const MAX_BROWSE_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 32_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

export type SarQuery = Readonly<{
  west: number;
  south: number;
  east: number;
  north: number;
  start: string;
  end: string;
}>;
export type SarScene = Readonly<{
  id: string;
  acquisitionStart: string;
  acquisitionEnd?: string;
  processingTime?: string;
  publicationTime?: string;
  platform?: string;
  sensor?: string;
  mode?: string;
  polarization?: string;
  absoluteOrbit?: number;
  relativeOrbit?: number;
  direction?: string;
  productType: string;
  footprint: ReadonlyArray<readonly [number, number]>;
  pixelSpacing?: string;
  resolution?: string;
  browseUrl?: string;
  sourceUrl?: string;
  attribution: string;
  license: string;
}>;
export type SarSearchResult = Readonly<{
  scenes: SarScene[];
  fetchedAt: string;
  queryUrl: string;
  skipped: number;
  possiblyTruncated: boolean;
}>;
export type SarFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const SAR_SOURCE = Object.freeze({
  provider: "ASF DAAC Search API",
  endpoint: `${ASF_API_ORIGIN}${ASF_SEARCH_PATH}`,
  dataset: "Sentinel-1 GRD_HD",
  attribution: "Copernicus Sentinel data; retrieved from ASF DAAC",
  license: "Copernicus Sentinel Data Legal Notice: free, full and open access; source attribution required; no warranty",
  docsUrl: "https://docs.asf.alaska.edu/api/basics/",
  termsUrl: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function validateQuery(query: SarQuery): void {
  if (!query || !finite(query.west) || !finite(query.south) || !finite(query.east) || !finite(query.north) ||
      query.west < -180 || query.east > 180 || query.south < -90 || query.north > 90 ||
      query.west >= query.east || query.south >= query.north) throw new Error("Invalid SAR bounding box");
  if (typeof query.start !== "string" || typeof query.end !== "string" || !query.start || !query.end ||
      !Number.isFinite(Date.parse(query.start)) || !Number.isFinite(Date.parse(query.end)) ||
      Date.parse(query.start) > Date.parse(query.end)) throw new Error("Invalid SAR date range");
}
function asIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
function safeBrowse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== ASF_BROWSE_ORIGIN || url.username || url.password ||
        !/^\/BROWSE\/(?:SA|SB|SC|SD)\/[A-Za-z0-9_]+\.jpg$/i.test(url.pathname) || url.search || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}
function footprint(value: unknown): ReadonlyArray<readonly [number, number]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || !Array.isArray(geometry.coordinates[0])) return undefined;
  const ring = geometry.coordinates[0];
  if (ring.length < 4 || ring.length > 200) return undefined;
  const points: Array<readonly [number, number]> = [];
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2 || !finite(point[0]) || !finite(point[1]) || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) return undefined;
    points.push([point[0], point[1]]);
  }
  return points;
}
function metadataMeasure(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 200 && value.trim()) return value;
  if (finite(value)) return `${value} (units not provided)`;
  return undefined;
}
function sceneFromFeature(feature: unknown): SarScene | undefined {
  if (!feature || typeof feature !== "object") return undefined;
  const f = feature as { geometry?: unknown; properties?: unknown };
  if (!f.properties || typeof f.properties !== "object") return undefined;
  const p = f.properties as Record<string, unknown>;
  const id = typeof p.fileID === "string" ? p.fileID : typeof p.sceneName === "string" ? p.sceneName : undefined;
  const acquisitionStart = asIso(p.startTime);
  const ring = footprint(f.geometry);
  if (!id || id.length > 240 || !acquisitionStart || !ring || p.processingLevel !== "GRD_HD") return undefined;
  if (Object.values(p).some(value => typeof value === "string" && value.length > 4096)) return undefined;
  const sourceUrl = typeof p.url === "string" && /^https:\/\/datapool\.asf\.alaska\.edu\//.test(p.url) ? p.url : undefined;
  return {
    id, acquisitionStart, acquisitionEnd: asIso(p.stopTime), processingTime: asIso(p.processingDate), publicationTime: asIso(p.publicationDate),
    platform: typeof p.platform === "string" ? p.platform : undefined, sensor: typeof p.sensor === "string" ? p.sensor : undefined,
    mode: typeof p.beamModeType === "string" ? p.beamModeType : undefined, polarization: typeof p.polarization === "string" ? p.polarization : undefined,
    absoluteOrbit: finite(p.orbit) ? p.orbit : undefined, relativeOrbit: finite(p.pathNumber) ? p.pathNumber : undefined,
    direction: typeof p.flightDirection === "string" ? p.flightDirection : undefined, productType: p.processingLevel,
    footprint: ring, browseUrl: safeBrowse(Array.isArray(p.browse) ? p.browse[0] : undefined), sourceUrl,
    resolution: metadataMeasure(p.resolution), pixelSpacing: metadataMeasure(p.pixelSpacing),
    attribution: `Contains modified Copernicus Sentinel data ${acquisitionStart.slice(0, 4)}; provider browse image and metadata retrieved from ASF DAAC`, license: SAR_SOURCE.license,
  };
}
function mergedSignal(signal?: AbortSignal): { signal: AbortSignal; timer: ReturnType<typeof setTimeout> } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, timer };
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) { await response.body?.cancel(); throw new Error(`ASF response exceeds ${limit} byte limit`); }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`ASF response exceeds ${limit} byte limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error(`ASF response exceeds ${limit} byte limit`); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function validImageDimensions(bytes: Uint8Array, type: string): boolean {
  let width = 0, height = 0;
  if (type === "image/png" && bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const view = new DataView(bytes.buffer, bytes.byteOffset); width = view.getUint32(16); height = view.getUint32(20);
  } else if (type === "image/jpeg" && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let i = 2;
    while (i + 9 < bytes.length) { if (bytes[i] !== 255) { i++; continue; } const marker = bytes[i + 1]; const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) { height = (bytes[i + 5] << 8) | bytes[i + 6]; width = (bytes[i + 7] << 8) | bytes[i + 8]; break; } if (len < 2) break; i += 2 + len; }
  }
  return width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && width * height <= MAX_IMAGE_PIXELS;
}

export async function searchSar(query: SarQuery, signal?: AbortSignal, fetcher: SarFetcher = fetch): Promise<SarSearchResult> {
  validateQuery(query);
  const params = new URLSearchParams({ platform: "Sentinel-1", processingLevel: "GRD_HD", bbox: `${query.west},${query.south},${query.east},${query.north}`, start: query.start, end: query.end, output: "geojson", maxresults: String(MAX_RESULTS) });
  const queryUrl = `${ASF_API_ORIGIN}${ASF_SEARCH_PATH}?${params}`;
  const request = mergedSignal(signal);
  try {
    const response = await fetcher(queryUrl, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: request.signal, headers: { Accept: "application/geo+json, application/json" } });
    if (!response.ok) throw new Error(`ASF SAR search failed (HTTP ${response.status})`);
    const catalogBytes = await readLimited(response, MAX_CATALOG_BYTES);
    let payload: unknown; try { payload = JSON.parse(new TextDecoder().decode(catalogBytes)); } catch { throw new Error("ASF SAR search returned malformed JSON"); }
    if (!payload || typeof payload !== "object" || (payload as { type?: unknown }).type !== "FeatureCollection" || !Array.isArray((payload as { features?: unknown }).features)) throw new Error("ASF SAR search returned an invalid FeatureCollection");
    const features = payload && typeof payload === "object" && Array.isArray((payload as { features?: unknown }).features) ? (payload as { features: unknown[] }).features : [];
    if (features.length > MAX_RESULTS) throw new Error("ASF SAR catalog exceeded the 50-result bound");
    const parsed = features.map(sceneFromFeature).filter((scene): scene is SarScene => scene !== undefined);
    parsed.sort((a, b) => Date.parse(b.acquisitionStart) - Date.parse(a.acquisitionStart));
    return { scenes: parsed, fetchedAt: new Date().toISOString(), queryUrl, skipped: features.length - parsed.length, possiblyTruncated: features.length >= MAX_RESULTS };
  } finally { clearTimeout(request.timer); }
}

export async function fetchSarBrowse(url: string, signal?: AbortSignal, fetcher: SarFetcher = fetch): Promise<Blob> {
  const validated = safeBrowse(url);
  if (!validated) throw new Error("Browse URL is not an allowlisted ASF JPEG URL");
  const request = mergedSignal(signal);
  try {
    // Fixed same-origin relay resolves ASF delivery redirects without browser CORS bypasses.
    // Only the explicitly selected public product identifier is sent; never a caller URL.
    const product = new URL(validated).pathname.split("/").at(-1)!.slice(0, -4);
    const relay = `/api/v1/public-imagery/sar/browse?${new URLSearchParams({ product })}`;
    const response = await fetcher(relay, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: request.signal, headers: { Accept: "image/jpeg,image/png", "X-SignalWarden-SAR": "enabled" } });
    if (!response.ok) throw new Error([404, 503].includes(response.status) ? `SAR preview relay unavailable or disabled (HTTP ${response.status}). Configure UCAS_PUBLIC_SAR_ENABLED=1 on the local API and route /api/v1/public-imagery to it; no credentials required` : `ASF browse relay failed (HTTP ${response.status})`);
    const type = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    if (type !== "image/jpeg" && type !== "image/png") { await response.body?.cancel(); throw new Error("ASF browse response is not an image"); }
    const length = response.headers.get("content-length");
    if (length && Number(length) > MAX_BROWSE_BYTES) { await response.body?.cancel(); throw new Error("ASF browse image exceeds 8 MiB limit"); }
    const bytes = await readLimited(response, MAX_BROWSE_BYTES);
    if (!validImageDimensions(bytes, type)) throw new Error("ASF browse image has invalid or unsafe dimensions");
    return new Blob([bytes.buffer as ArrayBuffer], { type });
  } finally { clearTimeout(request.timer); }
}
