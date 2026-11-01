import { GeoTIFF } from "geotiff";
import { buildGeoreferencedSurface, type GeoreferencedRasterSurface } from "./worldview-draped-raster";

type Slice = { offset: number; length: number };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const HOST = "umbra-open-data-catalog.s3.us-west-2.amazonaws.com";
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_REQUESTS = 40;
const MAX_RANGE = 2 * 1024 * 1024;
const DEADLINE_MS = 20_000;
const MAX_SIDE = 100_000;
const MAX_PIXELS = 1_000_000;
const MAX_DECODED = 8 * 1024 * 1024;

export interface UmbraRasterPreview {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
  overviewIndex: number;
  bytesRead: number;
  requestCount: number;
  stretch: "log1p,2-98percentile";
  surface: GeoreferencedRasterSurface | null;
  registrationIssue: string | null;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("Umbra raster preview cancelled");
}
function fail(message: string): never {
  throw new Error(`Unsupported Umbra raster: ${message}`);
}
function validUrl(input: string): URL {
  try { if (/(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(decodeURIComponent(input))) fail("path traversal is not allowed"); } catch { fail("object URL is invalid"); }
  if (/^https:\/\/[^/]+:\d+(?:\/|$)/i.test(input)) fail("object URL must not specify a port");
  let url: URL;
  try { url = new URL(input); } catch { fail("object URL is invalid"); }
  if (url.protocol !== "https:" || url.hostname !== HOST || url.username || url.password || url.port || url.search || url.hash) fail("object URL must be an HTTPS Umbra S3 object without credentials, port, query, or fragment");
  const path = decodeURIComponent(url.pathname);
  if (path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) fail("path traversal is not allowed");
  if (!/^\/(?:sar-data\/tasks|open-data)\/[^/]+(?:\/[^/]+)*_(?:GEC|MM)\.tif$/i.test(url.pathname)) fail("object is not an allowlisted GEC or MM GeoTIFF");
  return url;
}
function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const n = Number((value as any)[0]);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function tag(dir: any, id: number): unknown {
  const value = dir?.getValue?.(id);
  return value;
}
function numbers(value: unknown): number[] {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value as any, Number);
  const n = Number(value); return Number.isFinite(n) ? [n] : [];
}

function georeferenceFor(image: any): { crs: string; originX: number; originY: number; pixelWidth: number; pixelHeight: number } {
  const keys: any = image.getGeoKeys?.() ?? {};
  const key = (name: string, id: number) => keys[name] ?? keys[id];
  const geographic = Number(key("GeographicTypeGeoKey", 2048) ?? 0);
  const projected = Number(key("ProjectedCSTypeGeoKey", 3072) ?? 0);
  let crs: string;
  if (projected && geographic && geographic !== 4326) fail("conflicting geographic and projected CRS GeoKeys");
  if (geographic === 4326 && (!projected || projected === 0)) crs = "EPSG:4326";
  else if (projected === 3857 && (!geographic || geographic === 4326)) crs = "EPSG:3857";
  else if ((projected >= 32601 && projected <= 32660) || (projected >= 32701 && projected <= 32760)) crs = `EPSG:${projected}`;
  else fail(`missing, conflicting, or unsupported WGS84 CRS GeoKeys (geographic=${geographic || "none"}, projected=${projected || "none"})`);
  if (key("GTModelTypeGeoKey", 1024) !== undefined && Number(key("GTModelTypeGeoKey", 1024)) !== (crs === "EPSG:4326" ? 2 : 1)) fail("model type conflicts with CRS");
  if (![undefined, 1].includes(Number(key("GTRasterTypeGeoKey", 1025) ?? 1))) fail("PixelIsPoint georeferencing is unsupported");
  if (Number(key("GeogGeodeticDatumGeoKey", 2050) ?? 6326) !== 6326 || Number(key("GeogAngularUnitsGeoKey", 2054) ?? 9102) !== 9102 || Number(key("GeogEllipsoidGeoKey", 2056) ?? 7030) !== 7030 || Number(key("GeogPrimeMeridianGeoKey", 2051) ?? 8901) !== 8901) fail("non-WGS84 datum, angular units, ellipsoid, or prime meridian is unsupported");
  if (Number(key("ProjLinearUnitsGeoKey", 3076) ?? 9001) !== 9001) fail("non-metre projected units are unsupported");
  const allowed = new Set(["GTModelTypeGeoKey", "GTRasterTypeGeoKey", "GTCitationGeoKey", "GeographicTypeGeoKey", "GeogCitationGeoKey", "GeogGeodeticDatumGeoKey", "GeogPrimeMeridianGeoKey", "GeogAngularUnitsGeoKey", "GeogEllipsoidGeoKey", "ProjectedCSTypeGeoKey", "PCSCitationGeoKey", "ProjLinearUnitsGeoKey"]);
  if (Object.entries(keys).some(([name, value]) => !allowed.has(name) || (typeof value === "string" && /nadgrids|geoidgrids|\.gsb|\.gtx|BOUNDCRS|ABRIDGEDTRANSFORMATION/i.test(value)))) fail("custom CRS parameters or datum grids are unsupported");
  const dir = image.getFileDirectory();
  if (tag(dir, 34264) != null) fail("rotated/model-transformation georeferencing is unsupported");
  const scale = numbers(tag(dir, 33550)), tie = numbers(tag(dir, 33922));
  const sx = scale[0], syRaw = scale[1], tieI = tie[0], tieJ = tie[1], tieX = tie[3], tieY = tie[4];
  if (scale.length < 2 || tie.length !== 6 || ![sx, syRaw, tieI, tieJ, tieX, tieY].every(Number.isFinite) || sx <= 0 || syRaw <= 0) fail("missing or invalid ModelPixelScale/ModelTiepoint affine transform");
  return { crs, originX: tieX - tieI * sx, originY: tieY + tieJ * syRaw, pixelWidth: sx, pixelHeight: -syRaw };
}

