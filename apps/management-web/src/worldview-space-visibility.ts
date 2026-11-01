/*
 * Local, read-only visual-visibility FORECASTS for satellites.
 *
 * Everything here is a computed prediction from orbital elements (SGP4), a
 * low-precision solar ephemeris and a conical Earth-shadow model. Nothing in
 * this module is an observation or a sighting. No network access.
 */
import * as satellite from "satellite.js";
import type { SatRec } from "satellite.js";

export type Observer = { lat: number; lon: number; altitudeKm?: number };
export type TwilightPhase =
  | "day"
  | "civil-twilight"
  | "nautical-twilight"
  | "astronomical-twilight"
  | "night";
export type Illumination = "sunlit" | "penumbra" | "umbra";
export type ElementAgeStatus = "current" | "aging" | "old" | "too-old" | "future-epoch";

export type LookPoint = {
  time: string;
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
  sunElevationDeg: number;
  illumination: Illumination;
  /** Fraction of the solar disk visible from the satellite (0..1). */
  sunlitFraction: number;
  phaseAngleDeg: number;
  magnitude: number | null;
};

export type VisibleSegment = {
  start: LookPoint;
  max: LookPoint;
  end: LookPoint;
  brightest: LookPoint;
  durationSeconds: number;
};

/** visible | daylight (sky never dark enough) | eclipsed (satellite in Earth's umbra whenever the sky is dark). */
export type VisibilityVerdict = "visible" | "daylight" | "eclipsed";

export type VisibilityPass = {
  kind: "forecast";
  rise: LookPoint;
  culmination: LookPoint;
  set: LookPoint;
  maxElevationDeg: number;
  verdict: VisibilityVerdict;
  /** Longest visible segment (satellite sunlit, observer sky dark enough, elevation >= threshold). */
  visible: VisibleSegment | null;
  visibleSegments: VisibleSegment[];
  twilightAtCulmination: TwilightPhase;
  magnitudeNote: string;
  uncertainty: ElementUncertainty;
};

export type ElementUncertainty = {
  elementEpoch: string;
  elementAgeDays: number;
  status: ElementAgeStatus;
  /** Rough along-track position uncertainty (heuristic, LEO). */
  alongTrackKm: number;
  /** Rough timing uncertainty implied by the along-track error. */
  timingSeconds: number;
  note: string;
};

export type VisibilityOptions = {
  hours?: number;
  /** Satellite must be at least this high for a segment to count (default 10). */
  minElevationDeg?: number;
  /** Observer sun elevation must be at or below this (default -6, civil dusk). */
  maxSunElevationDeg?: number;
  /** Standard magnitude at 1000 km range, 50% illuminated (McCants convention). */
  standardMagnitude?: number | null;
  /** Refuse forecasts from elements older than this many days (default 14). */
  maxElementAgeDays?: number;
  noradId?: number | string;
};

export const VISIBILITY_DEFAULTS = Object.freeze({
  hours: 48,
  maxHours: 72,
  minElevationDeg: 10,
  maxSunElevationDeg: -6,
  maxElementAgeDays: 14,
  scanSeconds: 30,
  segmentStepSeconds: 5,
});

/**
 * Standard (intrinsic) magnitudes at 1000 km and 50% illumination.
 * Only entries with a documented public value; everything else is "unknown".
 */
export const STANDARD_MAGNITUDES: Readonly<Record<string, { mag: number; source: string }>> =
  Object.freeze({
    "25544": {
      mag: -1.8,
      source: "ISS standard magnitude -1.8 at 1000 km, 50% illuminated (Heavens-Above/McCants convention)",
    },
  });

const DEG = Math.PI / 180;
const AU_KM = 149_597_870.7;
const EARTH_RADIUS_KM = 6378.137;
const SUN_RADIUS_KM = 696_000;

type Vec = { x: number; y: number; z: number };
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: Vec) => Math.sqrt(dot(a, a));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Julian date (UTC) of a JS Date. */
export function julianDate(at: Date): number {
  return at.getTime() / 86_400_000 + 2440587.5;
}

/**
 * Low-precision geocentric Sun vector (km) in the equatorial frame of date
 * (Astronomical Almanac formulae, ~0.01° 1950-2050). Close enough to TEME for
 * shadow and twilight classification.
 */
