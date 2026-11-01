/**
 * WorldView GPS/GNSS interference layer from GPSJAM (https://gpsjam.org, John Wiseman).
 *
 * GPSJAM publishes one CSV per UTC day of H3 resolution-4 cells with the number of
 * aircraft that reported good vs. low navigation accuracy (ADS-B NIC/NACp) while
 * flying through each cell, built from airplanes.live and/or ADS-B Exchange data.
 * gpsjam.org sends no CORS headers, so the browser reads it only through the
 * disabled-by-default same-origin relay /api/v1/worldview-gpsjam
 * (UCAS_WORLDVIEW_GPSJAM_ENABLED=1, header X-SignalWarden-GpsJam: enabled).
 *
 * Honesty framing (shown in the panel and on the globe): an INFERRED, DAILY
 * indicator of possible GNSS interference from aircraft-reported accuracy. It does
 * not detect or locate jammers, is not real time and attributes no source.
 * Civilian situational awareness only. Nothing is requested until the operator opts in.
 */
import { cellToBoundary, cellToLatLng, latLngToCell } from "h3-js";
import type { GlobeBounds } from "./worldview-globe-viewport";

export const GPSJAM_RELAY = "/api/v1/worldview-gpsjam";
export const GPSJAM_RELAY_HEADER = "X-SignalWarden-GpsJam";
export const GPSJAM_SITE_URL = "https://gpsjam.org/";
export const GPSJAM_FAQ_URL = "https://gpsjam.org/faq/";
export const GPSJAM_ATTRIBUTION = "GPSJAM by John Wiseman (gpsjam.org); aircraft reports via airplanes.live and/or ADS-B Exchange";
export const GPSJAM_TERMS_NOTE =
  "gpsjam.org states no data licence and its ADS-B sources restrict redistribution/commercial use; reuse terms are unclear. Fetched on demand for your own viewing only; not bundled or persisted, with transient in-memory caches only.";
export const GPSJAM_DISCLOSURE =
  "Inferred indicator of possible GNSS interference, from the share of aircraft in each cell that reported low navigation accuracy over one UTC day. It is not a detection or location of jammers, not real time, and does not attribute a source; it can also reflect spoofing, aircraft manoeuvres or avionics issues. Blank areas mean no ADS-B coverage, not 'no interference'. Civilian situational awareness only.";
export const H3_RESOLUTION = 4;
/** Hard cap on hexes drawn on the globe at once (interference cells are kept first). */
export const MAX_DRAWN_CELLS = 5000;
export const MAX_RESPONSE_BYTES = 4_000_000;
export const DAY_CACHE_ENTRIES = 4;
/** GPSJAM's own default: a cell needs more than this many aircraft to be shown. */
export const DEFAULT_MIN_AIRCRAFT = 2;

/** GPSJAM thresholds (FAQ): low < 2 %, medium 2–<10 %, high ≥ 10 % of aircraft reporting low accuracy. */
export const GPSJAM_LEVELS = {
  good: { label: "Low", range: "0–2 %", color: [0x33, 0xff, 0x33] as const, hex: "#33ff33" },
  medium: { label: "Medium", range: "2–<10 %", color: [0xff, 0xff, 0x33] as const, hex: "#ffff33" },
  bad: { label: "High", range: "≥ 10 %", color: [0xff, 0x33, 0x33] as const, hex: "#ff3333" },
} as const;
export type GpsJamLevel = keyof typeof GPSJAM_LEVELS;

/** GPSJAM formula: (bad − 1) / (good + bad), the −1 suppressing single-aircraft false positives. Clamped at 0. */
export function percentBad(good: number, bad: number): number {
  const total = good + bad;
  if (!(total > 0)) return 0;
  return Math.max(0, (bad - 1) / total) * 100;
}
export function classify(good: number, bad: number): GpsJamLevel {
  const total = good + bad;
  const share = total > 0 ? (bad - 1) / total : 0;
  return share < 0.02 ? "good" : share < 0.1 ? "medium" : "bad";
}