class BoundedSource {
  readonly fileSize: number;
  bytesRead = 0;
  requestCount = 0;
  private readonly url: URL;
  private readonly fetcher: Fetcher;
  private readonly signal?: AbortSignal;
  private readonly deadline: number;
  private readonly operation = new AbortController();
  private active = 0;
  constructor(url: URL, size: number, signal: AbortSignal | undefined, fetcher: Fetcher) {
    if (!Number.isSafeInteger(size) || size <= 0) fail("listed object size is invalid");
    this.url = url; this.fileSize = size; this.signal = signal; this.fetcher = (input, init) => fetcher(input, init); this.deadline = Date.now() + DEADLINE_MS;
  }
  async fetch(slices: Slice[], signal?: AbortSignal): Promise<ArrayBuffer[]> {
    const merged = slices.map((slice) => ({ offset: slice.offset, length: slice.length }));
    return Promise.all(merged.map((slice) => this.fetchOne(slice, signal)));
  }
  private async fetchOne(slice: Slice, localSignal?: AbortSignal): Promise<ArrayBuffer> {
    check(this.signal); check(localSignal);
    check(this.operation.signal);
    if (!Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.length) || slice.offset < 0 || slice.length <= 0 || slice.length > MAX_RANGE || slice.offset + slice.length > this.fileSize) fail("requested range exceeds safety limits");
    if (Date.now() >= this.deadline) throw new Error("Umbra raster preview deadline exceeded");
    if (this.requestCount >= MAX_REQUESTS || this.bytesRead + slice.length > MAX_TOTAL) fail("range budget exceeded");
    this.requestCount++; this.bytesRead += slice.length; this.active++;
    const controller = new AbortController();
    const relay = () => controller.abort();
    const cancelOperation = () => controller.abort();
    this.operation.signal.addEventListener("abort", cancelOperation, { once: true });
    this.signal?.addEventListener("abort", relay, { once: true });
    localSignal?.addEventListener("abort", relay, { once: true });
    const remaining = Math.max(1, this.deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectStopped: (reason: unknown) => void = () => {};
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const onStopped = () => rejectStopped(abortError("Umbra raster read cancelled or timed out"));
    controller.signal.addEventListener("abort", onStopped, { once: true });
    try {
      const end = slice.offset + slice.length - 1;
      const response = await Promise.race([this.fetcher(this.url, { method: "GET", headers: { Range: `bytes=${slice.offset}-${end}` }, credentials: "omit", referrer: "", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: controller.signal }), stopped]);
      if (response.status !== 206) { try { await response.body?.cancel(); } catch {} fail(response.status === 200 ? "server returned a full object for a range request" : `range request failed with HTTP ${response.status}`); }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > slice.length) { try { await response.body?.cancel(); } catch {} fail("range response exceeds the requested range"); }
      reader = response.body?.getReader();
      if (!reader) fail("range response has no body");
      const chunks: Uint8Array[] = []; let received = 0;
      while (true) {
        const part = await Promise.race([reader.read(), stopped]); if (part.done) break;
        received += part.value.byteLength;
        if (received > slice.length) { await reader.cancel(); fail("range response body exceeds the requested range"); }
        chunks.push(part.value);
      }
      if (received !== slice.length) fail("range response body length does not match the requested range");
      const body = new Uint8Array(received); let at = 0; for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
      return body.buffer;
    } catch (error) {
      if (controller.signal.aborted) { check(this.signal); check(localSignal); if (Date.now() >= this.deadline) throw new Error("Umbra raster preview deadline exceeded"); throw abortError("Umbra raster range request cancelled"); }
      throw error;
    } finally {
      controller.signal.removeEventListener("abort", onStopped);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      clearTimeout(timer); this.signal?.removeEventListener("abort", relay); localSignal?.removeEventListener("abort", relay); this.operation.signal.removeEventListener("abort", cancelOperation); this.active--;
    }
  }
  async close(): Promise<void> { this.operation.abort(); }
}

