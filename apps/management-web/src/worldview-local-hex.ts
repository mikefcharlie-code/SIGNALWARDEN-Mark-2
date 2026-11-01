import { cellArea, cellToBoundary, latLngToCell } from "h3-js";
import {
  validateObservation,
  type GeoPoint,
  type WorldObservation,
} from "./worldview-core";

export type LocalObservationProvenance = "user-supplied" | "synthetic";

export interface LocalHexCell {
  id: string;
  count: number;
  areaKm2: number;
  boundary: GeoPoint[];
  sources: string[];
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface LocalHexAggregation {
  cells: LocalHexCell[];
  pointCount: number;
  coverageKm2: number;
  resolution: number;
  provenance: LocalObservationProvenance;
}

const MAX_OBSERVATIONS = 5000;
const MIN_RESOLUTION = 0;
const MAX_RESOLUTION = 10;

function assertResolution(resolution: number): void {
  if (
    typeof resolution !== "number" ||
    !Number.isInteger(resolution) ||
    resolution < MIN_RESOLUTION ||
    resolution > MAX_RESOLUTION
  ) {
    throw new Error("resolution must be an integer from 0 through 10");
  }
}

function assertProvenance(
  provenance: LocalObservationProvenance,
): asserts provenance is LocalObservationProvenance {
  if (provenance !== "user-supplied" && provenance !== "synthetic") {
    throw new Error("provenance must be user-supplied or synthetic");
  }
}

function compareObservedAt(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || a.localeCompare(b);
}

/**
 * Aggregate caller-provided observations into occupied H3 cells.
 *
 * This function deliberately accepts no URL, fetcher, or network-backed source:
 * its only data input is the observation array supplied by the caller.
 */
export function aggregateLocalObservations(
  records: readonly WorldObservation[],
  resolution: number,
  provenance: LocalObservationProvenance,
): LocalHexAggregation {
  assertResolution(resolution);
  assertProvenance(provenance);
  if (!Array.isArray(records)) {
    throw new Error("records must be an array");
  }
  if (records.length > MAX_OBSERVATIONS) {
    throw new Error(`records cannot contain more than ${MAX_OBSERVATIONS} observations`);
  }
  for (const record of records) {
    if (!validateObservation(record)) {
      throw new Error("records contains an invalid observation");
    }
  }

  type Accumulator = {
    id: string;
    count: number;
    sources: Set<string>;
    firstObservedAt: string;
    lastObservedAt: string;
  };
  const byCell = new Map<string, Accumulator>();
  for (const record of records) {
    const id = latLngToCell(record.point.lat, record.point.lon, resolution);
    const current = byCell.get(id);
    if (current === undefined) {
      byCell.set(id, {
        id,
        count: 1,
        sources: new Set([record.source]),
        firstObservedAt: record.observedAt,
        lastObservedAt: record.observedAt,
      });
      continue;
    }
    current.count += 1;
    current.sources.add(record.source);
    if (compareObservedAt(record.observedAt, current.firstObservedAt) < 0) {
      current.firstObservedAt = record.observedAt;
    }
    if (compareObservedAt(record.observedAt, current.lastObservedAt) > 0) {
      current.lastObservedAt = record.observedAt;
    }
  }

  const cells = [...byCell.values()]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .map((cell): LocalHexCell => ({
      id: cell.id,
      count: cell.count,
      areaKm2: cellArea(cell.id, "km2"),
      boundary: cellToBoundary(cell.id).map(([lat, lon]) => ({ lat, lon })),
      sources: [...cell.sources].sort((a, b) => a.localeCompare(b)),
      firstObservedAt: cell.firstObservedAt,
      lastObservedAt: cell.lastObservedAt,
    }));

  return {
    cells,
    pointCount: records.length,
    coverageKm2: cells.reduce((total, cell) => total + cell.areaKm2, 0),
    resolution,
    provenance,
  };
}