// ---------------------------------------------------------------- relay transport
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type GpsJamOptions = { network: boolean; signal?: AbortSignal; timeoutMs?: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^84[0-9a-f]{13}$/;
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function allowedGpsJamUrl(url: string): boolean {
  return url === `${GPSJAM_RELAY}/status` || url === `${GPSJAM_RELAY}/manifest` ||
    (/^\/api\/v1\/worldview-gpsjam\/day\?date=\d{4}-\d{2}-\d{2}$/.test(url) && validDate(url.slice(-10)));
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw new Error("Relay response exceeds the size limit");
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).slice(0, max + 1);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > max) { await reader.cancel(); throw new Error("Relay response exceeds the size limit"); }
    chunks.push(part.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

export type GpsJamError = Error & { code?: string; status?: number; retryAfterSeconds?: number };
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

async function relayJson(url: string, options: GpsJamOptions, fetcher: Fetcher): Promise<unknown> {
  if (options.network !== true) throw new Error("GPSJAM requests are opt-in; enable the layer first");
  if (!allowedGpsJamUrl(url)) throw new Error("URL is not on the GPSJAM relay allowlist");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(45_000, options.timeoutMs ?? 30_000)));
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetcher(url, {
      method: "GET", headers: { Accept: "application/json", [GPSJAM_RELAY_HEADER]: "enabled" }, signal,
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", mode: "same-origin",
    });
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw Object.assign(new Error(`HTTP ${response.status}: invalid JSON from relay`), { status: response.status }); }
    if (!response.ok) {
      const err = obj(body) && obj(body.error) ? body.error : undefined;
      const code = str(err?.code, 60);
      const message = str(err?.message, 240) ?? `HTTP ${response.status}`;
      const details = obj(err?.details) ? err!.details as Record<string, unknown> : undefined;
      const retry = typeof details?.retryAfterSeconds === "number" ? details.retryAfterSeconds : undefined;
      throw Object.assign(new Error(code ? `${code}: ${message}` : message), { code, status: response.status, retryAfterSeconds: retry });
    }
    return body;
  } finally { clearTimeout(timer); }
}

/** Human-readable explanation for relay errors (disabled relay, throttling, missing date). */
export function describeError(e: unknown): string {
  const err = e as GpsJamError;
  if (err?.code === "gpsjam_relay_disabled" || (err?.status === 404 && !err.code))
    return "GPSJAM relay is disabled on the server (set UCAS_WORLDVIEW_GPSJAM_ENABLED=1 and restart the API).";
  if (err?.code === "relay_throttled" || err?.status === 429)
    return `GPSJAM relay throttled this request${err.retryAfterSeconds ? `; retry in ${err.retryAfterSeconds}s` : ""}.`;
  if (err?.code === "date_not_in_manifest" || err?.code === "provider_not_found") return "GPSJAM has no file for that date.";
  if ((err as Error)?.name === "AbortError") return "Request cancelled or timed out.";
  return (err instanceof Error ? err.message : String(e)).slice(0, 240);
}

