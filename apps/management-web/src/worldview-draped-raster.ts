import proj4 from "proj4";

export type LonLat = readonly [number, number];
export type AffineRasterTransform = Readonly<{
  crs: string;
  originX: number;
  originY: number;
  pixelWidth: number;
  pixelHeight: number;
}>;
export type GeoreferencedRasterSurface = Readonly<{
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** WGS84 lon/lat at every display-cell corner, row-major, (width + 1) × (height + 1). */
  grid: ReadonlyArray<LonLat>;
  /** WGS84 lon/lat at every display-cell center, row-major. */
  samplePoints: ReadonlyArray<LonLat>;
  crs: string;
  transform: AffineRasterTransform;
  sourceWidth: number;
  sourceHeight: number;
}>;

const MAX_SIDE = 128;
const ALLOWED_CRS = /^(?:EPSG:4326|EPSG:3857|EPSG:32[67](?:0[1-9]|[1-5][0-9]|60))$/;

function wrapLongitude(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

export function toWgs84(x: number, y: number, crs: string): LonLat {
  if (!ALLOWED_CRS.test(crs)) throw new Error(`Unsupported CRS for surface draping: ${crs}`);
  let result: number[];
  try {
    result = crs === "EPSG:4326" ? [x, y] : proj4(crs, "EPSG:4326", [x, y]);
  } catch {
    throw new Error(`Unsupported or unavailable coordinate transform: ${crs} to EPSG:4326`);
  }
  const lon = Number(result[0]);
  const lat = Number(result[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 540 || lat < -90 - 1e-7 || lat > 90 + 1e-7) {
    throw new Error("Raster transform produces coordinates outside supported WGS84 bounds");
  }
  return [wrapLongitude(lon), Math.max(-90, Math.min(90, lat))];
}

function displayDimensions(width: number, height: number): [number, number] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("Invalid source raster dimensions");
  const factor = Math.min(1, MAX_SIDE / Math.max(width, height));
  return [Math.max(1, Math.ceil(width * factor)), Math.max(1, Math.ceil(height * factor))];
}

/** Build a bounded display surface using the source affine transform, not a scene footprint. */
export function buildGeoreferencedSurface(
  sourceWidth: number,
  sourceHeight: number,
  sourceRgba: Uint8ClampedArray,
  transform: AffineRasterTransform,
): GeoreferencedRasterSurface {
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 || sourceWidth * sourceHeight > 4_000_000 || sourceRgba.length !== sourceWidth * sourceHeight * 4) {
    throw new Error("Raster pixels exceed the bounded surface contract");
  }
  if (![transform.originX, transform.originY, transform.pixelWidth, transform.pixelHeight].every(Number.isFinite) || transform.pixelWidth <= 0 || transform.pixelHeight >= 0) {
    throw new Error("Unsupported or invalid north-up raster affine transform");
  }
  const east = transform.originX + sourceWidth * transform.pixelWidth;
  const south = transform.originY + sourceHeight * transform.pixelHeight;
  if (!Number.isFinite(east) || !Number.isFinite(south)) throw new Error("Raster affine extent is not finite");
  if (transform.crs === "EPSG:4326" && (transform.originX < -180 || transform.originX > 180 || east - transform.originX > 360 || transform.originY > 90 + 1e-7 || south < -90 - 1e-7)) {
    throw new Error("EPSG:4326 raster extent is outside supported WGS84 longitude/latitude bounds or spans more than one world");
  }
  const WEB_MERCATOR_LIMIT = 20037508.342789244;
  if (transform.crs === "EPSG:3857" && (transform.originX < -WEB_MERCATOR_LIMIT || east > WEB_MERCATOR_LIMIT || transform.originY > WEB_MERCATOR_LIMIT || south < -WEB_MERCATOR_LIMIT)) {
    throw new Error("EPSG:3857 raster extent exceeds the supported Web Mercator world bounds");
  }
  const [width, height] = displayDimensions(sourceWidth, sourceHeight);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const samplePoints: LonLat[] = [];
  const grid: LonLat[] = [];
  const sourcePoint = (u: number, v: number): LonLat => toWgs84(
    transform.originX + u * sourceWidth * transform.pixelWidth,
    transform.originY + v * sourceHeight * transform.pixelHeight,
    transform.crs,
  );
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) grid.push(sourcePoint(x / width, y / height));
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
      const sourceAt = (sourceY * sourceWidth + sourceX) * 4;
      const targetAt = (y * width + x) * 4;
      rgba.set(sourceRgba.subarray(sourceAt, sourceAt + 4), targetAt);
      samplePoints.push(sourcePoint((x + 0.5) / width, (y + 0.5) / height));
    }
  }
  return { width, height, rgba, grid, samplePoints, crs: transform.crs, transform, sourceWidth, sourceHeight };
}

/** Mask display texels to an operator-selected AOI. A null ring intentionally leaves the source un-clipped. */
export function maskSurfaceToRing(surface: GeoreferencedRasterSurface, ring: ReadonlyArray<LonLat> | null): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(surface.rgba);
  if (!ring || ring.length < 4) return rgba;
  for (let i = 0; i < surface.samplePoints.length; i++) {
    if (!pointInRing(surface.samplePoints[i], ring)) rgba[i * 4 + 3] = 0;
  }
  return rgba;
}

function unwrapNear(lon: number, reference: number): number {
  return reference + wrapLongitude(lon - reference);
}

export function pointInRing(point: LonLat, ring: ReadonlyArray<LonLat>): boolean {
  if (ring.length < 4) return false;
  const [x, y] = point;
  const unwrapped: number[] = [ring[0][0]];
  for (let i = 1; i < ring.length; i++) unwrapped.push(unwrapped[i - 1] + wrapLongitude(ring[i][0] - unwrapped[i - 1]));
  const center = unwrapped.reduce((sum, lon) => sum + lon, 0) / unwrapped.length;
  const shift = Math.round((x - center) / 360) * 360;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = unwrapped[i] + shift, yi = ring[i][1];
    const xj = unwrapped[j] + shift, yj = ring[j][1];
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Split a WGS84 path into SVG-safe parts at the anti-meridian. */
export function splitPathAtAntimeridian(points: ReadonlyArray<LonLat>): LonLat[][] {
  if (!points.length) return [];
  const parts: LonLat[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const next = points[i];
    const delta = next[0] - previous[0];
    if (Math.abs(delta) <= 180) { parts.at(-1)!.push(next); continue; }
    const adjustedNext = next[0] + (delta > 180 ? -360 : 360);
    const seam = delta > 180 ? -180 : 180;
    const t = (seam - previous[0]) / (adjustedNext - previous[0]);
    const lat = previous[1] + t * (next[1] - previous[1]);
    parts.at(-1)!.push([seam, lat]);
    parts.push([[seam === 180 ? -180 : 180, lat], next]);
  }
  return parts.filter((part) => part.length > 1);
}
