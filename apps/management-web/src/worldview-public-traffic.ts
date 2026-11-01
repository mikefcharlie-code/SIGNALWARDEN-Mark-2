/* Public traffic cameras + TomTom traffic: browser side of the opt-in local relay.
 *
 * The browser never talks to a road authority's catalog or to TomTom directly:
 * every request goes to the same-origin `/api/v1/public-traffic` relay, which
 * is disabled unless the server sets UCAS_PUBLIC_TRAFFIC_ENABLED=1 and which is
 * the only place provider keys exist. The one exception is a provider whose
 * catalog says frames must load from the authority's own image host
 * (`snapshotMode: "hotlink"`); those are shown with a plain <img> pinned to the
 * provider's host, on explicit request for a single selected camera.
 *
 * Display only: nothing here reads, analyses or matches image content.
 */
import type { Freshness, GeoPoint, WorldObservation } from "./worldview-core";
import { validateObservation } from "./worldview-core";

export const PUBLIC_TRAFFIC_RELAY = "/api/v1/public-traffic";
export const PUBLIC_TRAFFIC_HEADER = "X-SignalWarden-Traffic";
export const CATALOG_STALE_MS = 15 * 60_000;
export const SNAPSHOT_STALE_MS = 10 * 60_000;
export const TRAFFIC_STALE_MS = 10 * 60_000;
export const MAX_RADIUS_KM = 150;
export const TOMTOM_MAX_RADIUS_KM = 49;
const MAX_JSON_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
export const OBSERVATION_PREFIX = { cameras: "pubcam-", traffic: "tomtom-" } as const;

export type ProviderState = "available" | "not_configured" | "disabled";
export type CameraProvider = Readonly<{
  id: string;
  name: string;
  authority: string;
  region: string;
  coverage: readonly [number, number, number, number];
  status: ProviderState;
  keyEnv: string | null;
  keyUrl: string | null;
  keyFree: boolean | null;
  snapshotMode: "relay" | "relay_base64_json" | "hotlink";
  attribution: string;
  license: string;
  termsUrl: string;
  verified: string;
  notes: string;
}>;
export type ProviderListing = Readonly<{
  cameraProviders: CameraProvider[];
  traffic: Readonly<{ name: string; status: ProviderState; keyEnv: string; keyUrl: string; attribution: string; license: string; termsUrl: string; verified: string }>;
}>;
export type Camera = Readonly<{
  id: string;
  name: string;
  road: string | null;
  direction: string | null;
  lat: number;
  lon: number;
  authority: string;
  snapshotUrl: string | null;
  providerUpdatedAt: string | null;
}>;
export type CameraCatalog = Readonly<{
  provider: string;
  providerName: string;
  authority: string;
  attribution: string;
  license: string;
  termsUrl: string;
  verified: string;
  snapshotMode: CameraProvider["snapshotMode"];
  status: "ok" | "out_of_coverage";
  cameras: Camera[];
  totalInArea: number;
  truncated: boolean;
  retrievedAt: string;
  providerUpdatedAt: string | null;
  sourceUrl: string | null;
}>;
export type Snapshot = Readonly<{
  provider: string;
  cameraId: string;
  cameraName: string;
  mime: string;
  bytes: Uint8Array;
  imageTime: string | null;
  imageTimeSource: string;
  retrievedAt: string;
  sourceUrl: string;
  attribution: string;
}>;
export type Incident = Readonly<{
  id: string; lat: number; lon: number; category: string; description: string;
  magnitudeOfDelay: number | null; delaySeconds: number | null; lengthMeters: number | null;
  from: string | null; to: string | null; roadNumbers: string | null;
  startTime: string | null; endTime: string | null; lastReportTime: string | null;
}>;
export type Flow = Readonly<{
  lat: number; lon: number; currentSpeedKmh: number; freeFlowSpeedKmh: number;
  currentTravelTimeSeconds: number | null; freeFlowTravelTimeSeconds: number | null;
  confidence: number | null; roadClosure: boolean; functionalRoadClass: string | null;
}>;
export type TrafficResult = Readonly<{
  attribution: string; license: string; termsUrl: string; verified: string; retrievedAt: string;
  incidents: Incident[]; truncated: boolean; flow: Flow | null; flowError: string | null;
  sourceUrl: string; flowSourceUrl: string;
}>;
export type Bbox = Readonly<{ west: number; south: number; east: number; north: number }>;
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A relay error carrying the server's error code (e.g. `not_configured`). */
export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RelayError";
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.length <= max ? v : null);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (v: unknown): string | null => {
  const s = str(v, 64);
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
};
const https = (v: unknown): string | null => {
  const s = str(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};

/** Square bbox around the WorldView centre, clamped to valid coordinates. */
export function areaBounds(center: GeoPoint, radiusKm: number): Bbox {
  if (!finite(center?.lat) || !finite(center?.lon) || Math.abs(center.lat) > 89 || Math.abs(center.lon) > 180)
    throw new Error("Invalid centre");
  if (!finite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) throw new Error(`Radius must be >0 and <=${MAX_RADIUS_KM} km`);
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos((center.lat * Math.PI) / 180)));
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    west: r(Math.max(-180, center.lon - dLon)),
    south: r(Math.max(-90, center.lat - dLat)),
    east: r(Math.min(180, center.lon + dLon)),
    north: r(Math.min(90, center.lat + dLat)),
  };
}

