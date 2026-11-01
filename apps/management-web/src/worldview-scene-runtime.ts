import { parseGeoUri, searchCities, validatePoint } from "./worldview-core";
import type { DirectorKeyframe, GeoPoint } from "./worldview-core";
export function findLocalPlace(query: string): GeoPoint | null {
  const text = query.trim();
  if (/^geo:/i.test(text)) return parseGeoUri(text);
  if (/^[+\-\d.]+\s*,\s*[+\-\d.]+$/.test(text)) {
    const [lat, lon] = text.split(",").map(Number),
      point = { lat, lon };
    if (!validatePoint(point))
      throw new Error("Coordinate outside WGS84 bounds");
    return point;
  }
  return searchCities(text, 1)[0] ?? null;
}
export function directorAt(
  frames: readonly DirectorKeyframe[],
  timeMs: number,
): { center: GeoPoint; zoom: number } | null {
  if (!frames.length || !Number.isFinite(timeMs)) return null;
  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  const first = sorted[0],
    last = sorted.at(-1)!;
  if (timeMs <= first.atMs)
    return { center: { ...first.center }, zoom: first.zoom };
  if (timeMs >= last.atMs)
    return { center: { ...last.center }, zoom: last.zoom };
  const end = sorted.findIndex((f) => f.atMs >= timeMs),
    a = sorted[end - 1],
    b = sorted[end];
  const fraction = (timeMs - a.atMs) / (b.atMs - a.atMs || 1);
  const delta = ((b.center.lon - a.center.lon + 540) % 360) - 180;
  return {
    center: {
      lat: a.center.lat + (b.center.lat - a.center.lat) * fraction,
      lon: ((a.center.lon + delta * fraction + 540) % 360) - 180,
    },
    zoom: a.zoom + (b.zoom - a.zoom) * fraction,
  };
}