export function sunEci(at: Date): Vec {
  const n = julianDate(at) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const r = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM;
  return {
    x: r * Math.cos(lambda),
    y: r * Math.cos(eps) * Math.sin(lambda),
    z: r * Math.sin(eps) * Math.sin(lambda),
  };
}

function observerGeodetic(o: Observer) {
  return {
    latitude: o.lat * DEG,
    longitude: o.lon * DEG,
    height: o.altitudeKm ?? 0,
  };
}

/** Observer-local Sun elevation (degrees, geometric, no refraction). */
export function sunElevationDeg(observer: Observer, at: Date): number {
  const gmst = satellite.gstime(at);
  const sunEcf = satellite.eciToEcf(sunEci(at), gmst);
  return satellite.ecfToLookAngles(observerGeodetic(observer), sunEcf).elevation / DEG;
}

export function twilightPhase(sunElevation: number): TwilightPhase {
  if (sunElevation > -0.833) return "day";
  if (sunElevation > -6) return "civil-twilight";
  if (sunElevation > -12) return "nautical-twilight";
  if (sunElevation > -18) return "astronomical-twilight";
  return "night";
}

/**
 * Conical umbra/penumbra model (Montenbruck & Gill 3.4.2): fraction of the
 * solar disk visible from a satellite at `sat` (km, geocentric) with the Sun
 * at `sun` (km, geocentric). Spherical Earth; no atmosphere.
 */
export function sunlitFraction(sat: Vec, sun: Vec): number {
  const toSun = sub(sun, sat);
  const toEarth = { x: -sat.x, y: -sat.y, z: -sat.z };
  const dSun = norm(toSun);
  const dEarth = norm(toEarth);
  if (dEarth <= EARTH_RADIUS_KM) return 0;
  const a = Math.asin(clamp(SUN_RADIUS_KM / dSun, -1, 1));
  const b = Math.asin(clamp(EARTH_RADIUS_KM / dEarth, -1, 1));
  const c = Math.acos(clamp(dot(toSun, toEarth) / (dSun * dEarth), -1, 1));
  if (c >= a + b) return 1;
  if (c <= b - a) return 0; // umbra
  if (c <= a - b) return 1 - (b * b) / (a * a); // annular (not reachable near Earth)
  const x = (c * c + a * a - b * b) / (2 * c);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const area =
    a * a * Math.acos(clamp(x / a, -1, 1)) +
    b * b * Math.acos(clamp((c - x) / b, -1, 1)) -
    c * y;
  return clamp(1 - area / (Math.PI * a * a), 0, 1);
}

/**
 * Apparent visual magnitude from a standard magnitude (1000 km, 50% lit),
 * range and phase angle (McCants: m = m0 - 15.75 + 2.5 log10(r^2 / f),
 * f = (1 + cos phase) / 2). Penumbra dims by the visible solar fraction.
 * No atmospheric extinction is applied.
 */
export function apparentMagnitude(
  standardMagnitude: number,
  rangeKm: number,
  phaseAngleDeg: number,
  sunFraction = 1,
): number | null {
  if (!finite(standardMagnitude) || !finite(rangeKm) || rangeKm <= 0) return null;
  const fracil = (1 + Math.cos(phaseAngleDeg * DEG)) / 2;
  if (fracil < 1e-4 || sunFraction <= 0) return null;
  const m =
    standardMagnitude - 15.75 + 2.5 * Math.log10((rangeKm * rangeKm) / fracil) - 2.5 * Math.log10(sunFraction);
  return Math.round(m * 10) / 10;
}

export function elementEpoch(satrec: SatRec): Date {
  return new Date((satrec.jdsatepoch - 2440587.5) * 86_400_000);
}

/**
 * Element-age uncertainty. Heuristic only: general-perturbations elements are
 * typically ~1 km at epoch with along-track error growing on the order of
 * 1-3 km/day for LEO; more during high solar activity or for low perigees.
 */