export function coverageIncludes(provider: Pick<CameraProvider, "coverage">, bbox: Bbox): boolean {
  const [w, s, e, n] = provider.coverage;
  return !(bbox.east < w || bbox.west > e || bbox.north < s || bbox.south > n);
}

async function relayJson(path: string, params: Record<string, string>, fetcher: Fetcher, signal?: AbortSignal): Promise<unknown> {
  const query = new URLSearchParams(params).toString();
  const url = `${PUBLIC_TRAFFIC_RELAY}/${path}${query ? `?${query}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET", redirect: "error", credentials: "same-origin", referrerPolicy: "no-referrer", cache: "no-store",
        signal: controller.signal, headers: { Accept: "application/json", [PUBLIC_TRAFFIC_HEADER]: "enabled" },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new RelayError(0, signal?.aborted ? "cancelled" : "timeout", signal?.aborted ? "Request cancelled" : "Relay request timed out");
      throw new RelayError(0, "relay_unreachable", "Cannot reach the local public-traffic relay");
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_JSON_BYTES) throw new RelayError(response.status, "response_too_large", "Relay response exceeds the size limit");
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) throw new RelayError(response.status, "response_too_large", "Relay response exceeds the size limit");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RelayError(response.status, "relay_invalid_json", response.ok ? "Relay returned invalid JSON" : `Relay unavailable (HTTP ${response.status}); route /api/v1/public-traffic to the local API`);
    }
    if (!response.ok) {
      const err = obj(body) && obj(body.error) ? body.error : {};
      const code = str(err.code, 80) ?? "relay_error";
      const message = str(err.message, 300) ?? `Relay error (HTTP ${response.status})`;
      throw new RelayError(response.status, code, message);
    }
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseProvider(v: unknown): CameraProvider | null {
  if (!obj(v)) return null;
  const id = str(v.id, 40), name = str(v.name, 120), status = v.status;
  const cov = Array.isArray(v.coverage) && v.coverage.length === 4 && v.coverage.every(finite) ? (v.coverage as number[]) : null;
  const mode = v.snapshotMode;
  if (!id || !name || !cov || !["available", "not_configured", "disabled"].includes(status as string) ||
      !["relay", "relay_base64_json", "hotlink"].includes(mode as string)) return null;
  return {
    id, name, authority: str(v.authority, 200) ?? "", region: str(v.region, 120) ?? "",
    coverage: [cov[0], cov[1], cov[2], cov[3]], status: status as ProviderState,
    keyEnv: str(v.keyEnv, 80), keyUrl: https(v.keyUrl), keyFree: typeof v.keyFree === "boolean" ? v.keyFree : null,
    snapshotMode: mode as CameraProvider["snapshotMode"], attribution: str(v.attribution) ?? "", license: str(v.license) ?? "",
    termsUrl: https(v.termsUrl) ?? "", verified: str(v.verified) ?? "unverified", notes: str(v.notes) ?? "",
  };
}

