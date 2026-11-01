/* Live AIS vessels for the WorldView `vessels` layer, read through the
 * disabled-by-default same-origin Management API relay. No provider key is
 * ever present in the browser: AISStream/BarentsWatch credentials and the
 * Kystverket TCP connection live only on the server. AIS is self-reported. */
import type { GeoPoint, WorldObservation } from "./worldview-core";

export const AIS_RELAY_PREFIX = "/api/v1/public-ais";
export const AIS_HEADER = "X-SignalWarden-AIS";
export const AIS_MAX_LAT_SPAN = 4;
export const AIS_MAX_LON_SPAN = 6;
export const AIS_DEFAULT_HALF_LAT = 1;
export const AIS_DEFAULT_HALF_LON = 1.5;
export const AIS_POLL_MS = 30_000;
export const AIS_STALE_MS = 10 * 60_000;
const MAX_BYTES = 1_000_000;
const MAX_VESSELS = 500;

export type AisProviderId = "aisstream" | "kystverket" | "barentswatch";
export const AIS_PROVIDER_IDS: readonly AisProviderId[] = ["aisstream", "kystverket", "barentswatch"];
export const AIS_PROVIDER_LABELS: Readonly<Record<AisProviderId, string>> = Object.freeze({
  aisstream: "AISStream.io (server key)",
  kystverket: "Kystverket open AIS · Norway (keyless, NLOD)",
  barentswatch: "BarentsWatch AIS · Norway (server client ID)",
});
export const AIS_SELF_REPORTED =
  "AIS is self-reported by vessel transponders: positions, names and types are as broadcast, unverified, and may be delayed, wrong, spoofed or missing. No owner, crew or person lookup.";

export type AisRelayStatus = "live" | "connecting" | "stale" | "error" | "idle" | "not_configured" | "disabled" | "unknown";

export interface AisBBox { south: number; west: number; north: number; east: number }
export interface AisVessel {
  mmsi: number; lat: number; lon: number;
  sogKn?: number | null; cogDeg?: number | null; headingDeg?: number | null;
  navStatus?: number | null; navStatusText?: string | null;
  name?: string | null; shipType?: number | null; shipTypeText?: string | null;
  aisClass?: string | null; providerTimestamp?: string | null; receivedAt?: string | null;
  ageSeconds?: number; stale?: boolean;
}
export interface AisProviderInfo {
  provider: AisProviderId; name: string; source: string; sourceUrl: string;
  attribution: string; license: string; licenseUrl?: string; termsUrl?: string; coverage?: string;
  status: AisRelayStatus; configured: boolean; keyRequired: boolean; configEnv: string[];
  error?: string | null; lastMessageAt?: string | null; message?: string | null; disclosure?: string;
}
export interface AisVesselsResponse extends AisProviderInfo {
  bbox: AisBBox; retrievedAt: string; vessels: AisVessel[]; vesselsInBox: number; truncated: boolean;
}
export interface AisStatusResponse { relay: string; readOnly: boolean; transmit: boolean; providers: AisProviderInfo[] }
export type AisFetcher = (input: string, init: RequestInit) => Promise<Response>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 240) => (typeof v === "string" ? v.slice(0, max) : undefined);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** A capped box around the view centre; shifted (not wrapped) at the poles/antimeridian. */
export function aisBBox(center: GeoPoint, halfLat = AIS_DEFAULT_HALF_LAT, halfLon = AIS_DEFAULT_HALF_LON): AisBBox {
  if (!finite(center?.lat) || !finite(center?.lon) || Math.abs(center.lat) > 90 || Math.abs(center.lon) > 180)
    throw new Error("Invalid view centre");
  const hLat = Math.min(AIS_MAX_LAT_SPAN / 2, Math.max(0.05, halfLat));
  const hLon = Math.min(AIS_MAX_LON_SPAN / 2, Math.max(0.05, halfLon));
  let south = center.lat - hLat, north = center.lat + hLat, west = center.lon - hLon, east = center.lon + hLon;
  if (south < -90) { north += -90 - south; south = -90; }
  if (north > 90) { south -= north - 90; north = 90; }
  if (west < -180) { east += -180 - west; west = -180; }
  if (east > 180) { west -= east - 180; east = 180; }
  return { south: round4(south), west: round4(west), north: round4(north), east: round4(east) };
}

async function readBounded(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("AIS relay response exceeds 1 MB");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("AIS relay response exceeds 1 MB");
  return JSON.parse(text);
}

async function relayGet(path: string, fetcher: AisFetcher, signal?: AbortSignal): Promise<unknown> {
  const response = await fetcher(`${AIS_RELAY_PREFIX}${path}`, {
    method: "GET", redirect: "error", credentials: "same-origin", referrerPolicy: "no-referrer", cache: "no-store", signal,
    headers: { Accept: "application/json", [AIS_HEADER]: "enabled" },
  });
  let body: unknown;
  try { body = await readBounded(response); } catch { body = undefined; }
  if (!response.ok) {
    const code = obj(body) && obj(body.error) ? str(body.error.code, 80) : undefined;
    if (response.status === 404 && (code === "public_ais_disabled" || code === undefined))
      throw new Error("AIS relay is disabled or not routed: start the Management API with UCAS_PUBLIC_AIS_ENABLED=1 and route /api/v1/public-ais on this origin");
    const message = obj(body) && obj(body.error) ? str(body.error.message, 200) : undefined;
    throw new Error(`AIS relay error (HTTP ${response.status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`);
  }
  if (!obj(body)) throw new Error("AIS relay returned an unexpected response");
  return body;
}

