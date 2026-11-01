/* WorldView transit, street imagery and context feeds (read-only client).
 * Every request goes only to the disabled-by-default, same-origin relay at
 * /api/v1/worldview-mobility, which holds provider keys server-side, enforces
 * a host allowlist, bounds, throttles and caches, and returns normalized
 * metadata. Nothing here is requested until the panel is opened, the user
 * opts in and presses a button. No keys, no bundled provider data, no stream
 * relay, no face/plate/identity processing and no control paths exist here.
 */
import type { Freshness, GeoPoint, Primitive, ProviderResult, WorldObservation } from "./worldview-core";
import { validatePoint } from "./worldview-core";

export const MOBILITY_RELAY_PREFIX = "/api/v1/worldview-mobility";
export const MOBILITY_HEADER = "X-SignalWarden-Mobility";
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;
const MAX_ITEMS = 500;

export const MOBILITY_ROUTES = ["status", "gbfs", "gtfs-rt", "street-imagery", "geocode", "radio", "news", "infrastructure"] as const;
export type MobilityRoute = (typeof MOBILITY_ROUTES)[number];
export type StreetProvider = "mapillary" | "panoramax" | "kartaview";
export const STREET_PROVIDERS: readonly StreetProvider[] = ["mapillary", "panoramax", "kartaview"];

/** Server-side limits mirrored for UI validation; the relay enforces them independently. */
export const MOBILITY_LIMITS = Object.freeze({
  gbfsMaxSpanDeg: 1,
  gtfsMaxSpanDeg: 2,
  infrastructureMaxSpanDeg: 1,
  streetRadiusM: [10, 500] as const,
  radioRadiusKm: [1, 100] as const,
});

/** Layer ids for normalized observations (extra layers; shown unless toggled off). */
export const MOBILITY_LAYERS = Object.freeze({
  station: "bikeshare",
  vehicle: "bikeshare",
  "transit-vehicle": "transit",
  "street-image": "street-imagery",
  place: "places",
  "radio-station": "radio",
  "news-link": "news",
  datacenter: "infrastructure",
  dam: "infrastructure",
} as const);
type ItemKind = keyof typeof MOBILITY_LAYERS;
const isKind = (v: unknown): v is ItemKind => typeof v === "string" && Object.hasOwn(MOBILITY_LAYERS, v);

export type MobilityStatus = "live" | "stale" | "throttled" | "failed" | "not_configured" | "disabled";
export interface MobilityItem {
  id: string;
  kind: ItemKind;
  label: string;
  point?: GeoPoint;
  providerTimestamp?: string;
  ageSeconds?: number;
  freshness: Freshness;
  properties: Record<string, Primitive>;
}
export interface MobilityResult extends ProviderResult {
  route: MobilityRoute;
  status: MobilityStatus;
  providerName: string;
  attribution: string;
  license?: string;
  licenseUrl?: string;
  termsUrl?: string;
  sourceUrl?: string;
  providerTimestamp?: string;
  ageSeconds?: number;
  notice?: string;
  truncated: boolean;
  cached: boolean;
  items: MobilityItem[];
}
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface MobilityOptions {
  network?: boolean;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  now?: () => number;
}
export interface FeedSummary {
  id: string;
  name: string;
  attribution?: string;
  termsUrl?: string;
  status: string;
  keyEnv?: string | null;
}
export interface MobilityRelayStatus {
  enabled: boolean;
  gbfs: FeedSummary[];
  gtfsRealtime: FeedSummary[];
  streetImagery: Record<StreetProvider, string>;
  geocoder: string;
  contactConfigured: boolean;
}
export type Bbox = { west: number; south: number; east: number; north: number };

export class MobilityRelayError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, limit = 200): string | undefined => {
  if (typeof v !== "string") return undefined;
  // Drop control characters (C0, DEL, C1) without a control-char regex literal.
  const t = Array.from(v).filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && (c < 127 || c > 159); }).join("").trim().slice(0, limit);
  return t || undefined;
};
const isoOrUndefined = (v: unknown): string | undefined => {
  const s = str(v, 40);
  return s && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : undefined;
};