export async function fetchProviders(fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<ProviderListing> {
  const body = await relayJson("providers", {}, fetcher, signal);
  if (!obj(body) || !Array.isArray(body.cameraProviders) || !obj(body.traffic)) throw new RelayError(200, "relay_schema", "Unexpected provider listing");
  const t = body.traffic;
  return {
    cameraProviders: body.cameraProviders.map(parseProvider).filter((p): p is CameraProvider => !!p),
    traffic: {
      name: str(t.name, 120) ?? "TomTom Traffic", status: (["available", "not_configured", "disabled"].includes(t.status as string) ? t.status : "not_configured") as ProviderState,
      keyEnv: str(t.keyEnv, 80) ?? "UCAS_TOMTOM_API_KEY", keyUrl: https(t.keyUrl) ?? "", attribution: str(t.attribution) ?? "Traffic data © TomTom",
      license: str(t.license) ?? "", termsUrl: https(t.termsUrl) ?? "", verified: str(t.verified) ?? "unverified",
    },
  };
}

function parseCamera(v: unknown): Camera | null {
  if (!obj(v)) return null;
  const id = str(v.id, 120), name = str(v.name, 200);
  if (!id || !name || !finite(v.lat) || !finite(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null;
  return {
    id, name, road: str(v.road, 120), direction: str(v.direction, 60), lat: v.lat, lon: v.lon,
    authority: str(v.authority, 200) ?? "", snapshotUrl: https(v.snapshotUrl), providerUpdatedAt: iso(v.providerUpdatedAt),
  };
}

export async function fetchCatalog(provider: string, bbox: Bbox, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<CameraCatalog> {
  const body = await relayJson("cameras/catalog", {
    provider, west: String(bbox.west), south: String(bbox.south), east: String(bbox.east), north: String(bbox.north),
  }, fetcher, signal);
  if (!obj(body) || body.provider !== provider || !Array.isArray(body.cameras) || !iso(body.retrievedAt) ||
      !["ok", "out_of_coverage"].includes(body.status as string)) throw new RelayError(200, "relay_schema", "Unexpected camera catalog");
  const mode = ["relay", "relay_base64_json", "hotlink"].includes(body.snapshotMode as string) ? (body.snapshotMode as CameraProvider["snapshotMode"]) : "relay";
  return {
    provider, providerName: str(body.providerName, 120) ?? provider, authority: str(body.authority, 200) ?? "",
    attribution: str(body.attribution) ?? "", license: str(body.license) ?? "", termsUrl: https(body.termsUrl) ?? "",
    verified: str(body.verified) ?? "unverified", snapshotMode: mode, status: body.status as CameraCatalog["status"],
    cameras: body.cameras.slice(0, 300).map(parseCamera).filter((c): c is Camera => !!c),
    totalInArea: finite(body.totalInArea) ? body.totalInArea : 0, truncated: body.truncated === true,
    retrievedAt: iso(body.retrievedAt)!, providerUpdatedAt: iso(body.providerUpdatedAt), sourceUrl: str(body.sourceUrl, 1000),
  };
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
export async function fetchSnapshot(provider: string, cameraId: string, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<Snapshot> {
  const body = await relayJson("cameras/snapshot", { provider, id: cameraId }, fetcher, signal);
  if (!obj(body) || body.provider !== provider || body.cameraId !== cameraId || !IMAGE_TYPES.has(body.mime as string) ||
      typeof body.dataBase64 !== "string" || !iso(body.retrievedAt)) throw new RelayError(200, "relay_schema", "Unexpected snapshot response");
  let bytes: Uint8Array;
  try {
    const raw = atob(body.dataBase64);
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  } catch {
    throw new RelayError(200, "relay_schema", "Snapshot payload is not valid base64");
  }
  return {
    provider, cameraId, cameraName: str(body.cameraName, 200) ?? cameraId, mime: body.mime as string, bytes,
    imageTime: iso(body.imageTime), imageTimeSource: str(body.imageTimeSource, 40) ?? "unknown",
    retrievedAt: iso(body.retrievedAt)!, sourceUrl: https(body.sourceUrl) ?? "", attribution: str(body.attribution) ?? "",
  };
}

/** Hotlink only to the provider's own pinned frame host, as listed in its catalog. */
export function hotlinkUrl(provider: Pick<CameraProvider, "id" | "snapshotMode">, camera: Camera): string | null {
  if (provider.snapshotMode !== "hotlink" || !camera.snapshotUrl) return null;
  const pins: Record<string, string> = { nsw: "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/" };
  const pin = pins[provider.id];
  return pin && camera.snapshotUrl.startsWith(pin) ? camera.snapshotUrl : null;
}

function parseIncident(v: unknown): Incident | null {
  if (!obj(v)) return null;
  const id = str(v.id, 120);
  if (!id || !finite(v.lat) || !finite(v.lon)) return null;
  const n = (x: unknown) => (finite(x) ? x : null);
  return {
    id, lat: v.lat, lon: v.lon, category: str(v.category, 60) ?? "Unknown", description: str(v.description, 200) ?? "",
    magnitudeOfDelay: n(v.magnitudeOfDelay), delaySeconds: n(v.delaySeconds), lengthMeters: n(v.lengthMeters),
    from: str(v.from, 120), to: str(v.to, 120), roadNumbers: str(v.roadNumbers, 120),
    startTime: iso(v.startTime), endTime: iso(v.endTime), lastReportTime: iso(v.lastReportTime),
  };
}

export async function fetchTomTom(bbox: Bbox, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<TrafficResult> {
  const body = await relayJson("tomtom", { west: String(bbox.west), south: String(bbox.south), east: String(bbox.east), north: String(bbox.north) }, fetcher, signal);
  if (!obj(body) || body.provider !== "tomtom" || !Array.isArray(body.incidents) || !iso(body.retrievedAt)) throw new RelayError(200, "relay_schema", "Unexpected TomTom response");
  const f = obj(body.flow) ? body.flow : null;
  const flow: Flow | null = f && finite(f.lat) && finite(f.lon) && finite(f.currentSpeedKmh) && finite(f.freeFlowSpeedKmh)
    ? {
        lat: f.lat, lon: f.lon, currentSpeedKmh: f.currentSpeedKmh, freeFlowSpeedKmh: f.freeFlowSpeedKmh,
        currentTravelTimeSeconds: finite(f.currentTravelTimeSeconds) ? f.currentTravelTimeSeconds : null,
        freeFlowTravelTimeSeconds: finite(f.freeFlowTravelTimeSeconds) ? f.freeFlowTravelTimeSeconds : null,
        confidence: finite(f.confidence) ? f.confidence : null, roadClosure: f.roadClosure === true, functionalRoadClass: str(f.functionalRoadClass, 8),
      }
    : null;
  return {
    attribution: str(body.attribution) ?? "Traffic data © TomTom", license: str(body.license) ?? "", termsUrl: https(body.termsUrl) ?? "",
    verified: str(body.verified) ?? "unverified", retrievedAt: iso(body.retrievedAt)!,
    incidents: body.incidents.slice(0, 200).map(parseIncident).filter((i): i is Incident => !!i), truncated: body.truncated === true,
    flow, flowError: str(body.flowError, 80), sourceUrl: str(body.sourceUrl, 1000) ?? "", flowSourceUrl: str(body.flowSourceUrl, 1000) ?? "",
  };
}

export function ageFreshness(timestamp: string | null, staleAfterMs: number, now = Date.now()): { freshness: Freshness; ageSeconds: number | null } {
  if (!timestamp) return { freshness: "unknown", ageSeconds: null };
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t) || t > now + 120_000) return { freshness: "unknown", ageSeconds: null };
  const age = Math.max(0, now - t);
  return { freshness: age <= staleAfterMs ? "fresh" : "stale", ageSeconds: Math.round(age / 1000) };
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "age unknown";
  if (seconds < 90) return `${seconds}s old`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min old`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h old`;
  return `${Math.round(seconds / 86_400)} d old`;
}

const clip = (s: string | null | undefined, n = 480) => (s ?? "").slice(0, n);
const obsId = (prefix: string, provider: string, id: string) => `${prefix}${provider}-${id}`.slice(0, 120);

/** Camera catalog entries as `cameras` layer observations (locations only; pose is coarse). */
export function cameraObservations(catalog: CameraCatalog, now = Date.now()): WorldObservation[] {
  const { freshness } = ageFreshness(catalog.retrievedAt, CATALOG_STALE_MS, now);
  const out: WorldObservation[] = [];
  for (const cam of catalog.cameras) {
    const o: WorldObservation = {
      id: obsId(OBSERVATION_PREFIX.cameras, catalog.provider, cam.id),
      layer: "cameras",
      point: { lat: cam.lat, lon: cam.lon, uncertaintyM: 100 },
      observedAt: catalog.retrievedAt,
      source: catalog.providerName,
      label: clip(`Public traffic camera · ${cam.name}`, 240),
      freshness,
      stale: freshness === "stale",
      properties: {
        provider: catalog.providerName,
        authority: clip(cam.authority || catalog.authority),
        cameraId: clip(cam.id, 120),
        road: cam.road,
        direction: cam.direction,
        sourceUrl: clip(catalog.sourceUrl),
        snapshotUrl: clip(cam.snapshotUrl),
        retrievedAt: catalog.retrievedAt,
        providerTimestamp: cam.providerUpdatedAt ?? catalog.providerUpdatedAt,
        freshnessBasis: "Catalog retrieval time; snapshot age is shown separately when a frame is loaded",
        attribution: clip(catalog.attribution),
        license: clip(catalog.license),
        termsUrl: clip(catalog.termsUrl),
        verification: clip(catalog.verified),
        pose: "Coarse location from the authority catalog; heading/field of view not modelled",
        disclosure: "Live public catalog entry; snapshots display only, no plate/face recognition or tracking",
      },
    };
    if (validateObservation(o)) out.push(o);
  }
  return out;
}

/** TomTom incidents and the centre flow segment as `traffic` layer observations. */
export function trafficObservations(result: TrafficResult, now = Date.now()): WorldObservation[] {
  const out: WorldObservation[] = [];
  const common = { attribution: clip(result.attribution), license: clip(result.license), termsUrl: clip(result.termsUrl), retrievedAt: result.retrievedAt, verification: clip(result.verified) };
  for (const inc of result.incidents) {
    const providerTime = inc.lastReportTime ?? inc.startTime;
    const { freshness } = ageFreshness(providerTime ?? result.retrievedAt, providerTime ? 60 * 60_000 : TRAFFIC_STALE_MS, now);
    const o: WorldObservation = {
      id: obsId(OBSERVATION_PREFIX.traffic, "incident", inc.id),
      layer: "traffic",
      point: { lat: inc.lat, lon: inc.lon },
      observedAt: providerTime ?? result.retrievedAt,
      source: "TomTom Traffic",
      label: clip(`Traffic incident · ${inc.category}${inc.description ? ` · ${inc.description}` : ""}`, 240),
      freshness,
      properties: {
        ...common, provider: "TomTom Traffic Incidents v5", sourceUrl: clip(result.sourceUrl), providerTimestamp: providerTime,
        delaySeconds: inc.delaySeconds, magnitudeOfDelay: inc.magnitudeOfDelay, lengthMeters: inc.lengthMeters,
        from: inc.from, to: inc.to, roads: inc.roadNumbers, startTime: inc.startTime, endTime: inc.endTime,
        disclosure: "Reported road incident (aggregate); not individual vehicle data",
      },
    };
    if (validateObservation(o)) out.push(o);
  }
  if (result.flow) {
    const f = result.flow;
    const { freshness } = ageFreshness(result.retrievedAt, TRAFFIC_STALE_MS, now);
    const o: WorldObservation = {
      id: obsId(OBSERVATION_PREFIX.traffic, "flow", `${f.lat.toFixed(4)},${f.lon.toFixed(4)}`),
      layer: "traffic",
      point: { lat: f.lat, lon: f.lon },
      observedAt: result.retrievedAt,
      source: "TomTom Traffic",
      label: `Traffic flow · ${Math.round(f.currentSpeedKmh)}/${Math.round(f.freeFlowSpeedKmh)} km/h${f.roadClosure ? " · road closed" : ""}`,
      freshness,
      ...(f.confidence === null ? {} : { confidence: Math.max(0, Math.min(1, f.confidence)) }),
      properties: {
        ...common, provider: "TomTom Traffic Flow Segment v4", sourceUrl: clip(result.flowSourceUrl),
        providerTimestamp: null, freshnessBasis: "TomTom flow segment carries no timestamp; retrieval time shown",
        currentSpeedKmh: f.currentSpeedKmh, freeFlowSpeedKmh: f.freeFlowSpeedKmh, roadClass: f.functionalRoadClass,
        disclosure: "Aggregate segment speed; not individual vehicle data",
      },
    };
    if (validateObservation(o)) out.push(o);
  }
  return out;
}
