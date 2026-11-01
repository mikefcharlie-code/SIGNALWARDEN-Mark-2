import booleanIntersects from "@turf/boolean-intersects";
import distance from "@turf/distance";
import { lineString, point, polygon } from "@turf/helpers";
import type { GeoPoint, WorldObservation } from "./worldview-core";

export type SpatialBounds = { south: number; west: number; north: number; east: number };
export type SpatialRecord = Pick<WorldObservation, "id" | "point" | "label" | "source" | "freshness">;
export type SpatialMatch = { id: string; label: string; source: string; distanceKm: number; intersects: boolean };
export type SpatialAnalysis = {
  distanceKm: number | null;
  selectedIntersects: boolean | null;
  routeIntersects: boolean | null;
  routeStatus: "available" | "not-requested" | "rejected-antimeridian" | "rejected-polar";
  bounds: SpatialBounds;
  matches: SpatialMatch[];
  excludedCount: number;
};

/** Maximum number of records accepted by the bounded spatial query. */
export const MAX_SPATIAL_RECORDS = 5000;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validPoint = (value: unknown): value is GeoPoint => {
  if (!value || typeof value !== "object") return false;
  const p = value as GeoPoint;
  return finite(p.lat) && finite(p.lon) && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
};

/** Build a Turf polygon for a non-dateline-crossing, non-polar rectangle. */
export function createSpatialRectangle(bounds: SpatialBounds): ReturnType<typeof polygon> {
  if (![bounds.south, bounds.west, bounds.north, bounds.east].every(finite))
    throw new Error("Rectangle bounds must be finite coordinates");
  if (bounds.south <= -90 || bounds.north >= 90)
    throw new Error("Rectangle bounds may not include a pole (unsupported ambiguity)");
  if (bounds.south >= bounds.north) throw new Error("Rectangle south must be less than north");
  if (bounds.west < -180 || bounds.east > 180 || bounds.west >= bounds.east)
    throw new Error("Rectangle must be bounded west-to-east and may not cross the date line");
  if (bounds.east - bounds.west >= 180)
    throw new Error("Rectangle longitude width must be less than 180 degrees");
  const ring: Array<[number, number]> = [
    [bounds.west, bounds.south], [bounds.east, bounds.south],
    [bounds.east, bounds.north], [bounds.west, bounds.north], [bounds.west, bounds.south],
  ];
  return polygon([ring]);
}

export function isSpatiallyEligible(record: Pick<WorldObservation, "freshness" | "source"> | null | undefined): boolean {
  // Live/provider observations are deliberately excluded. Only explicitly synthetic/local records enter this advisory tool.
  if (!record || record.freshness !== "synthetic" || typeof record.source !== "string") return false;
  const source = record.source.trim().toLowerCase();
  return /^(?:signalwarden synthetic (?:demo|replay)(?:\s|$)|synthetic(?:\s|$)|local synthetic(?:\s|$)|demo synthetic(?:\s|$)|imported synthetic(?:\s|$))/.test(source);
}

export function analyzeSpatial(
  center: GeoPoint,
  selected: GeoPoint | null,
  bounds: SpatialBounds,
  records: readonly SpatialRecord[] = [],
  includeRoute = true,
): SpatialAnalysis {
  if (!validPoint(center)) throw new Error("Center must contain finite latitude and longitude");
  if (records.length > MAX_SPATIAL_RECORDS)
    throw new Error(`Spatial query accepts at most ${MAX_SPATIAL_RECORDS} records`);
  const rectangle = createSpatialRectangle(bounds);
  const centerFeature = point([center.lon, center.lat]);
  if (selected !== null && !validPoint(selected))
    throw new Error("Selected coordinate must contain finite latitude and longitude");
  const distanceKm = selected
    ? distance(centerFeature, point([selected.lon, selected.lat]), { units: "kilometers" })
    : null;
  const selectedIntersects = selected
    ? booleanIntersects(point([selected.lon, selected.lat]), rectangle)
    : null;

  let routeStatus: SpatialAnalysis["routeStatus"] = "not-requested";
  let routeIntersects: boolean | null = null;
  if (includeRoute && selected) {
    if (Math.abs(selected.lon - center.lon) >= 180) routeStatus = "rejected-antimeridian";
    else if (Math.abs(selected.lat) === 90 || Math.abs(center.lat) === 90) routeStatus = "rejected-polar";
    else {
      const route = lineString([[center.lon, center.lat], [selected.lon, selected.lat]]);
      routeIntersects = booleanIntersects(route, rectangle);
      routeStatus = "available";
    }
  }

  let excludedCount = 0;
  const matches = records.flatMap((record) => {
    if (!isSpatiallyEligible(record) || !validPoint(record.point)) { excludedCount += 1; return []; }
    const feature = point([record.point.lon, record.point.lat]);
    if (!booleanIntersects(feature, rectangle)) return [];
    return [{
      id: record.id,
      label: record.label || record.id,
      source: record.source,
      distanceKm: distance(centerFeature, feature, { units: "kilometers" }),
      intersects: true,
    }];
  }).sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));

  return { distanceKm, selectedIntersects, routeIntersects, routeStatus, bounds, matches, excludedCount };
}

export type SpatialRoute = ReturnType<typeof lineString>;
export { point, lineString };