export function elementUncertainty(
  satrec: SatRec,
  at: Date,
  maxAgeDays: number = VISIBILITY_DEFAULTS.maxElementAgeDays,
): ElementUncertainty {
  const epoch = elementEpoch(satrec);
  const ageDays = (at.getTime() - epoch.getTime()) / 86_400_000;
  const absAge = Math.abs(ageDays);
  const status: ElementAgeStatus =
    ageDays < -1
      ? "future-epoch"
      : absAge > maxAgeDays
        ? "too-old"
        : absAge > 7
          ? "old"
          : absAge > 3
            ? "aging"
            : "current";
  const alongTrackKm = Math.round((1 + 2 * absAge) * 10) / 10;
  // LEO orbital speed ~7.5 km/s; use mean motion for a better per-object figure.
  const nRadPerMin = satrec.no;
  const aKm = finite(nRadPerMin) && nRadPerMin > 0 ? Math.cbrt(398600.4418 / (nRadPerMin / 60) ** 2) : 6778;
  const speed = Math.sqrt(398600.4418 / aKm);
  const timingSeconds = Math.round((alongTrackKm / speed) * 10) / 10;
  const note =
    status === "too-old"
      ? `Elements are ${absAge.toFixed(1)} days old (limit ${maxAgeDays}); visibility forecast refused. Refresh the catalog.`
      : status === "future-epoch"
        ? "Element epoch is in the future; check the source and observer clock."
        : `Elements ${absAge.toFixed(1)} days old; rough along-track uncertainty ~${alongTrackKm} km (~${timingSeconds} s timing). Heuristic for LEO; can be several times larger near high solar activity or low perigee.${status === "old" ? " Low confidence: elements are over a week old." : status === "aging" ? " Elements are aging; refresh when possible." : ""}`;
  return {
    elementEpoch: epoch.toISOString(),
    elementAgeDays: Math.round(ageDays * 100) / 100,
    status,
    alongTrackKm,
    timingSeconds,
    note,
  };
}