/** Links are rendered only if http(s) and credential-free; http only where a provider gives nothing better (homepages, articles). */
export function safeLink(value: unknown, allowHttp = false): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const u = new URL(value);
    if (u.username || u.password) return undefined;
    if (u.protocol === "https:" || (allowHttp && u.protocol === "http:")) return u.href;
  } catch { /* not a URL */ }
  return undefined;
}
const LINK_KEYS = new Set(["thumbnailUrl", "pageUrl", "licenseUrl", "instanceUrl", "osmUrl", "homepage", "articleUrl"]);
const HTTP_OK_KEYS = new Set(["homepage", "articleUrl"]);

async function readBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("Relay response exceeds 2 MB");
  if (!response.body) throw new Error("Relay returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Relay response exceeds 2 MB");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function relayUrl(route: MobilityRoute, params: Record<string, string | number | undefined> = {}): string {
  if (!(MOBILITY_ROUTES as readonly string[]).includes(route)) throw new Error("Relay route is not allowlisted");
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, typeof v === "number" ? String(Number(v.toFixed(6))) : v);
  const qs = query.toString();
  return `${MOBILITY_RELAY_PREFIX}/${route}${qs ? `?${qs}` : ""}`;
}

async function getRelay(url: string, options: MobilityOptions): Promise<unknown> {
  if (options.network !== true) throw new Error("Network access is opt-in");
  const path = url.split("?", 1)[0];
  const route = path.slice(MOBILITY_RELAY_PREFIX.length + 1);
  if (!path.startsWith(`${MOBILITY_RELAY_PREFIX}/`) || !(MOBILITY_ROUTES as readonly string[]).includes(route)) throw new Error("Relay path is not allowlisted");
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetcher(url, {
      method: "GET", redirect: "error", credentials: "same-origin", referrerPolicy: "no-referrer", cache: "no-store", signal,
      headers: { Accept: "application/json", [MOBILITY_HEADER]: "enabled" },
    });
    if (!response.ok) {
      let code = "relay_error", message = `HTTP ${response.status}`;
      try {
        const body = (await readBounded(response)) as { error?: { code?: unknown; message?: unknown } };
        if (typeof body?.error?.code === "string") code = body.error.code.slice(0, 64);
        if (typeof body?.error?.message === "string") message = body.error.message.slice(0, 240);
      } catch { /* keep generic message */ }
      throw new MobilityRelayError(response.status, code, message);
    }
    return await readBounded(response);
  } finally {
    clearTimeout(timer);
  }
}

export const DISABLED_HINT = "Relay disabled: set UCAS_WORLDVIEW_MOBILITY_ENABLED=1 on the API server and route /api/v1/worldview-mobility to it";

function statusFromError(e: unknown): { status: MobilityStatus; error: string } {
  if (e instanceof MobilityRelayError) {
    if (e.code === "worldview_mobility_disabled" || (e.status === 404 && e.code === "relay_error")) return { status: "disabled", error: DISABLED_HINT };
    if (e.status === 429 || e.code === "relay_busy") return { status: "throttled", error: e.message };
    return { status: "failed", error: e.message };
  }
  if (e instanceof Error && e.name === "AbortError") return { status: "failed", error: "Request cancelled or timed out" };
  return { status: "failed", error: e instanceof Error ? e.message.slice(0, 240) : "Request failed" };
}

function failure(route: MobilityRoute, now: number, e: unknown): MobilityResult {
  const { status, error } = statusFromError(e);
  return {
    route, providerId: `worldview-mobility:${route}`, providerName: "WorldView mobility relay", observations: [], items: [], retrievedAt: new Date(now).toISOString(),
    freshness: "failed", status, error, attribution: "", truncated: false, cached: false,
  };
}

const ENVELOPE_STATUS: Record<string, MobilityStatus> = { ok: "live", stale: "stale", throttled: "throttled", failed: "failed", not_configured: "not_configured" };
const ITEM_FRESHNESS: Record<string, Freshness> = { fresh: "fresh", stale: "stale", unknown: "unknown" };

