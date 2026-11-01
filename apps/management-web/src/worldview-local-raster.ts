import { fromBlob } from "geotiff";
import proj4 from "proj4";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_PREVIEW_SIDE = 32;

type Point = { lat: number; lon: number };
type PreviewCell = { corners: [Point, Point, Point, Point]; value: number | null };
export interface LocalRaster {
  name: string;
  bytes: number;
  lastModified?: number;
  importedAt: string;
  crs: string;
  width: number;
  height: number;
  bands: number;
  bitsPerSample: number[];
  compression: "uncompressed";
  footprint: [Point, Point, Point, Point];
  nativeBounds: [number, number, number, number];
  resolution: [number, number];
  nodata: number | null;
  validCells: number;
  preview: {
    cells: PreviewCell[];
    min: number | null;
    max: number | null;
    validCount: number;
    nodataCount: number;
  };
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The raster inspection was cancelled", "AbortError");
}
function finite(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }
function fail(message: string): never { throw new Error(`Unsupported local raster: ${message}`); }
function value(dir: any, tag: number): any {
  try { return dir?.getValue?.(tag); } catch { return undefined; }
}
function first(v: any): number | undefined {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) { const n = (v as any)[0]; return finite(n) ? n : undefined; }
  return finite(v) ? v : undefined;
}
function numeric(v: any): number | undefined {
  if (typeof v === "string") { const text = v.replace(/\0/g, "").trim(); if (text.toLowerCase() === "nan") return NaN; const n = Number(text); if (!text || !finite(n)) fail("invalid nodata metadata"); return n; }
  return first(v);
}
function key(keys: any, name: string, numeric: number): any {
  return keys?.[name] ?? keys?.[numeric];
}
function crsFor(keys: any): { code: string; definition: string } {
  const geographic = Number(key(keys, "GeographicTypeGeoKey", 2048));
  const projected = Number(key(keys, "ProjectedCSTypeGeoKey", 3072));
  if (geographic === 4326 && (!projected || projected === 0)) return { code: "EPSG:4326", definition: "EPSG:4326" };
  if (projected && geographic && geographic !== 4326) fail("conflicting geographic and projected CRS");
  if (projected === 3857) return { code: "EPSG:3857", definition: "EPSG:3857" };
  if ((projected >= 32601 && projected <= 32660) || (projected >= 32701 && projected <= 32760)) {
    return { code: `EPSG:${projected}`, definition: `EPSG:${projected}` };
  }
  fail(`CRS is not in the WGS84/EPSG:4326, EPSG:3857, or WGS84 UTM allowlist (geographic=${geographic || "none"}, projected=${projected || "none"})`);
}
function projectPoint(x: number, y: number, crs: string): Point {
  let out: any;
  try { out = crs === "EPSG:4326" ? [x, y] : proj4(crs, "EPSG:4326", [x, y]); } catch { fail(`CRS transformation failed for ${crs}`); }
  const lon = Number(out[0]), lat = Number(out[1]);
  if (!finite(lat) || !finite(lon) || lat < -90 - 1e-7 || lat > 90 + 1e-7 || lon < -180 - 1e-7 || lon > 180 + 1e-7) fail("bounds fall outside WGS84");
  return { lat: Math.max(-90, Math.min(90, lat)), lon: Math.max(-180, Math.min(180, lon)) };
}
function cornersFor(x: number, y: number, sx: number, sy: number, crs: string): [Point, Point, Point, Point] {
  const corners: [Point, Point, Point, Point] = [projectPoint(x, y, crs), projectPoint(x + sx, y, crs), projectPoint(x + sx, y + sy, crs), projectPoint(x, y + sy, crs)];
  const lons = corners.map(p => p.lon);
  if (Math.max(...lons) - Math.min(...lons) > 180) fail("antimeridian-crossing pixel is not safely representable");
  return corners;
}