function validDate(d: Date) {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function checkObserver(o: Observer) {
  if (
    !o ||
    !finite(o.lat) ||
    Math.abs(o.lat) > 90 ||
    !finite(o.lon) ||
    Math.abs(o.lon) > 180 ||
    (o.altitudeKm !== undefined && (!finite(o.altitudeKm) || o.altitudeKm < -1 || o.altitudeKm > 100))
  )
    throw new Error("Invalid observer");
}

type Ctx = {
  satrec: SatRec;
  observer: Observer;
  standardMagnitude: number | null;
};

/** Full topocentric state at one instant (forecast). */
export function lookAt(ctx: Ctx, at: Date): LookPoint {
  const pv = satellite.propagate(ctx.satrec, at);
  const pos = pv && pv.position;
  if (!pos || typeof pos === "boolean" || ![pos.x, pos.y, pos.z].every(finite))
    throw new Error("Satellite propagation failed");
  const gmst = satellite.gstime(at);
  const gd = observerGeodetic(ctx.observer);
  const satEcf = satellite.eciToEcf(pos, gmst);
  const look = satellite.ecfToLookAngles(gd, satEcf);
  const sun = sunEci(at);
  const sunEcf = satellite.eciToEcf(sun, gmst);
  const sunLook = satellite.ecfToLookAngles(gd, sunEcf);
  const obsEci = satellite.ecfToEci(satellite.geodeticToEcf(gd), gmst);
  const fraction = sunlitFraction(pos, sun);
  const satToSun = sub(sun, pos);
  const satToObs = sub(obsEci, pos);
  const phase = Math.acos(clamp(dot(satToSun, satToObs) / (norm(satToSun) * norm(satToObs)), -1, 1)) / DEG;
  const illumination: Illumination = fraction <= 0 ? "umbra" : fraction < 1 ? "penumbra" : "sunlit";
  const magnitude =
    ctx.standardMagnitude === null || fraction <= 0
      ? null
      : apparentMagnitude(ctx.standardMagnitude, look.rangeSat, phase, fraction);
  return {
    time: at.toISOString(),
    azimuthDeg: Math.round((look.azimuth / DEG) * 10) / 10,
    elevationDeg: Math.round((look.elevation / DEG) * 100) / 100,
    rangeKm: Math.round(look.rangeSat * 10) / 10,
    sunElevationDeg: Math.round((sunLook.elevation / DEG) * 100) / 100,
    illumination,
    sunlitFraction: Math.round(fraction * 1000) / 1000,
    phaseAngleDeg: Math.round(phase * 10) / 10,
    magnitude,
  };
}

function elevationOnly(ctx: Ctx, at: Date): number {
  const pv = satellite.propagate(ctx.satrec, at);
  const pos = pv && pv.position;
  if (!pos || typeof pos === "boolean" || ![pos.x, pos.y, pos.z].every(finite))
    throw new Error("Satellite propagation failed");
  const look = satellite.ecfToLookAngles(observerGeodetic(ctx.observer), satellite.eciToEcf(pos, satellite.gstime(at)));
  return look.elevation / DEG;
}

function bisect(lo: number, hi: number, inside: (ms: number) => boolean, loInside: boolean): number {
  // Returns the transition instant between lo (state loInside) and hi (state !loInside), ~0.5 s.
  for (let i = 0; i < 30 && hi - lo > 500; i += 1) {
    const mid = (lo + hi) / 2;
    if (inside(mid) === loInside) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Forecast passes over an observer with a visual-visibility assessment.
 * A segment is "visible" only when the satellite is sunlit (not in umbra),
 * the observer's Sun is at or below `maxSunElevationDeg`, and the satellite
 * is at or above `minElevationDeg`.
 */
export function forecastVisibility(
  satrec: SatRec,
  observer: Observer,
  start: Date,
  options: VisibilityOptions = {},
): { passes: VisibilityPass[]; uncertainty: ElementUncertainty; refused?: string } {
  checkObserver(observer);
  const hours = options.hours ?? VISIBILITY_DEFAULTS.hours;
  const minEl = options.minElevationDeg ?? VISIBILITY_DEFAULTS.minElevationDeg;
  const maxSun = options.maxSunElevationDeg ?? VISIBILITY_DEFAULTS.maxSunElevationDeg;
  const maxAge = options.maxElementAgeDays ?? VISIBILITY_DEFAULTS.maxElementAgeDays;
  if (
    !validDate(start) ||
    !finite(hours) ||
    hours <= 0 ||
    hours > VISIBILITY_DEFAULTS.maxHours ||
    !finite(minEl) ||
    minEl < 0 ||
    minEl > 89 ||
    !finite(maxSun) ||
    maxSun > 0 ||
    maxSun < -30 ||
    !finite(maxAge) ||
    maxAge <= 0 ||
    maxAge > 60
  )
    throw new Error("Invalid visibility forecast bounds");
  const uncertainty = elementUncertainty(satrec, start, maxAge);
  if (uncertainty.status === "too-old" || uncertainty.status === "future-epoch")
    return { passes: [], uncertainty, refused: uncertainty.note };

  const key = options.noradId !== undefined ? String(options.noradId) : String(satrec.satnum ?? "").replace(/^0+/, "");
  const known = STANDARD_MAGNITUDES[key];
  const standardMagnitude =
    options.standardMagnitude !== undefined && options.standardMagnitude !== null && finite(options.standardMagnitude)
      ? options.standardMagnitude
      : known
        ? known.mag
        : null;
  const magnitudeNote =
    standardMagnitude === null
      ? "magnitude unknown (no standard magnitude for this object)"
      : options.standardMagnitude !== undefined && options.standardMagnitude !== null
        ? `estimated from user-supplied standard magnitude ${standardMagnitude}; no atmospheric extinction`
        : `estimated from ${known!.source}; no atmospheric extinction`;
  const ctx: Ctx = { satrec, observer, standardMagnitude };

  const startMs = start.getTime();
  const endMs = startMs + hours * 3_600_000;
  const scanMs = VISIBILITY_DEFAULTS.scanSeconds * 1000;
  const above = (ms: number) => elevationOnly(ctx, new Date(ms)) >= minEl;
  const passes: VisibilityPass[] = [];
  let prevMs = startMs;
  let prevAbove = above(prevMs);
  let riseMs: number | undefined = prevAbove ? startMs : undefined;
  for (let t = startMs + scanMs; t <= endMs + scanMs && passes.length < 200; t += scanMs) {
    const ms = Math.min(t, endMs);
    const now = above(ms);
    if (!prevAbove && now) riseMs = bisect(prevMs, ms, above, false);
    if (prevAbove && !now && riseMs !== undefined) {
      const setMs = bisect(prevMs, ms, above, true);
      passes.push(assessPass(ctx, riseMs, setMs, minEl, maxSun, magnitudeNote, uncertainty));
      riseMs = undefined;
    }
    prevMs = ms;
    prevAbove = now;
    if (ms >= endMs) break;
  }
  return { passes, uncertainty };
}

function assessPass(
  ctx: Ctx,
  riseMs: number,
  setMs: number,
  minEl: number,
  maxSun: number,
  magnitudeNote: string,
  uncertainty: ElementUncertainty,
): VisibilityPass {
  const step = VISIBILITY_DEFAULTS.segmentStepSeconds * 1000;
  const samples: { ms: number; p: LookPoint; ok: boolean }[] = [];
  const isVisible = (p: LookPoint) =>
    p.illumination !== "umbra" && p.sunElevationDeg <= maxSun && p.elevationDeg >= minEl;
  const at = (ms: number) => lookAt(ctx, new Date(ms));
  for (let ms = riseMs; ms < setMs; ms += step) {
    const p = at(ms);
    samples.push({ ms, p, ok: isVisible(p) });
  }
  const last = at(setMs);
  samples.push({ ms: setMs, p: last, ok: isVisible(last) });
  let culm = samples[0];
  for (const s of samples) if (s.p.elevationDeg > culm.p.elevationDeg) culm = s;
  // Refine culmination by golden-section style local search (±step).
  let lo = Math.max(riseMs, culm.ms - step),
    hi = Math.min(setMs, culm.ms + step);
  for (let i = 0; i < 25 && hi - lo > 200; i += 1) {
    const m1 = lo + (hi - lo) / 3,
      m2 = hi - (hi - lo) / 3;
    if (elevationOnly(ctx, new Date(m1)) < elevationOnly(ctx, new Date(m2))) lo = m1;
    else hi = m2;
  }
  const culmination = at((lo + hi) / 2);

  const segments: VisibleSegment[] = [];
  const visibleAt = (ms: number) => isVisible(at(ms));
  let segStart: number | undefined = samples[0].ok ? samples[0].ms : undefined;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1],
      cur = samples[i];
    if (!prev.ok && cur.ok) segStart = bisect(prev.ms, cur.ms, visibleAt, false);
    if (prev.ok && !cur.ok && segStart !== undefined) {
      segments.push(buildSegment(ctx, samples, segStart, bisect(prev.ms, cur.ms, visibleAt, true)));
      segStart = undefined;
    }
  }
  if (segStart !== undefined) segments.push(buildSegment(ctx, samples, segStart, setMs));
  const visible = segments.reduce<VisibleSegment | null>(
    (best, s) => (!best || s.durationSeconds > best.durationSeconds ? s : best),
    null,
  );
  const anyDark = samples.some((s) => s.p.sunElevationDeg <= maxSun);
  const verdict: VisibilityVerdict = visible ? "visible" : anyDark ? "eclipsed" : "daylight";
  return {
    kind: "forecast",
    rise: at(riseMs),
    culmination,
    set: last,
    maxElevationDeg: culmination.elevationDeg,
    verdict,
    visible,
    visibleSegments: segments,
    twilightAtCulmination: twilightPhase(culmination.sunElevationDeg),
    magnitudeNote,
    uncertainty,
  };
}

function buildSegment(
  ctx: Ctx,
  samples: { ms: number; p: LookPoint; ok: boolean }[],
  startMs: number,
  endMs: number,
): VisibleSegment {
  const start = lookAt(ctx, new Date(startMs));
  const end = lookAt(ctx, new Date(endMs));
  const inside = [start, ...samples.filter((s) => s.ms > startMs && s.ms < endMs).map((s) => s.p), end];
  let max = inside[0];
  for (const p of inside) if (p.elevationDeg > max.elevationDeg) max = p;
  let brightest = inside[0];
  for (const p of inside)
    if (p.magnitude !== null && (brightest.magnitude === null || p.magnitude < brightest.magnitude)) brightest = p;
  if (brightest.magnitude === null) brightest = max;
  return {
    start,
    max,
    end,
    brightest,
    durationSeconds: Math.round((endMs - startMs) / 1000),
  };
}

/** SGP4 forecast sub-satellite point (not an observation). */
export function forecastPosition(satrec: SatRec, at: Date): { latitude: number; longitude: number; altitudeKm: number } | null {
  const pv = satellite.propagate(satrec, at);
  const pos = pv && pv.position;
  if (!pos || typeof pos === "boolean" || ![pos.x, pos.y, pos.z].every(finite)) return null;
  const geo = satellite.eciToGeodetic(pos, satellite.gstime(at));
  const latitude = satellite.degreesLat(geo.latitude);
  const longitude = satellite.degreesLong(geo.longitude);
  if (![latitude, longitude, geo.height].every(finite)) return null;
  return { latitude, longitude, altitudeKm: geo.height };
}