function normalizeItem(raw: unknown, fallbackFreshness: Freshness): MobilityItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isKind(r.kind)) return null;
  const id = str(r.id, 80);
  if (!id) return null;
  const point = finite(r.lat) && finite(r.lon) ? { lat: r.lat, lon: r.lon } : undefined;
  if (point && !validatePoint(point)) return null;
  const properties: Record<string, Primitive> = {};
  const props = r.properties && typeof r.properties === "object" ? (r.properties as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(props).slice(0, 30)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)) continue;
    if (LINK_KEYS.has(k)) properties[k] = safeLink(v, HTTP_OK_KEYS.has(k)) ?? null;
    else if (typeof v === "string") properties[k] = str(v, 200) ?? null;
    else if (finite(v) || typeof v === "boolean" || v === null) properties[k] = v as Primitive;
  }
  return {
    id, kind: r.kind, point, label: str(r.label, 200) ?? r.kind,
    providerTimestamp: isoOrUndefined(r.providerTimestamp),
    ageSeconds: finite(r.ageSeconds) ? r.ageSeconds : undefined,
    freshness: typeof r.freshness === "string" ? ITEM_FRESHNESS[r.freshness] ?? fallbackFreshness : fallbackFreshness,
    properties,
  };
}

/** Normalize one relay envelope. Items with a position become WorldObservations; items without (news without a place) stay list-only. */
export function normalizeEnvelope(route: MobilityRoute, body: unknown, now: number): MobilityResult {
  if (!body || typeof body !== "object") throw new Error("Relay returned an invalid envelope");
  const b = body as Record<string, unknown>;
  const providerId = str(b.providerId, 80);
  const status = typeof b.status === "string" ? ENVELOPE_STATUS[b.status] : undefined;
  if (!providerId || !status || !Array.isArray(b.items)) throw new Error("Relay returned an invalid envelope");
  const envelopeFreshness: Freshness = status === "live" ? "fresh" : status === "stale" || status === "throttled" ? "stale" : "failed";
  const items = b.items.slice(0, MAX_ITEMS).map((x) => normalizeItem(x, envelopeFreshness)).filter((x): x is MobilityItem => x !== null);
  for (const item of items) {
    if (status !== "live" && item.freshness === "fresh") item.freshness = "stale";
    if (status !== "live" || item.freshness !== "fresh") item.properties = { ...item.properties, live: false };
  }
  const providerName = str(b.provider, 120) ?? providerId;
  const attribution = str(b.attribution, 300) ?? "";
  const retrievedAt = isoOrUndefined(b.retrievedAt) ?? new Date(now).toISOString();
  const source = sourceLabel(route, providerName);
  const observations: WorldObservation[] = items.filter((i) => i.point).map((i) => ({
    id: `mobility:${providerId}:${i.id}`,
    layer: MOBILITY_LAYERS[i.kind],
    point: i.point as GeoPoint,
    // Street imagery/radio/OSM timestamps are capture/edit times, not "seen now"; places carry retrieval time.
    observedAt: i.providerTimestamp ?? retrievedAt,
    source,
    label: i.label,
    freshness: i.freshness,
    stale: i.freshness === "stale" ? true : undefined,
    properties: { ...i.properties, kind: i.kind, attribution, timeBasis: i.providerTimestamp ? "provider" : "retrieval", synthetic: false },
  }));
  return {
    route, providerId, providerName, status, observations, items, retrievedAt,
    freshness: envelopeFreshness,
    error: str(b.error, 300),
    attribution,
    license: str(b.license, 200),
    licenseUrl: safeLink(b.licenseUrl),
    termsUrl: safeLink(b.termsUrl),
    sourceUrl: safeLink(b.sourceUrl),
    providerTimestamp: isoOrUndefined(b.providerTimestamp),
    ageSeconds: finite(b.ageSeconds) ? b.ageSeconds : undefined,
    notice: str(b.notice, 500),
    truncated: b.truncated === true,
    cached: b.cached === true,
  };
}

export const sourceLabel = (route: MobilityRoute, providerName: string) => `Mobility · ${route} · ${providerName}`;
export const MOBILITY_SOURCE_PREFIX = "Mobility · ";