export async function previewUmbraRaster(objectUrl: string, size: number, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<UmbraRasterPreview> {
  const url = validUrl(objectUrl); check(signal);
  const source = new BoundedSource(url, size, signal, fetcher);
  let tiff: GeoTIFF | undefined;
  try {
    tiff = await GeoTIFF.fromSource(source as any, undefined, signal);
    const images: Array<{ image: any; index: number; pixels: number }> = [];
    let sourceWidth = 0, sourceHeight = 0;
    for (let i = 0; i < 10; i++) {
      check(signal);
      let image: any;
      try { image = await tiff.getImage(i); } catch (error) {
        // Pinned GeoTIFF 3.0.5 uses a non-exported end-of-IFD error with this
        // exact message/index. All provider, parse, timeout and budget errors
        // must propagate rather than masquerading as a complete directory.
        if (i > 0 && error instanceof Error && error.message === `No image at index ${i}` && (error as Error & { index?: number }).index === i) break;
        throw error;
      }
      const width = image.getWidth(), height = image.getHeight();
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) fail("image dimensions exceed safety limits");
      if (i === 0) { sourceWidth = width; sourceHeight = height; }
      const dir = image.getFileDirectory();
      const subfile = numberValue(tag(dir, 254)) ?? 0;
      const bands = image.getSamplesPerPixel();
      const bits = image.getBitsPerSample(0);
      const compression = numberValue(tag(dir, 259)) ?? 0;
      const tileWidth = image.getTileWidth(), tileHeight = image.getTileHeight();
      const pixels = width * height;
      const reduced = Boolean(subfile & 1) || width < sourceWidth || height < sourceHeight;
      const supportedCompression = compression === 1 || compression === 5 || compression === 8 || compression === 32946;
      const bytesPerSample = bits === 8 ? 1 : bits === 16 ? 2 : bits === 32 ? 4 : 0;
      const valid = width <= 1024 && height <= 1024 && reduced && !(subfile & 4) && bands === 1 && supportedCompression && bytesPerSample > 0 && tileWidth <= 1024 && tileHeight <= 1024 && pixels <= MAX_PIXELS && pixels * bytesPerSample <= MAX_DECODED;
      if (valid) images.push({ image, index: i, pixels });
    }
    if (!images.length) fail("no bounded single-band reduced overview is available; full-resolution decoding is disabled");
    images.sort((a, b) => a.pixels - b.pixels || a.index - b.index);
    const chosen = images[0];
    const rasters = await chosen.image.readRasters({ samples: [0], interleave: false, signal });
    const values: any = Array.isArray(rasters) ? rasters[0] : rasters;
    const nodata = chosen.image.getGDALNoData?.();
    const validValues: number[] = [];
    for (let i = 0; i < values.length; i++) { const n = Number(values[i]); if (Number.isFinite(n) && !(nodata !== null && nodata !== undefined && n === nodata)) validValues.push(n); }
    if (!validValues.length) fail("overview contains no finite displayable samples");
    validValues.sort((a, b) => a - b);
    const percentile = (p: number) => validValues[Math.min(validValues.length - 1, Math.max(0, Math.ceil(p * validValues.length) - 1))];
    const low = percentile(0.02), high = percentile(0.98), span = high > low ? high - low : 1;
    const rgba = new Uint8ClampedArray(chosen.image.getWidth() * chosen.image.getHeight() * 4);
    for (let i = 0; i < values.length; i++) {
      const n = Number(values[i]), out = i * 4;
      if (!Number.isFinite(n) || (nodata !== null && nodata !== undefined && n === nodata)) { rgba[out + 3] = 0; continue; }
      const normalized = Math.max(0, Math.min(1, Math.log1p(Math.max(0, n - low)) / Math.log1p(span)));
      const gray = Math.round(normalized * 255); rgba[out] = gray; rgba[out + 1] = gray; rgba[out + 2] = gray; rgba[out + 3] = 255;
    }
    let surface: GeoreferencedRasterSurface | null = null, registrationIssue: string | null = null;
    try {
      surface = buildGeoreferencedSurface(chosen.image.getWidth(), chosen.image.getHeight(), rgba, georeferenceFor(chosen.image));
    } catch (error) {
      registrationIssue = error instanceof Error ? error.message.replace(/^Unsupported Umbra raster: /, "") : "unsupported or missing source georeferencing";
    }
    return { width: chosen.image.getWidth(), height: chosen.image.getHeight(), rgba, sourceWidth, sourceHeight, overviewIndex: chosen.index, bytesRead: source.bytesRead, requestCount: source.requestCount, stretch: "log1p,2-98percentile", surface, registrationIssue };
  } finally { await tiff?.close(); await source.close(); }
}