// ---------------------------------------------------------------- parsing
export type ManifestEntry = Readonly<{ date: string; suspect: boolean; badHexes: number | null; source: string }>;
export type GpsJamManifest = Readonly<{
  provider: "gpsjam"; sourceUrl: string; retrievedAt: string; latest: string; earliest: string;
  dates: ReadonlyArray<ManifestEntry>; attribution: string; termsUrl: string; termsNote: string;
}>;
export type GpsJamDay = Readonly<{
  provider: "gpsjam"; date: string; source: string; sourceLabel: string; suspect: boolean; sourceUrl: string;
  retrievedAt: string; periodStart: string; cells: ReadonlyArray<readonly [string, number, number]>; skippedRows: number;
  attribution: string; termsUrl: string; termsNote: string; cache?: string;
}>;
const SOURCES = new Set(["adsbexchange", "airplaneslive", "merged"]);
const httpsUrl = (v: unknown, fallback: string) => (typeof v === "string" && /^https:\/\/gpsjam\.org\//.test(v) ? v : fallback);

export function parseManifestBody(body: unknown): GpsJamManifest {
  if (!obj(body) || body.provider !== "gpsjam" || !Array.isArray(body.dates)) throw new Error("Invalid GPSJAM manifest from relay");
  const dates: ManifestEntry[] = [];
  for (const d of body.dates.slice(0, 20_000)) {
    if (!obj(d) || !validDate(d.date) || typeof d.source !== "string" || !SOURCES.has(d.source)) continue;
    dates.push({ date: d.date, suspect: d.suspect === true, badHexes: Number.isInteger(d.badHexes) ? d.badHexes as number : null, source: d.source });
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  if (!dates.length) throw new Error("GPSJAM manifest listed no valid dates");
  return {
    provider: "gpsjam", sourceUrl: httpsUrl(body.sourceUrl, "https://gpsjam.org/data/manifest.csv"), retrievedAt: str(body.retrievedAt, 40) ?? "",
    latest: dates[dates.length - 1].date, earliest: dates[0].date, dates,
    attribution: GPSJAM_ATTRIBUTION, termsUrl: GPSJAM_FAQ_URL, termsNote: GPSJAM_TERMS_NOTE,
  };
}

export function parseDayBody(body: unknown, expectedDate?: string): GpsJamDay {
  if (!obj(body) || body.provider !== "gpsjam" || !validDate(body.date) || !Array.isArray(body.cells)) throw new Error("Invalid GPSJAM day from relay");
  if (expectedDate && body.date !== expectedDate) throw new Error("GPSJAM relay returned a different date");
  const cells: Array<readonly [string, number, number]> = [];
  let skipped = Number.isInteger(body.skippedRows) ? (body.skippedRows as number) : 0;
  const seen = new Set<string>();
  for (const c of body.cells.slice(0, 150_000)) {
    if (!Array.isArray(c) || typeof c[0] !== "string" || !HEX_RE.test(c[0]) || seen.has(c[0]) ||
        !Number.isInteger(c[1]) || !Number.isInteger(c[2]) || c[1] < 0 || c[2] < 0 || c[1] + c[2] === 0) { skipped++; continue; }
    seen.add(c[0]);
    cells.push([c[0], c[1], c[2]]);
  }
  return {
    provider: "gpsjam", date: body.date, source: str(body.source, 30) ?? "unknown", sourceLabel: str(body.sourceLabel, 120) ?? "unknown",
    suspect: body.suspect === true, sourceUrl: httpsUrl(body.sourceUrl, GPSJAM_SITE_URL), retrievedAt: str(body.retrievedAt, 40) ?? "",
    periodStart: `${body.date}T00:00:00Z`, cells, skippedRows: skipped,
    attribution: GPSJAM_ATTRIBUTION, termsUrl: GPSJAM_FAQ_URL, termsNote: GPSJAM_TERMS_NOTE, cache: str(body.cache, 10),
  };
}

// ---------------------------------------------------------------- client with per-date cache
/** Opt-in client. Manifest cached for 1 h, up to DAY_CACHE_ENTRIES days kept in memory (LRU). */
export class GpsJamClient {
  private manifestHit: { at: number; value: GpsJamManifest } | null = null;
  private days = new Map<string, PreparedDay>();
  private inflight = new Map<string, Promise<PreparedDay>>();
  constructor(private opts: { network: boolean; fetcher?: Fetcher; now?: () => number; manifestTtlMs?: number }) {}
  private now() { return this.opts.now?.() ?? Date.now(); }
  get cachedDates(): string[] { return [...this.days.keys()]; }

  async manifest(options: { signal?: AbortSignal; force?: boolean } = {}): Promise<GpsJamManifest> {
    const ttl = this.opts.manifestTtlMs ?? 3_600_000;
    if (!options.force && this.manifestHit && this.now() - this.manifestHit.at < ttl) return this.manifestHit.value;
    const body = await relayJson(`${GPSJAM_RELAY}/manifest`, { network: this.opts.network, signal: options.signal }, this.opts.fetcher ?? fetch);
    const value = parseManifestBody(body);
    this.manifestHit = { at: this.now(), value };
    return value;
  }

  async day(date: string, options: { signal?: AbortSignal } = {}): Promise<PreparedDay> {
    if (!validDate(date)) throw new Error("Date must be YYYY-MM-DD");
    const hit = this.days.get(date);
    if (hit) { this.days.delete(date); this.days.set(date, hit); return hit; }
    const pending = this.inflight.get(date);
    if (pending) return pending;
    const run = (async () => {
      const body = await relayJson(`${GPSJAM_RELAY}/day?date=${date}`, { network: this.opts.network, signal: options.signal }, this.opts.fetcher ?? fetch);
      const prepared = prepareDay(parseDayBody(body, date));
      this.days.set(date, prepared);
      while (this.days.size > DAY_CACHE_ENTRIES) this.days.delete(this.days.keys().next().value as string);
      return prepared;
    })();
    this.inflight.set(date, run);
    try { return await run; } finally { this.inflight.delete(date); }
  }
}

// ---------------------------------------------------------------- cells, viewport and globe state
export type GpsJamCell = Readonly<{ hex: string; lat: number; lon: number; good: number; bad: number; total: number; pct: number; level: GpsJamLevel }>;
export type PreparedDay = Readonly<{ day: GpsJamDay; cells: ReadonlyArray<GpsJamCell>; counts: Readonly<Record<GpsJamLevel, number>> }>;

export function prepareDay(day: GpsJamDay): PreparedDay {
  const counts: Record<GpsJamLevel, number> = { good: 0, medium: 0, bad: 0 };
  const cells: GpsJamCell[] = [];
  for (const [hex, good, bad] of day.cells) {
    let lat: number, lon: number;
    try { [lat, lon] = cellToLatLng(hex); } catch { continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const level = classify(good, bad);
    counts[level]++;
    cells.push({ hex, lat, lon, good, bad, total: good + bad, pct: percentBad(good, bad), level });
  }
  return { day, cells, counts };
}

const RANK: Record<GpsJamLevel, number> = { bad: 0, medium: 1, good: 2 };
export const inBounds = (bounds: readonly GlobeBounds[], lat: number, lon: number) =>
  !bounds.length || bounds.some((b) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east);

export type CellSelection = Readonly<{ drawn: GpsJamCell[]; inView: number; eligible: number; truncated: boolean; inViewCounts: Record<GpsJamLevel, number> }>;
/**
 * Viewport filter + hard cap. Cells need more than `minAircraft − 1` aircraft (GPSJAM default: ≥2).
 * Interference (high, then medium) is kept before low-interference cells, then by traffic, so a cap never
 * hides a red cell to draw a green one. Empty bounds = whole globe.
 */
export function selectCells(prepared: PreparedDay, bounds: readonly GlobeBounds[], opts: { minAircraft?: number; showLow?: boolean; cap?: number } = {}): CellSelection {
  const min = Math.max(1, Math.floor(opts.minAircraft ?? DEFAULT_MIN_AIRCRAFT));
  const cap = Math.max(0, Math.min(MAX_DRAWN_CELLS, Math.floor(opts.cap ?? MAX_DRAWN_CELLS)));
  const counts: Record<GpsJamLevel, number> = { good: 0, medium: 0, bad: 0 };
  const eligible: GpsJamCell[] = [];
  let inView = 0;
  for (const c of prepared.cells) {
    if (c.total < min || !inBounds(bounds, c.lat, c.lon)) continue;
    inView++;
    counts[c.level]++;
    if (c.level === "good" && opts.showLow === false) continue;
    eligible.push(c);
  }
  eligible.sort((a, b) => RANK[a.level] - RANK[b.level] || b.pct - a.pct || b.total - a.total || a.hex.localeCompare(b.hex));
  return { drawn: eligible.slice(0, cap), inView, eligible: eligible.length, truncated: eligible.length > cap, inViewCounts: counts };
}

export type GpsJamFreshness = "latest" | "stale" | "historical" | "unknown";
export type FreshnessInfo = Readonly<{ status: GpsJamFreshness; label: string; periodEndMs: number; ageMs: number; incomplete: boolean; detail: string }>;
/** Daily product: a UTC day is published soon after the following midnight UTC. */
export function dayFreshness(date: string, manifest: Pick<GpsJamManifest, "latest" | "dates"> | null, now: number): FreshnessInfo {
  const start = Date.parse(`${date}T00:00:00Z`);
  const end = start + 86_400_000;
  const ageMs = Math.max(0, now - end);
  const entry = manifest?.dates.find((d) => d.date === date);
  const incomplete = entry?.suspect === true;
  const hours = Math.round(ageMs / 3_600_000);
  if (!manifest || !Number.isFinite(start)) return { status: "unknown", label: "UNKNOWN", periodEndMs: end, ageMs, incomplete, detail: "No manifest loaded" };
  if (date !== manifest.latest) return { status: "historical", label: "HISTORICAL", periodEndMs: end, ageMs, incomplete, detail: `Archive day; newest available is ${manifest.latest}` };
  // Newest file should be at most ~1 day behind; >48 h after the day ended means GPSJAM has not published since.
  if (ageMs > 48 * 3_600_000) return { status: "stale", label: "STALE", periodEndMs: end, ageMs, incomplete, detail: `Newest GPSJAM day ended ${hours} h ago; no newer file published` };
  return { status: "latest", label: "LATEST DAILY", periodEndMs: end, ageMs, incomplete, detail: `Newest GPSJAM day (24 h aggregate) ended ${hours} h ago; not real time` };
}

export type GpsJamTooltip = Readonly<{ hex: string; good: number; bad: number; total: number; pct: number; level: GpsJamLevel; date: string }>;
export function tooltipText(t: GpsJamTooltip): string {
  return `${GPSJAM_LEVELS[t.level].label} · ${t.pct.toFixed(1)} % low accuracy (GPSJAM formula)\n` +
    `${t.bad} reporting low accuracy · ${t.good} good · ${t.total} aircraft total\n` +
    `H3 ${t.hex} · ${t.date} (UTC day) · inferred, not a jammer detection`;
}

/** Everything the globe needs to draw the GPSJAM layer; plain data so the globe chunk never loads h3-js. */
export type GpsJamGlobeState = Readonly<{
  key: string;
  date: string;
  /** Flat [lat0, lon0, lat1, lon1, ...] boundary per drawn cell; colour from level. */
  cells: ReadonlyArray<Readonly<{ hex: string; level: GpsJamLevel; boundary: ReadonlyArray<number> }>>;
  opacity: number;
  freshness: FreshnessInfo;
  truncated: boolean;
  drawnCount: number;
  inViewCount: number;
  sourceLabel: string;
  credit: Readonly<{ text: string; termsUrl: string; siteUrl: string }>;
  pick?: (lat: number, lon: number) => GpsJamTooltip | null;
  liveRow?: GpsJamLiveRow;
}>;
export type GpsJamLiveRow = Readonly<{ id: string; label: string; kind: "live-map"; status: "live" | "delayed" | "stale" | "unknown" | "failed"; ageMs: number | null; detail: string }>;

export function liveRowFor(date: string, freshness: FreshnessInfo, drawn: number): GpsJamLiveRow {
  const status = freshness.status === "latest" ? "delayed" : freshness.status === "stale" ? "stale" : "unknown";
  return { id: "live:gpsjam", label: "GPSJAM GNSS interference (daily)", kind: "live-map", status, ageMs: freshness.ageMs, detail: `${date} UTC day · ${drawn} cells drawn · ${freshness.detail}` };
}

export function buildGlobeState(prepared: PreparedDay, selection: CellSelection, manifest: GpsJamManifest | null, opts: { opacity: number; now: number }): GpsJamGlobeState {
  const date = prepared.day.date;
  const freshness = dayFreshness(date, manifest, opts.now);
  const cells = selection.drawn.map((c) => {
    const boundary: number[] = [];
    for (const [lat, lon] of cellToBoundary(c.hex)) boundary.push(lat, lon);
    return { hex: c.hex, level: c.level, boundary };
  });
  const byHex = new Map(selection.drawn.map((c) => [c.hex, c]));
  const pick = (lat: number, lon: number): GpsJamTooltip | null => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
    let hex: string;
    try { hex = latLngToCell(lat, lon, H3_RESOLUTION); } catch { return null; }
    const c = byHex.get(hex);
    return c ? { hex, good: c.good, bad: c.bad, total: c.total, pct: c.pct, level: c.level, date } : null;
  };
  return {
    key: `${date}|${opts.opacity}|${selection.drawn.length}|${selection.drawn[0]?.hex ?? ""}|${selection.drawn[selection.drawn.length - 1]?.hex ?? ""}`,
    date, cells, opacity: opts.opacity, freshness, truncated: selection.truncated, drawnCount: cells.length, inViewCount: selection.inView,
    sourceLabel: prepared.day.sourceLabel,
    credit: { text: GPSJAM_ATTRIBUTION, termsUrl: GPSJAM_FAQ_URL, siteUrl: GPSJAM_SITE_URL },
    pick, liveRow: liveRowFor(date, freshness, cells.length),
  };
}

export const formatAge = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} d`);