async function call(route: MobilityRoute, params: Record<string, string | number | undefined>, options: MobilityOptions): Promise<MobilityResult> {
  const now = options.now?.() ?? Date.now();
  try {
    return normalizeEnvelope(route, await getRelay(relayUrl(route, params), options), now);
  } catch (e) {
    return failure(route, now, e);
  }
}

const span = (b: Bbox) => Math.max(b.east - b.west, b.north - b.south);
function checkBbox(route: MobilityRoute, b: Bbox, max: number, now: number): MobilityResult | null {
  const ok = [b.west, b.south, b.east, b.north].every(finite) && b.west < b.east && b.south < b.north && b.west >= -180 && b.east <= 180 && b.south >= -90 && b.north <= 90;
  if (!ok) return failure(route, now, new Error("View box is invalid (split date-line views)"));
  if (span(b) > max) return failure(route, now, new Error(`View box sides must be at most ${max}°; zoom in`));
  return null;
}

/** Box of ±halfSpan around a point, clamped to valid coordinates (never wraps the date line). */
export function bboxAround(point: GeoPoint, halfSpanDeg: number): Bbox {
  const h = Math.max(0.01, Math.min(halfSpanDeg, 1));
  return {
    west: Math.max(-180, point.lon - h), east: Math.min(180, point.lon + h),
    south: Math.max(-90, point.lat - h), north: Math.min(90, point.lat + h),
  };
}

const now = (o: MobilityOptions) => o.now?.() ?? Date.now();