export async function fetchAisStatus(fetcher: AisFetcher = fetch, signal?: AbortSignal): Promise<AisStatusResponse> {
  const body = await relayGet("/status", fetcher, signal);
  if (!Array.isArray((body as any).providers)) throw new Error("AIS relay status had an unexpected shape");
  return body as unknown as AisStatusResponse;
}

export async function fetchAisVessels(provider: AisProviderId, bbox: AisBBox, fetcher: AisFetcher = fetch, signal?: AbortSignal): Promise<AisVesselsResponse> {
  if (!AIS_PROVIDER_IDS.includes(provider)) throw new Error("Unknown AIS provider");
  if (bbox.north - bbox.south > AIS_MAX_LAT_SPAN || bbox.east - bbox.west > AIS_MAX_LON_SPAN || bbox.south >= bbox.north || bbox.west >= bbox.east)
    throw new Error("AIS bounding box exceeds the relay cap");
  const query = new URLSearchParams({ provider, south: String(bbox.south), west: String(bbox.west), north: String(bbox.north), east: String(bbox.east) });
  const body = await relayGet(`/vessels?${query}`, fetcher, signal);
  if (!Array.isArray((body as any).vessels) || typeof (body as any).status !== "string")
    throw new Error("AIS relay vessels response had an unexpected shape");
  return body as unknown as AisVesselsResponse;
}

const num = (v: unknown) => (finite(v) ? v : null);

/** Convert a relay response into live (never synthetic) `vessels` observations. */
export function aisObservations(body: AisVesselsResponse, nowMs = Date.now()): WorldObservation[] {
  const retrievedAt = Number.isFinite(Date.parse(body.retrievedAt)) ? new Date(body.retrievedAt).toISOString() : new Date(nowMs).toISOString();
  const out: WorldObservation[] = [];
  const seen = new Set<number>();
  for (const v of body.vessels.slice(0, MAX_VESSELS)) {
    if (!obj(v) || !Number.isInteger(v.mmsi) || v.mmsi <= 0 || v.mmsi >= 1e9 || seen.has(v.mmsi)) continue;
    if (!finite(v.lat) || !finite(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) continue;
    const ts = Date.parse(String(v.providerTimestamp ?? ""));
    if (!Number.isFinite(ts) || ts > nowMs + 60_000) continue;
    seen.add(v.mmsi);
    const name = str(v.name, 40)?.trim() || undefined;
    const stale = v.stale === true || nowMs - ts > AIS_STALE_MS || body.status !== "live";
    out.push({
      id: `ais-${body.provider}-${v.mmsi}`,
      layer: "vessels",
      point: { lat: v.lat, lon: v.lon },
      observedAt: new Date(Math.min(ts, nowMs)).toISOString(),
      source: str(body.source) ?? body.provider,
      label: name ? `${name} · AIS` : `MMSI ${v.mmsi} · AIS`,
      title: `AIS vessel (${str(v.shipTypeText, 60) ?? "type not broadcast"})`,
      freshness: stale ? "stale" : "fresh",
      ...(stale ? { stale: true } : {}),
      properties: {
        provider: body.provider,
        mmsi: v.mmsi,
        vesselName: name ?? null,
        shipType: str(v.shipTypeText, 60) ?? null,
        shipTypeCode: num(v.shipType),
        navStatus: str(v.navStatusText, 80) ?? null,
        sogKn: num(v.sogKn),
        cogDeg: num(v.cogDeg),
        headingDeg: num(v.headingDeg),
        aisClass: str(v.aisClass, 2) ?? null,
        providerTimestamp: new Date(ts).toISOString(),
        retrievedAt,
        sourceUrl: str(body.sourceUrl, 200) ?? null,
        attribution: str(body.attribution, 400) ?? null,
        license: str(body.license, 200) ?? null,
        licenseUrl: str(body.licenseUrl, 200) ?? null,
        termsUrl: str(body.termsUrl, 200) ?? null,
        coverage: str(body.coverage, 300) ?? null,
        disclosure: AIS_SELF_REPORTED,
        live: !stale,
        synthetic: false,
      },
    });
  }
  return out;
}

/** Re-evaluate freshness as time passes without a new poll. */
export function ageAisObservations(items: readonly WorldObservation[], nowMs = Date.now()): WorldObservation[] {
  return items.map((o) => {
    const ts = Date.parse(o.observedAt);
    if (o.freshness === "fresh" && (!Number.isFinite(ts) || nowMs - ts > AIS_STALE_MS)) return { ...o, freshness: "stale", stale: true, properties: { ...o.properties, live: false } };
    return o;
  });
}

export function aisStatusText(info: Pick<AisProviderInfo, "name" | "status" | "error" | "message" | "lastMessageAt">, nowMs = Date.now()): string {
  const last = info.lastMessageAt ? Date.parse(info.lastMessageAt) : NaN;
  const age = Number.isFinite(last) ? ` · last message ${Math.max(0, Math.round((nowMs - last) / 1000))}s ago` : "";
  switch (info.status) {
    case "live": return `${info.name}: LIVE${age}`;
    case "connecting": return `${info.name}: connecting…`;
    case "stale": return `${info.name}: STALE (no recent messages)${age}`;
    case "error": return `${info.name}: FAILED — ${info.error ?? "provider error"}`;
    case "not_configured": return `${info.name}: NOT CONFIGURED — ${info.message ?? "server configuration required"}`;
    case "idle": return `${info.name}: idle (connects only while polled)`;
    default: return `${info.name}: ${info.status}`;
  }
}
