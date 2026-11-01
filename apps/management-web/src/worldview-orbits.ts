/* Local, read-only satellite geometry. No network, datasets, or visual-visibility claims. */
import * as satellite from "satellite.js";
import type { SatRec } from "satellite.js";

export type TleRecord = {
  name?: string;
  line1: string;
  line2: string;
  satrec: SatRec;
};
export type TleInput = TleRecord | string;
export type Observer = { lat: number; lon: number; altitudeKm?: number };
export type SatellitePosition = {
  at: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
};
export type PassPrediction = {
  rise: string;
  peak: string;
  set: string;
  maxElevationDeg: number;
  visibility: "not-assessed";
};

const MAX_HOURS = 24;
const SAMPLE_MS = 60_000;
const CROSSING_TOLERANCE_MS = 1_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function checksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68; i += 1) {
    const c = line[i];
    if (c >= "0" && c <= "9") sum += Number(c);
    else if (c === "-") sum += 1;
  }
  return sum % 10;
}
function validTleLine(line: string, number: string): boolean {
  return (
    line.length === 69 &&
    line[0] === number &&
    /^[0-9]$/.test(line[68]) &&
    checksum(line) === Number(line[68])
  );
}
function asTle(value: TleInput): TleRecord {
  if (typeof value === "string") return parseTle(value);
  if (
    !value ||
    typeof value !== "object" ||
    !validTleLine(value.line1, "1") ||
    !validTleLine(value.line2, "2")
  )
    throw new Error("Invalid TLE");
  return value;
}

/** Parse two checksum-validated TLE lines; an optional first name line is accepted. */
export function parseTle(text: string): TleRecord {
  if (typeof text !== "string" || text.length > 5000)
    throw new Error("Invalid TLE text");
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 3 && lines[0][0] !== "1") {
    const name = lines[0].trim();
    if (!name || name.length > 120) throw new Error("Invalid TLE name");
    lines.shift();
    const [line1, line2] = lines;
    if (!validTleLine(line1, "1") || !validTleLine(line2, "2"))
      throw new Error("Invalid TLE line or checksum");
    try {
      return {
        name,
        line1,
        line2,
        satrec: satellite.twoline2satrec(line1, line2),
      };
    } catch {
      throw new Error("Invalid TLE orbital elements");
    }
  }
  if (
    lines.length !== 2 ||
    !validTleLine(lines[0], "1") ||
    !validTleLine(lines[1], "2")
  )
    throw new Error("Invalid TLE line or checksum");
  try {
    return {
      line1: lines[0],
      line2: lines[1],
      satrec: satellite.twoline2satrec(lines[0], lines[1]),
    };
  } catch {
    throw new Error("Invalid TLE orbital elements");
  }
}

function propagated(tle: TleRecord, at: Date) {
  if (!validDate(at)) throw new Error("Invalid propagation time");
  const pv = satellite.propagate(tle.satrec, at);
  if (!pv || !pv.position || !Object.values(pv.position).every(finite))
    throw new Error("Satellite propagation failed");
  const gmst = satellite.gstime(at);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  if (
    ![geo.latitude, geo.longitude, geo.height].every(finite) ||
    !Object.values(ecf).every(finite)
  )
    throw new Error("Satellite propagation failed");
  return { ecf, geo };
}

export function satellitePosition(
  tleInput: TleInput,
  at: Date,
): SatellitePosition {
  const { geo } = propagated(asTle(tleInput), at);
  return {
    at: at.toISOString(),
    latitude: satellite.degreesLat(geo.latitude),
    longitude: satellite.degreesLong(geo.longitude),
    altitudeKm: geo.height,
  };
}

function observerCheck(observer: Observer): void {
  if (
    !observer ||
    !finite(observer.lat) ||
    observer.lat < -90 ||
    observer.lat > 90 ||
    !finite(observer.lon) ||
    observer.lon < -180 ||
    observer.lon > 180 ||
    (observer.altitudeKm !== undefined &&
      (!finite(observer.altitudeKm) ||
        observer.altitudeKm < -1 ||
        observer.altitudeKm > 100))
  )
    throw new Error("Invalid observer");
}
function elevation(tle: TleRecord, observer: Observer, at: Date): number {
  const { ecf } = propagated(tle, at);
  const look = satellite.ecfToLookAngles(
    {
      longitude: satellite.degreesToRadians(observer.lon),
      latitude: satellite.degreesToRadians(observer.lat),
      height: observer.altitudeKm ?? 0,
    },
    ecf,
  );
  const degrees = satellite.radiansToDegrees(look.elevation);
  if (!finite(degrees)) throw new Error("Invalid look angle");
  return degrees;
}
function crossing(
  tle: TleRecord,
  observer: Observer,
  a: Date,
  b: Date,
  threshold: number,
): Date {
  let lo = a.getTime();
  let hi = b.getTime();
  for (let i = 0; i < 20 && hi - lo > CROSSING_TOLERANCE_MS; i += 1) {
    const mid = new Date((lo + hi) / 2);
    if (elevation(tle, observer, mid) >= threshold) hi = mid.getTime();
    else lo = mid.getTime();
  }
  return new Date((lo + hi) / 2);
}

/** Predict geometric passes only; visual visibility is deliberately not assessed. */
export function predictPasses(
  tleInput: TleInput,
  observer: Observer,
  start: Date,
  hours = 24,
  minElevation = 10,
): PassPrediction[] {
  const tle = asTle(tleInput);
  observerCheck(observer);
  if (
    !validDate(start) ||
    !finite(hours) ||
    hours <= 0 ||
    hours > MAX_HOURS ||
    !finite(minElevation) ||
    minElevation < -90 ||
    minElevation > 90
  )
    throw new Error("Invalid prediction bounds");
  const endMs = start.getTime() + hours * 3_600_000;
  if (!Number.isSafeInteger(endMs))
    throw new Error("Invalid prediction bounds");
  const result: PassPrediction[] = [];
  let previous = start;
  let previousElevation = elevation(tle, observer, previous);
  let active = previousElevation >= minElevation;
  let rise = active ? start : undefined;
  let peak = active ? start : undefined;
  let maxElevation = active ? previousElevation : -Infinity;
  for (
    let cursorMs = start.getTime() + SAMPLE_MS;
    cursorMs <= endMs;
    cursorMs += SAMPLE_MS
  ) {
    const current = new Date(Math.min(cursorMs, endMs));
    const currentElevation = elevation(tle, observer, current);
    if (
      !active &&
      previousElevation < minElevation &&
      currentElevation >= minElevation
    ) {
      active = true;
      rise = crossing(tle, observer, previous, current, minElevation);
      peak = current;
      maxElevation = currentElevation;
    } else if (active) {
      if (currentElevation > maxElevation) {
        maxElevation = currentElevation;
        peak = current;
      }
      if (
        previousElevation >= minElevation &&
        currentElevation < minElevation
      ) {
        const set = crossing(tle, observer, previous, current, minElevation);
        result.push({
          rise: rise!.toISOString(),
          peak: peak!.toISOString(),
          set: set.toISOString(),
          maxElevationDeg: maxElevation,
          visibility: "not-assessed",
        });
        active = false;
        rise = undefined;
        peak = undefined;
        maxElevation = -Infinity;
      }
    }
    previous = current;
    previousElevation = currentElevation;
    if (cursorMs >= endMs) break;
  }
  return result;
}
