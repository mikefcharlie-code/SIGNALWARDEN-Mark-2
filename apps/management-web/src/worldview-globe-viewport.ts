export type GlobeBounds = Readonly<{
  west: number;
  south: number;
  east: number;
  north: number;
}>;
export type GlobeCameraView = Readonly<{
  position: readonly [number, number, number];
  right: readonly [number, number, number];
  up: readonly [number, number, number];
  forward: readonly [number, number, number];
  aspect: number;
  fovDegrees: number;
}>;

type Point = readonly [number, number, number];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Point): Point => {
  const length = Math.hypot(...a);
  return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
};
const pointAt = (origin: Point, direction: Point, distance: number): Point => [
  origin[0] + direction[0] * distance,
  origin[1] + direction[1] * distance,
  origin[2] + direction[2] * distance,
];
const wrap180 = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;

/**
 * Intersects a bounded grid of actual camera-frustum rays with the unit globe,
 * then returns one or two WGS84 rectangles suitable for bbox-only providers.
 * A small margin avoids clipping edge pixels between ray samples. It does not
 * include aircraft, observations, records, annotations, or scene content.
 */
export function visibleGlobeBounds(
  view: GlobeCameraView,
  samples = 32,
  marginDegrees = 1.5,
): GlobeBounds[] {
  if (
    !Number.isFinite(view.aspect) || view.aspect <= 0 ||
    !Number.isFinite(view.fovDegrees) || view.fovDegrees <= 0 || view.fovDegrees >= 179 ||
    !Number.isInteger(samples) || samples < 2 || samples > 64 ||
    !Number.isFinite(marginDegrees) || marginDegrees < 0 || marginDegrees > 5
  ) return [];
  const origin = view.position;
  const originLengthSq = dot(origin, origin);
  if (!Number.isFinite(originLengthSq) || originLengthSq <= 1) return [];
  const tangent = Math.tan((view.fovDegrees * Math.PI) / 360);
  const points: Point[] = [];
  const steps = samples + 1;
  for (let yi = 0; yi <= samples; yi++) {
    const ny = 1 - (2 * yi) / samples;
    for (let xi = 0; xi <= samples; xi++) {
      const nx = (2 * xi) / samples - 1;
      const direction = norm([
        view.forward[0] + view.right[0] * nx * tangent * view.aspect + view.up[0] * ny * tangent,
        view.forward[1] + view.right[1] * nx * tangent * view.aspect + view.up[1] * ny * tangent,
        view.forward[2] + view.right[2] * nx * tangent * view.aspect + view.up[2] * ny * tangent,
      ]);
      const b = dot(origin, direction);
      const discriminant = b * b - (originLengthSq - 1);
      if (discriminant < 0) continue;
      const distance = -b - Math.sqrt(discriminant);
      if (distance <= 0) continue;
      points.push(pointAt(origin, direction, distance));
    }
  }
  if (!points.length) return [];

  const latitudes = points.map((p) => (Math.asin(Math.max(-1, Math.min(1, p[1]))) * 180) / Math.PI);
  const south = Math.max(-90, Math.min(...latitudes) - marginDegrees);
  const north = Math.min(90, Math.max(...latitudes) + marginDegrees);
  if (south >= north) return [];

  const longitudes = points
    .map((p) => (((Math.atan2(p[0], p[2]) * 180) / Math.PI) % 360 + 360) % 360)
    .sort((a, b) => a - b);
  if (!longitudes.length) return [];
  let gap = -1;
  let gapIndex = 0;
  for (let i = 0; i < longitudes.length; i++) {
    const next = i === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[i + 1];
    const currentGap = next - longitudes[i];
    if (currentGap > gap) {
      gap = currentGap;
      gapIndex = i;
    }
  }
  const arc = Math.max(0, 360 - gap);
  if (arc + marginDegrees * 2 >= 359.999) {
    return [{ west: -180, south, east: 180, north }];
  }
  const start = longitudes[(gapIndex + 1) % longitudes.length] - marginDegrees;
  const end = longitudes[gapIndex] + (gapIndex < longitudes.length - 1 ? 360 : 0) + marginDegrees;
  const west = wrap180(start);
  const east = wrap180(end);
  if (west <= east && end - start < 180) return [{ west, south, east, north }];
  if (west <= east && end - start >= 180) return [{ west: -180, south, east: 180, north }];
  return [
    { west, south, east: 180, north },
    { west: -180, south, east, north },
  ].filter((bounds) => bounds.west < bounds.east);
}

/** Conservative WGS84 bounds for the square orthographic fallback renderer. */
export function visibleOrthographicBounds(
  center: Readonly<{ lat: number; lon: number }>,
  zoom: number,
  samples = 32,
  marginDegrees = 1.5,
): GlobeBounds[] {
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon) || Math.abs(center.lat) > 89 || Math.abs(center.lon) > 180 ||
      !Number.isFinite(zoom) || zoom < 0.65 || zoom > 1.8 || !Number.isInteger(samples) || samples < 2 || samples > 64 ||
      !Number.isFinite(marginDegrees) || marginDegrees < 0 || marginDegrees > 5) return [];
  const half = 1.15 / zoom;
  const c = (center.lat * Math.PI) / 180;
  const lon0 = (center.lon * Math.PI) / 180;
  const points: Point[] = [];
  for (let yi = 0; yi <= samples; yi++) {
    const y = half - (2 * half * yi) / samples;
    for (let xi = 0; xi <= samples; xi++) {
      const x = -half + (2 * half * xi) / samples;
      const r2 = x * x + y * y;
      if (r2 > 1) continue;
      const z = Math.sqrt(Math.max(0, 1 - r2));
      const localX = x * Math.cos(lon0) + z * Math.sin(lon0);
      const localZ = -x * Math.sin(lon0) + z * Math.cos(lon0);
      const worldY = y * Math.cos(c) + z * Math.sin(c);
      points.push([localX, worldY, localZ]);
    }
  }
  if (!points.length) return [];
  const latitudes = points.map((p) => (Math.asin(Math.max(-1, Math.min(1, p[1]))) * 180) / Math.PI);
  const south = Math.max(-90, Math.min(...latitudes) - marginDegrees);
  const north = Math.min(90, Math.max(...latitudes) + marginDegrees);
  if (south >= north) return [];
  const longitudes = points.map((p) => (((Math.atan2(p[0], p[2]) * 180) / Math.PI) % 360 + 360) % 360).sort((a, b) => a - b);
  let gap = -1, gapIndex = 0;
  for (let i = 0; i < longitudes.length; i++) {
    const next = i === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[i + 1];
    if (next - longitudes[i] > gap) { gap = next - longitudes[i]; gapIndex = i; }
  }
  const arc = Math.max(0, 360 - gap);
  if (arc + marginDegrees * 2 >= 359.999) return [{ west: -180, south, east: 180, north }];
  const start = longitudes[(gapIndex + 1) % longitudes.length] - marginDegrees;
  const end = longitudes[gapIndex] + (gapIndex < longitudes.length - 1 ? 360 : 0) + marginDegrees;
  const west = wrap180(start), east = wrap180(end);
  if (west <= east && end - start < 180) return [{ west, south, east, north }];
  if (west <= east && end - start >= 180) return [{ west: -180, south, east: 180, north }];
  return [{ west, south, east: 180, north }, { west: -180, south, east, north }].filter((bounds) => bounds.west < bounds.east);
}