export function refreshGbfs(feed: string, bbox: Bbox, options: MobilityOptions = {}): Promise<MobilityResult> {
  const bad = checkBbox("gbfs", bbox, MOBILITY_LIMITS.gbfsMaxSpanDeg, now(options));
  return bad ? Promise.resolve(bad) : call("gbfs", { feed, ...bbox }, options);
}
export function refreshGtfsRt(feed: string, bbox: Bbox, options: MobilityOptions = {}): Promise<MobilityResult> {
  const bad = checkBbox("gtfs-rt", bbox, MOBILITY_LIMITS.gtfsMaxSpanDeg, now(options));
  return bad ? Promise.resolve(bad) : call("gtfs-rt", { feed, ...bbox }, options);
}
export function searchStreetImagery(provider: StreetProvider, point: GeoPoint, radiusM: number, options: MobilityOptions = {}): Promise<MobilityResult> {
  const [lo, hi] = MOBILITY_LIMITS.streetRadiusM;
  if (!STREET_PROVIDERS.includes(provider) || !validatePoint(point) || !(radiusM >= lo && radiusM <= hi))
    return Promise.resolve(failure("street-imagery", now(options), new Error(`Pick a provider, a valid point and a radius of ${lo}-${hi} m`)));
  return call("street-imagery", { provider, lat: point.lat, lon: point.lon, radius: Math.round(radiusM) }, options);
}
export function geocodePlace(q: string, options: MobilityOptions = {}): Promise<MobilityResult> {
  const text = q.trim();
  if (text.length < 2 || text.length > 200) return Promise.resolve(failure("geocode", now(options), new Error("Enter 2-200 characters")));
  return call("geocode", { q: text }, options);
}
export function refreshRadio(point: GeoPoint, radiusKm: number, options: MobilityOptions = {}): Promise<MobilityResult> {
  const [lo, hi] = MOBILITY_LIMITS.radioRadiusKm;
  if (!validatePoint(point) || !(radiusKm >= lo && radiusKm <= hi)) return Promise.resolve(failure("radio", now(options), new Error(`Radius must be ${lo}-${hi} km`)));
  return call("radio", { lat: point.lat, lon: point.lon, radius_km: radiusKm }, options);
}
export function searchNews(q: string, point: GeoPoint | null, options: MobilityOptions = {}): Promise<MobilityResult> {
  const text = q.trim();
  if (!/^[\p{L}\p{N}_\s"'.,:-]{3,120}$/u.test(text)) return Promise.resolve(failure("news", now(options), new Error("Use 3-120 letters, digits, spaces or simple punctuation")));
  return call("news", point && validatePoint(point) ? { q: text, lat: point.lat, lon: point.lon } : { q: text }, options);
}
export function refreshInfrastructure(bbox: Bbox, options: MobilityOptions = {}): Promise<MobilityResult> {
  const bad = checkBbox("infrastructure", bbox, MOBILITY_LIMITS.infrastructureMaxSpanDeg, now(options));
  return bad ? Promise.resolve(bad) : call("infrastructure", { ...bbox }, options);
}

function feedSummaries(v: unknown): FeedSummary[] {
  const feeds = (v as { feeds?: unknown })?.feeds;
  if (!Array.isArray(feeds)) return [];
  return feeds.slice(0, 25).flatMap((f) => {
    const r = f as Record<string, unknown>;
    const id = str(r?.id, 40);
    if (!id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return [];
    return [{ id, name: str(r.name, 120) ?? id, attribution: str(r.attribution, 200), termsUrl: safeLink(r.termsUrl), status: str(r.status, 20) ?? "unknown", keyEnv: str(r.keyEnv, 64) ?? null }];
  });
}

export async function fetchMobilityStatus(options: MobilityOptions = {}): Promise<MobilityRelayStatus | { enabled: false; status: MobilityStatus; error: string }> {
  try {
    const b = (await getRelay(relayUrl("status"), options)) as Record<string, unknown>;
    const street = (b?.streetImagery ?? {}) as Record<string, { status?: unknown }>;
    const geocoder = (b?.geocoder ?? {}) as { status?: unknown };
    return {
      enabled: b?.enabled === true,
      gbfs: feedSummaries(b?.gbfs),
      gtfsRealtime: feedSummaries(b?.gtfsRealtime),
      streetImagery: Object.fromEntries(STREET_PROVIDERS.map((p) => [p, str(street[p]?.status, 20) ?? "unknown"])) as Record<StreetProvider, string>,
      geocoder: str(geocoder.status, 20) ?? "unknown",
      contactConfigured: b?.contactConfigured === true,
    };
  } catch (e) {
    const { status, error } = statusFromError(e);
    return { enabled: false, status, error };
  }
}

/** Replace this provider's observations on success; on failure keep the last snapshot but mark it stale (no live claim remains). */
export function mergeMobilityObservations(records: WorldObservation[], result: MobilityResult): WorldObservation[] {
  const prefix = sourceLabel(result.route, result.providerName);
  if (result.status === "live" || result.status === "stale" || (result.status === "throttled" && result.observations.length))
    return [...records.filter((o) => o.source !== prefix), ...result.observations];
  return records.map((o) => (o.source === prefix ? { ...o, freshness: "stale" as const, stale: true, properties: { ...o.properties, live: false } } : o));
}

/** Remove every observation this panel added (used when the panel is closed/cleared). */
export const clearMobilityObservations = (records: WorldObservation[]) => records.filter((o) => !o.source.startsWith(MOBILITY_SOURCE_PREFIX));

export function ageText(iso: string | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown age";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const STATUS_LABEL: Record<MobilityStatus, string> = {
  live: "LIVE", stale: "STALE", throttled: "THROTTLED", failed: "FAILED", not_configured: "NOT CONFIGURED", disabled: "RELAY DISABLED",
};

/** One-line freshness label: status, what the time means, and how old it is. */
export function freshnessLabel(result: MobilityResult, nowMs: number): string {
  const parts = [STATUS_LABEL[result.status]];
  if (result.cached) parts.push("cached");
  const historic = result.route === "street-imagery" || result.route === "radio" || result.route === "geocode";
  if (result.providerTimestamp && !historic) parts.push(`provider time ${ageText(result.providerTimestamp, nowMs)}`);
  parts.push(`retrieved ${ageText(result.retrievedAt, nowMs)}`);
  if (historic && result.items.length) parts.push(result.route === "street-imagery" ? "capture times are historical" : "directory metadata");
  if (result.truncated) parts.push("truncated; zoom in");
  return parts.join(" · ");
}