export async function inspectLocalRaster(file: Blob, options: { signal?: AbortSignal; name?: string; lastModified?: number } = {}): Promise<LocalRaster> {
  const { signal } = options;
  cancelled(signal);
  if (!(file instanceof Blob)) throw new TypeError("inspectLocalRaster requires a Blob");
  if (file.size > MAX_FILE_BYTES) fail("file exceeds 16 MiB");
  const name = options.name ?? (file as File).name ?? "local-raster.tif";
  const lastModified = options.lastModified ?? (file as File).lastModified;
  const importedAt = new Date().toISOString();
  const tiff = await fromBlob(file);
  cancelled(signal);
  const image: any = await tiff.getImage();
  cancelled(signal);
  const width = Number(image.getWidth()), height = Number(image.getHeight());
  const bands = Number(image.getSamplesPerPixel());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) fail("dimensions exceed 4096 per side");
  if (width * height > MAX_PIXELS) fail("pixel count exceeds 4 million");
  if (!Number.isInteger(bands) || bands < 1 || bands > 4) fail("more than 4 bands");
  const dir: any = image.getFileDirectory();
  if (Number(first(value(dir, 274)) ?? 1) !== 1) fail("non-top-left image orientation");
  if (![1, 2].includes(Number(first(value(dir, 284)) ?? 1))) fail("unsupported planar configuration");
  if (Number(first(value(dir, 317)) ?? 1) !== 1) fail("uncompressed predictor is unsupported");
  const compression = Number(first(value(dir, 259)) ?? 1);
  if (compression !== 1) fail("compressed TIFFs are not accepted for bounded offline decoding");
  const rows = Number(first(value(dir, 278)) ?? height);
  const tileW = Number(first(value(dir, 322)) ?? width), tileH = Number(first(value(dir, 323)) ?? rows);
  if (!Number.isInteger(rows) || rows < 1 || rows > 4096 || !Number.isInteger(tileW) || tileW < 1 || tileW > 4096 || !Number.isInteger(tileH) || tileH < 1 || tileH > 4096) fail("strip/tile dimensions are unsafe");
  const bitTag = value(dir, 258);
  const bitsPerSample: number[] = bitTag && typeof bitTag !== "number" ? Array.from(bitTag) : [bitTag ?? 8];
  if (bitsPerSample.length !== 1 && bitsPerSample.length !== bands) fail("inconsistent sample widths");
  if (bitsPerSample.some(bits => ![8, 16, 32, 64].includes(bits))) fail("unsupported sample width");
  const bits = Math.max(...bitsPerSample);
  if (width * height * bands * (bits / 8) > MAX_DECODED_BYTES) fail("decoded raster exceeds safety bound");
  const keys: any = image.getGeoKeys?.() ?? {};
  if (![undefined, 1].includes(key(keys, "GTRasterTypeGeoKey", 1025))) fail("PixelIsPoint georeferencing is unsupported");
  if (key(keys, "VerticalCSTypeGeoKey", 4096) || key(keys, "VerticalCitationGeoKey", 4097) || key(keys, "VerticalDatumGeoKey", 4098) || key(keys, "VerticalUnitsGeoKey", 4099)) fail("vertical datum is unsupported");
  if (Number(key(keys, "GeogGeodeticDatumGeoKey", 2050) ?? 6326) !== 6326) fail("non-WGS84 datum or datum grid is unsupported");
  if (Number(key(keys, "GeogAngularUnitsGeoKey", 2054) ?? 9102) !== 9102) fail("non-degree angular units are unsupported");
  if (Number(key(keys, "GeogEllipsoidGeoKey", 2056) ?? 7030) !== 7030 || Number(key(keys, "GeogPrimeMeridianGeoKey", 2051) ?? 8901) !== 8901) fail("custom ellipsoid or prime meridian");
  if (Number(key(keys, "ProjLinearUnitsGeoKey", 3076) ?? 9001) !== 9001) fail("non-metre projected units");
  // Only named EPSG codes and these non-transforming metadata keys are accepted.
  // In particular, never let a custom datum/grid or projection override a known code.
  const allowedKeys = new Set([
    "GTModelTypeGeoKey", "GTRasterTypeGeoKey", "GTCitationGeoKey",
    "GeographicTypeGeoKey", "GeogCitationGeoKey", "GeogGeodeticDatumGeoKey",
    "GeogPrimeMeridianGeoKey", "GeogAngularUnitsGeoKey", "GeogEllipsoidGeoKey",
    "ProjectedCSTypeGeoKey", "PCSCitationGeoKey", "ProjLinearUnitsGeoKey",
  ]);
  if (Object.entries(keys).some(([name, entry]) => !allowedKeys.has(name) ||
    (typeof entry === "string" && /nadgrids|geoidgrids|\.gsb|\.gtx|BOUNDCRS|ABRIDGEDTRANSFORMATION/i.test(entry)))) fail("custom CRS parameters or datum grids are unsupported");
  const { code: crs } = crsFor(keys);
  const model = key(keys, "GTModelTypeGeoKey", 1024);
  if (model !== undefined && model !== (crs === "EPSG:4326" ? 2 : 1)) fail("model type conflicts with CRS");
  const scale = value(dir, 33550), tie = value(dir, 33922), transform = value(dir, 34264);
  if (transform) fail("rotated/model-transformation georeferencing is unsupported");
  const sx = first(scale), syRaw = Array.isArray(scale) || ArrayBuffer.isView(scale) ? (scale as any)[1] : undefined;
  const sy = finite(syRaw) ? -syRaw : undefined;
  if (!finite(sx) || !finite(sy) || sx <= 0 || syRaw <= 0 || !tie || tie.length !== 6 || !finite(tie[0]) || !finite(tie[1]) || !finite(tie[3]) || !finite(tie[4])) fail("missing or invalid ModelPixelScale/ModelTiepoint georeferencing");
  const ox = Number(tie[3]) - Number(tie[0]) * sx, oy = Number(tie[4]) - Number(tie[1]) * sy;
  const nativeBounds: [number, number, number, number] = [ox, oy + sy * height, ox + sx * width, oy];
  if (crs === "EPSG:3857" && nativeBounds.some(v => Math.abs(v) > 20037508.342789244)) fail("Web Mercator bounds exceed supported world extent");
  const footprint = cornersFor(ox, oy, sx * width, sy * height, crs);
  const previewW = Math.min(MAX_PREVIEW_SIDE, width), previewH = Math.min(MAX_PREVIEW_SIDE, height);
  const raster: any = await image.readRasters({ window: [0, 0, width, height], samples: [0], interleave: true, signal });
  cancelled(signal);
  const cells: PreviewCell[] = [], vals: number[] = [];
  let nodata = numeric(value(dir, 42113));
  if (nodata === undefined) { const gd = await image.getGDALMetadata?.(); const s = gd?.GDAL_NODATA ?? gd?.GDAL_NODATA_VALUE; if (s != null && s !== "") nodata = Number(s); }
  cancelled(signal);
  const nodataOut = typeof nodata === "number" ? nodata : null;
  for (let py = 0; py < previewH; py++) for (let px = 0; px < previewW; px++) {
    cancelled(signal);
    const x0 = Math.floor(px * width / previewW);
    const y0 = Math.floor(py * height / previewH);
    const ix = x0, iy = y0, raw = Number(raster[iy * width + ix]);
    const invalid = !finite(raw) || (nodataOut !== null && (Number.isNaN(nodataOut) ? Number.isNaN(raw) : raw === nodataOut));
    const cellValue = invalid ? null : raw;
    if (!invalid) vals.push(raw);
    const x = ox + ix * sx, y = oy + iy * sy;
    cells.push({ corners: cornersFor(x, y, sx, sy, crs), value: cellValue });
  }
  return { name, bytes: file.size, ...(finite(lastModified) ? { lastModified } : {}), importedAt, crs, width, height, bands, bitsPerSample, compression: "uncompressed", footprint, nativeBounds, resolution: [Math.abs(sx), Math.abs(sy)], nodata: nodataOut, validCells: vals.length, preview: { cells, min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null, validCount: vals.length, nodataCount: cells.length - vals.length } };
}
