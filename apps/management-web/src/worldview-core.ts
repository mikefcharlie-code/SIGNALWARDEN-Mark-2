/* SignalWarden Worldview Core: read-only, local-first, explicitly bounded. */
export const LAYER_IDS = [
  "aircraft",
  "vessels",
  "satellites",
  "earthquakes",
  "fires",
  "weather",
  "traffic",
  "cameras",
  "alpr",
] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type ExtraLayerId = LayerId | (string & {});
export type Freshness =
  | "fresh"
  | "stale"
  | "fallback"
  | "failed"
  | "synthetic"
  | "unknown";
export interface GeoPoint {
  lat: number;
  lon: number;
  altM?: number;
  uncertaintyM?: number;
}
export type Primitive = string | number | boolean | null;
export interface WorldObservation {
  id: string;
  layer: ExtraLayerId;
  point: GeoPoint;
  observedAt: string;
  source: string;
  label: string;
  title?: string;
  stale?: boolean;
  freshness?: Freshness;
  confidence?: number;
  properties?: Record<string, Primitive>;
}
export interface QueryOptions {
  text?: string;
  layers?: ExtraLayerId[];
  source?: string;
  maxDistanceKm?: number;
  origin?: GeoPoint;
  limit?: number;
  freshness?: Freshness[];
}
const MAX_OBSERVATIONS = 5000,
  MAX_PACK_BYTES = 2_000_000,
  MAX_SCENE_BYTES = 500_000,
  MAX_STRING = 240,
  MAX_PROP = 32,
  MAX_PROP_STRING = 500;
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);
const CREDENTIAL =
  /api[_-]?key|token|password|authorization|secret|credential/i;
const primitive = (v: unknown): v is Primitive =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (finite(v) && typeof v === "number");
function safeProperties(v: unknown): v is Record<string, Primitive> {
  if (v === undefined) return true;
  if (!obj(v)) return false;
  const ks = Object.keys(v);
  return (
    ks.length <= MAX_PROP &&
    ks.every(
      (k) =>
        !CREDENTIAL.test(k) &&
        k.length <= 120 &&
        primitive(v[k]) &&
        (typeof v[k] !== "string" || v[k].length <= MAX_PROP_STRING),
    )
  );
}
export function validatePoint(p: unknown): p is GeoPoint {
  if (
    !obj(p) ||
    !finite(p.lat) ||
    !finite(p.lon) ||
    p.lat < -90 ||
    p.lat > 90 ||
    p.lon < -180 ||
    p.lon > 180
  )
    return false;
  return (
    (!own(p, "altM") || finite(p.altM)) &&
    (!own(p, "uncertaintyM") || (finite(p.uncertaintyM) && p.uncertaintyM >= 0))
  );
}
function safePoint(p: GeoPoint): GeoPoint {
  return {
    lat: p.lat,
    lon: p.lon,
    ...(p.altM === undefined ? {} : { altM: p.altM }),
    ...(p.uncertaintyM === undefined ? {} : { uncertaintyM: p.uncertaintyM }),
  };
}
const FRESH = [
  "fresh",
  "stale",
  "fallback",
  "failed",
  "synthetic",
  "unknown",
] as const;
export function validateObservation(value: unknown): value is WorldObservation {
  if (!obj(value) || CREDENTIAL.test(Object.keys(value).join(" ")))
    return false;
  const x = value as any;
  return (
    typeof x.id === "string" &&
    x.id.length > 0 &&
    x.id.length <= 120 &&
    typeof x.layer === "string" &&
    x.layer.length > 0 &&
    x.layer.length <= 80 &&
    validatePoint(x.point) &&
    typeof x.observedAt === "string" &&
    Number.isFinite(Date.parse(x.observedAt)) &&
    typeof x.source === "string" &&
    x.source.length <= MAX_STRING &&
    typeof x.label === "string" &&
    x.label.length <= MAX_STRING &&
    (!own(x, "title") ||
      (typeof x.title === "string" && x.title.length <= MAX_STRING)) &&
    (!own(x, "stale") || typeof x.stale === "boolean") &&
    (!own(x, "freshness") || FRESH.includes(x.freshness)) &&
    (!own(x, "confidence") ||
      (finite(x.confidence) && x.confidence >= 0 && x.confidence <= 1)) &&
    safeProperties(x.properties)
  );
}
export function normalizeObservation(
  value: WorldObservation,
): WorldObservation {
  if (!validateObservation(value)) throw new Error("Invalid observation");
  const x = value as any;
  const out: WorldObservation = {
    id: x.id,
    layer: x.layer,
    point: safePoint(x.point),
    observedAt: new Date(x.observedAt).toISOString(),
    source: x.source,
    label: x.label.trim().slice(0, MAX_STRING),
  };
  for (const k of ["title", "stale", "freshness", "confidence"] as const)
    if (own(x, k)) (out as any)[k] = x[k];
  if (x.properties !== undefined)
    out.properties = Object.fromEntries(
      Object.entries(x.properties).map(([k, v]) => [
        k,
        typeof v === "string" ? v.slice(0, MAX_PROP_STRING) : v,
      ]),
    ) as Record<string, Primitive>;
  return out;
}
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  if (!validatePoint(a) || !validatePoint(b))
    throw new Error("Invalid coordinate");
  const r = Math.PI / 180,
    dLat = (b.lat - a.lat) * r,
    dLon = (b.lon - a.lon) * r,
    q =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}
export const distanceKm = haversineKm;
export function nearbyObservations(
  items: readonly WorldObservation[],
  origin: GeoPoint,
  maxDistanceKm = Infinity,
): WorldObservation[] {
  if (
    !validatePoint(origin) ||
    (!finite(maxDistanceKm) && maxDistanceKm !== Infinity) ||
    maxDistanceKm < 0
  )
    throw new Error("Invalid nearby query");
  return items
    .filter(validateObservation)
    .map((item) => ({ item, distance: haversineKm(origin, item.point) }))
    .filter((x) => x.distance <= maxDistanceKm)
    .sort(
      (a, b) => a.distance - b.distance || a.item.id.localeCompare(b.item.id),
    )
    .map((x) => x.item);
}
export function queryObservations(
  items: readonly WorldObservation[],
  options: QueryOptions = {},
): WorldObservation[] {
  const terms = (options.text ?? "")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean),
    layers = options.layers && new Set(options.layers);
  let result = items
    .filter(validateObservation)
    .filter((x) => !layers || layers.has(x.layer))
    .filter(
      (x) =>
        !options.source ||
        x.source.toLowerCase() === options.source.toLowerCase(),
    )
    .filter(
      (x) =>
        !options.freshness ||
        options.freshness.includes(x.freshness ?? "unknown"),
    )
    .filter((x) =>
      terms.every((t) =>
        `${x.id} ${x.label} ${x.title ?? ""} ${x.source} ${JSON.stringify(x.properties ?? {})}`
          .toLowerCase()
          .includes(t),
      ),
    );
  if (options.origin)
    result = nearbyObservations(
      result,
      options.origin,
      options.maxDistanceKm ?? Infinity,
    );
  else if (options.maxDistanceKm !== undefined)
    throw new Error("origin required for maxDistanceKm");
  return options.limit === undefined
    ? result
    : result.slice(0, Math.max(0, Math.floor(options.limit)));
}
export function countByLayer(
  items: readonly WorldObservation[],
): Record<string, number> {
  const out = Object.create(null) as Record<string, number>;
  for (const x of items)
    if (validateObservation(x)) out[x.layer] = (out[x.layer] ?? 0) + 1;
  return out;
}
export function rankObservations(
  items: readonly WorldObservation[],
  options: QueryOptions = {},
): WorldObservation[] {
  return queryObservations(items, options)
    .slice()
    .sort(
      (a, b) =>
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
        a.id.localeCompare(b.id),
    );
}
export const analystQuery = rankObservations;
const CITIES: [string, string, number, number][] = [
  ["London", "GB", 51.5074, -0.1278],
  ["New York", "US", 40.7128, -74.006],
  ["Los Angeles", "US", 34.0522, -118.2437],
  ["Tokyo", "JP", 35.6762, 139.6503],
  ["Singapore", "SG", 1.3521, 103.8198],
  ["Sydney", "AU", -33.8688, 151.2093],
  ["Reykjavik", "IS", 64.1466, -21.9426],
  ["San Francisco", "US", 37.7749, -122.4194],
  ["Washington", "US", 38.9072, -77.0369],
];
export function formatGeoUri(point: GeoPoint): string {
  if (!validatePoint(point)) throw new Error("Invalid coordinate");
  return `geo:${point.lat.toFixed(6)},${point.lon.toFixed(6)}${point.uncertaintyM === undefined ? "" : `;u=${point.uncertaintyM.toFixed(1)}`}`;
}
export function parseGeoUri(uri: string): GeoPoint {
  const m =
    /^geo:([+-]?(?:\d+(?:\.\d*)?|\.\d+)),([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:;u=([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?$/i.exec(
      uri.trim(),
    );
  if (!m) throw new Error("Invalid geo URI");
  const p = {
    lat: Number(m[1]),
    lon: Number(m[2]),
    ...(m[3] === undefined ? {} : { uncertaintyM: Number(m[3]) }),
  };
  if (!validatePoint(p)) throw new Error("Invalid geo URI coordinate");
  return p;
}
export function searchCities(
  query: string,
  limit = 5,
): (GeoPoint & { name: string; country: string })[] {
  const q = query.trim().toLowerCase();
  if (!q || q.length > 80) return [];
  return CITIES.filter((c) => `${c[0]} ${c[1]}`.toLowerCase().includes(q))
    .slice(0, Math.max(0, Math.min(20, limit)))
    .map((c) => ({ name: c[0], country: c[1], lat: c[2], lon: c[3] }));
}
export function createDemoObservations(now = new Date()): WorldObservation[] {
  const observedAt = new Date(now).toISOString(),
    rows: [string, LayerId, number, number, string, number?][] = [
      [
        "aircraft-1",
        "aircraft",
        38.9072,
        -77.0369,
        "Demo research aircraft",
        3200,
      ],
      ["aircraft-2", "aircraft", 39.3, -76.42, "Demo regional aircraft", 7400],
      ["vessel-1", "vessels", 38.78, -76.48, "Demo survey vessel"],
      [
        "satellite-1",
        "satellites",
        39.1,
        -79,
        "Demo satellite (not propagated)",
        420000,
      ],
      ["quake-1", "earthquakes", 37.7749, -122.4194, "Demo seismic event"],
      ["fire-1", "fires", 38.65, -78.22, "Demo fire report (not a detection)"],
      ["weather-1", "weather", 38.95, -77.46, "Demo weather station"],
      [
        "traffic-1",
        "traffic",
        38.99,
        -77.1,
        "Demo aggregate road flow (not vehicles)",
      ],
      [
        "camera-1",
        "cameras",
        38.89,
        -77.07,
        "Demo public camera location (no feed)",
      ],
      [
        "alpr-1",
        "alpr",
        38.87,
        -77.13,
        "Demo ALPR location (no plates or imagery)",
      ],
      ["weather-2", "weather", 51.5074, -0.1278, "Demo London weather context"],
      ["vessel-2", "vessels", 1.35, 103.82, "Demo Singapore vessel"],
    ];
  return rows.map(([id, layer, lat, lon, label, altM]) => ({
    id: `demo-${id}`,
    layer,
    point: { lat, lon, ...(altM === undefined ? {} : { altM }) },
    observedAt,
    source: "SignalWarden synthetic demo",
    label: `${label} · SYNTHETIC`,
    freshness: "synthetic",
    properties: { demo: true, readOnly: true },
  }));
}
export interface SceneLayer {
  layer: ExtraLayerId;
  visible: boolean;
  opacity: number;
}
export interface Annotation {
  id: string;
  point: GeoPoint;
  text: string;
  color?: string;
  createdAt: string;
}
export interface DirectorKeyframe {
  atMs: number;
  center: GeoPoint;
  zoom: number;
  bearing?: number;
  pitch?: number;
}
export const SCENE_STYLES = [
  "standard",
  "CRT",
  "NVG",
  "FLIR",
  "Noir",
  "Snow",
] as const;
export type SceneStyle = (typeof SCENE_STYLES)[number];
export interface Scene {
  schemaVersion: 1;
  name: string;
  center: GeoPoint;
  zoom: number;
  layers: SceneLayer[];
  annotations: Annotation[];
  keyframes: DirectorKeyframe[];
  createdAt: string;
  style?: SceneStyle;
  detection?: boolean;
  tilt?: boolean;
  selectedId?: string | null;
}
export function validateAnnotation(v: unknown): v is Annotation {
  if (!obj(v)) return false;
  const x = v as any;
  return (
    typeof x.id === "string" &&
    x.id.length > 0 &&
    x.id.length <= 120 &&
    validatePoint(x.point) &&
    typeof x.text === "string" &&
    x.text.length <= 500 &&
    typeof x.createdAt === "string" &&
    Number.isFinite(Date.parse(x.createdAt)) &&
    (!own(x, "color") ||
      (typeof x.color === "string" && /^#[0-9a-f]{6}$/i.test(x.color)))
  );
}
export function validateKeyframe(v: unknown): v is DirectorKeyframe {
  if (!obj(v)) return false;
  const x = v as any;
  return (
    finite(x.atMs) &&
    x.atMs >= 0 &&
    x.atMs <= 86400000 &&
    validatePoint(x.center) &&
    finite(x.zoom) &&
    x.zoom >= 0 &&
    x.zoom <= 30 &&
    (!own(x, "bearing") || finite(x.bearing)) &&
    (!own(x, "pitch") || finite(x.pitch))
  );
}
export function validateScene(v: unknown): v is Scene {
  if (!obj(v)) return false;
  const x = v as any;
  const layers =
    Array.isArray(x.layers) &&
    x.layers.length <= 100 &&
    x.layers.every(
      (y: any) =>
        obj(y) &&
        typeof y.layer === "string" &&
        y.layer.length <= 80 &&
        typeof y.visible === "boolean" &&
        finite(y.opacity) &&
        y.opacity >= 0 &&
        y.opacity <= 1,
    );
  const anns =
    Array.isArray(x.annotations) &&
    x.annotations.length <= 500 &&
    x.annotations.every(validateAnnotation) &&
    new Set(x.annotations.map((a: any) => a.id)).size === x.annotations.length;
  const layerIds = Array.isArray(x.layers)
    ? new Set(x.layers.map((a: any) => a.layer))
    : new Set();
  const keys =
    Array.isArray(x.keyframes) &&
    x.keyframes.length <= 500 &&
    x.keyframes.every(validateKeyframe) &&
    x.keyframes.every(
      (a: any, i: number) => i === 0 || a.atMs >= x.keyframes[i - 1].atMs,
    );
  return (
    x.schemaVersion === 1 &&
    typeof x.name === "string" &&
    x.name.length <= 120 &&
    validatePoint(x.center) &&
    finite(x.zoom) &&
    x.zoom >= 0 &&
    x.zoom <= 30 &&
    layers &&
    layerIds.size === x.layers.length &&
    anns &&
    keys &&
    typeof x.createdAt === "string" &&
    Number.isFinite(Date.parse(x.createdAt)) &&
    (!own(x, "style") || SCENE_STYLES.includes(x.style)) &&
    (!own(x, "detection") || typeof x.detection === "boolean") &&
    (!own(x, "tilt") || typeof x.tilt === "boolean") &&
    (!own(x, "selectedId") ||
      x.selectedId === null ||
      (typeof x.selectedId === "string" && x.selectedId.length <= 120))
  );
}
function boundedJson(v: unknown, max: number): string {
  const s = JSON.stringify(v);
  if (s.length > max) throw new Error("Payload exceeds size limit");
  return s;
}
function safeScene(s: Scene): Scene {
  return {
    schemaVersion: 1,
    name: s.name,
    center: safePoint(s.center),
    zoom: s.zoom,
    layers: s.layers.map((x) => ({
      layer: x.layer,
      visible: x.visible,
      opacity: x.opacity,
    })),
    annotations: s.annotations.map((x) => ({
      id: x.id,
      point: safePoint(x.point),
      text: x.text,
      ...(x.color === undefined ? {} : { color: x.color }),
      createdAt: x.createdAt,
    })),
    keyframes: s.keyframes.map((x) => ({
      atMs: x.atMs,
      center: safePoint(x.center),
      zoom: x.zoom,
      ...(x.bearing === undefined ? {} : { bearing: x.bearing }),
      ...(x.pitch === undefined ? {} : { pitch: x.pitch }),
    })),
    createdAt: s.createdAt,
    ...(s.style === undefined ? {} : { style: s.style }),
    ...(s.detection === undefined ? {} : { detection: s.detection }),
    ...(s.tilt === undefined ? {} : { tilt: s.tilt }),
    ...(s.selectedId === undefined ? {} : { selectedId: s.selectedId }),
  };
}
export function encodeScene(scene: Scene): string {
  if (!validateScene(scene)) throw new Error("Invalid scene");
  return encodeURIComponent(boundedJson(safeScene(scene), MAX_SCENE_BYTES));
}
export function decodeScene(encoded: string): Scene {
  if (typeof encoded !== "string" || encoded.length > MAX_SCENE_BYTES * 2)
    throw new Error("Scene payload exceeds size limit");
  let p: unknown;
  try {
    p = JSON.parse(decodeURIComponent(encoded));
  } catch {
    throw new Error("Invalid encoded scene");
  }
  if (!validateScene(p)) throw new Error("Unsupported or invalid scene schema");
  return safeScene(p);
}
export interface ObservationPack {
  schemaVersion: 1;
  exportedAt: string;
  observations: WorldObservation[];
}
export function exportObservationPack(
  observations: readonly WorldObservation[],
): string {
  if (observations.length > MAX_OBSERVATIONS)
    throw new Error("Observation count exceeds limit");
  const normalized = observations.map(normalizeObservation);
  if (new Set(normalized.map((x) => x.id)).size !== normalized.length)
    throw new Error("Observation IDs must be unique");
  return boundedJson(
    {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      observations: normalized,
    },
    MAX_PACK_BYTES,
  );
}
export function importObservationPack(encoded: string): ObservationPack {
  if (typeof encoded !== "string" || encoded.length > MAX_PACK_BYTES)
    throw new Error("Pack exceeds size limit");
  let p: any;
  try {
    p = JSON.parse(encoded);
  } catch {
    throw new Error("Invalid observation pack");
  }
  if (
    !obj(p) ||
    p.schemaVersion !== 1 ||
    typeof p.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(p.exportedAt)) ||
    Date.parse(p.exportedAt) > Date.now() + 60000 ||
    !Array.isArray(p.observations) ||
    p.observations.length > MAX_OBSERVATIONS ||
    !p.observations.every(validateObservation) ||
    new Set(p.observations.map((x: any) => x.id)).size !== p.observations.length
  )
    throw new Error("Invalid observation pack schema");
  return {
    schemaVersion: 1,
    exportedAt: new Date(p.exportedAt).toISOString(),
    observations: p.observations.map(normalizeObservation),
  };
}
export function interpolateObservation(
  a: WorldObservation,
  b: WorldObservation,
  at: string | number,
): WorldObservation {
  if (
    !validateObservation(a) ||
    !validateObservation(b) ||
    a.id !== b.id ||
    a.layer !== b.layer ||
    a.source !== b.source
  )
    throw new Error("Replay samples must share entity, layer, and source");
  const t = typeof at === "number" ? at : Date.parse(at),
    aa = Date.parse(a.observedAt),
    bb = Date.parse(b.observedAt);
  if (![t, aa, bb].every(Number.isFinite) || bb < aa)
    throw new Error("Invalid replay samples");
  const f = bb === aa ? 0 : Math.max(0, Math.min(1, (t - aa) / (bb - aa))),
    dl = ((b.point.lon - a.point.lon + 540) % 360) - 180;
  return {
    ...normalizeObservation(a),
    id: `${a.id}@${new Date(t).toISOString()}`,
    point: {
      lat: a.point.lat + (b.point.lat - a.point.lat) * f,
      lon: ((a.point.lon + dl * f + 540) % 360) - 180,
      ...(a.point.altM !== undefined && b.point.altM !== undefined
        ? { altM: a.point.altM + (b.point.altM - a.point.altM) * f }
        : {}),
    },
    observedAt: new Date(t).toISOString(),
    freshness:
      a.freshness === "synthetic" && b.freshness === "synthetic"
        ? "synthetic"
        : "fallback",
    properties: {
      ...(a.properties ?? {}),
      replayDisclosure: "interpolated; not live",
    },
  };
}
export function replayAt(
  samples: readonly WorldObservation[],
  at: string | number,
): WorldObservation[] {
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) throw new Error("Invalid replay time");
  const groups = new Map<string, WorldObservation[]>();
  for (const s of samples)
    if (validateObservation(s)) {
      const k = `${s.layer}:${s.id}`,
        g = groups.get(k) ?? [];
      g.push(s);
      groups.set(
        k,
        g.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)),
      );
    }
  return [...groups.values()].flatMap((g) => {
    const before = g.filter((x) => Date.parse(x.observedAt) <= t).at(-1),
      after = g.find((x) => Date.parse(x.observedAt) >= t);
    return before && after
      ? [interpolateObservation(before, after, t)]
      : before
        ? [
            {
              ...before,
              freshness:
                before.freshness === "fresh" ? "fallback" : before.freshness,
              properties: {
                ...(before.properties ?? {}),
                replayDisclosure: "historical replay; not live",
              },
            },
          ]
        : [];
  });
}
export interface ProviderInfo {
  id: string;
  name: string;
  layers: readonly ExtraLayerId[];
  endpoint: string;
  terms: string;
  attribution: string;
  keyRequired: boolean;
  limits: string;
}
export const SATELLITE_PASS_CAPABILITY = {
  supported: false,
  reason:
    "Orbital passes require an explicitly supplied TLE and an SGP4-capable dependency; this core never fabricates a pass or silently fetches TLEs.",
} as const;
export const PROVIDER_MATRIX: readonly ProviderInfo[] = [
  {
    id: "usgs",
    name: "USGS Earthquake Hazards Program",
    layers: ["earthquakes"],
    endpoint: "https://earthquake.usgs.gov/fdsnws/event/1/query",
    terms: "US public domain; courtesy attribution",
    attribution: "Data courtesy of the U.S. Geological Survey",
    keyRequired: false,
    limits: "Manual bounded query; no credential",
  },
  {
    id: "noaa-weather",
    name: "NOAA/NWS weather.gov",
    layers: ["weather"],
    endpoint: "https://api.weather.gov/points/{lat},{lon}",
    terms: "NWS public-data terms; no endorsement",
    attribution: "NOAA/National Weather Service",
    keyRequired: false,
    limits: "Manual point query; forecast only",
  },
  {
    id: "celestrak",
    name: "CelesTrak TLE catalog",
    layers: ["satellites"],
    endpoint: "https://celestrak.org",
    terms: "US-government-origin data; citation requested",
    attribution: "CelesTrak, Dr. T.S. Kelso",
    keyRequired: false,
    limits:
      "Catalog attribution only; no adapter/pass propagation in this core",
  },
  {
    id: "demo",
    name: "SignalWarden synthetic demo",
    layers: LAYER_IDS,
    endpoint: "local",
    terms: "Project-generated demo only",
    attribution: "SignalWarden; clearly synthetic",
    keyRequired: false,
    limits: "Bounded local sample",
  },
];
export interface ProviderResult {
  providerId: string;
  observations: WorldObservation[];
  retrievedAt: string;
  freshness: Freshness;
  error?: string;
}
export interface RefreshOptions {
  network?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
const MAX_PROVIDER_BYTES = 1_000_000,
  cache = new Map<string, { at: number; result: ProviderResult }>(),
  attempts = new Map<string, number>();
async function getJson(url: string, options: RefreshOptions): Promise<unknown> {
  if (options.network !== true)
    throw new Error("Network access is opt-in; pass {network:true}");
  const u = new URL(url);
  if (
    !(
      u.protocol === "https:" &&
      (u.hostname === "api.weather.gov" || u.hostname === "earthquake.usgs.gov")
    )
  )
    throw new Error("Provider host is not allowlisted");
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(),
      Math.max(1000, Math.min(15000, options.timeoutMs ?? 8000)),
    );
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const r = await fetch(url, {
      signal,
      redirect: "error",
      headers: { Accept: "application/geo+json, application/json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get("content-length") ?? 0) > MAX_PROVIDER_BYTES)
      throw new Error("Provider response exceeds 1 MB limit");
    if (!r.body) throw new Error("Provider returned no body");
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [],
      len = 0;
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_PROVIDER_BYTES) {
        await reader.cancel();
        throw new Error("Provider response exceeds 1 MB limit");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timer);
  }
}
function cachedFailure(
  key: string,
  providerId: string,
  error: string,
  now: string,
): ProviderResult {
  const old = cache.get(key)?.result;
  if (old)
    return {
      ...old,
      freshness: "stale",
      error: `Refresh failed; retained last snapshot: ${error}`,
      observations: old.observations.map((x) => ({
        ...x,
        freshness: "stale",
        stale: true,
      })),
    };
  return {
    providerId,
    observations: [],
    retrievedAt: now,
    freshness: "failed",
    error,
  };
}
export async function refreshUsgsEarthquakes(
  options: RefreshOptions = {},
): Promise<ProviderResult> {
  const now = new Date().toISOString(),
    key = "usgs";
  if (options.network !== true)
    return cachedFailure(
      key,
      key === "usgs" ? "usgs" : "noaa-weather",
      "Network access is opt-in",
      now,
    );
  if (cache.has(key) && Date.now() - cache.get(key)!.at < 60000)
    return cache.get(key)!.result;
  const family = key === "usgs" ? "usgs" : "noaa-weather";
  if (Date.now() - (attempts.get(family) ?? 0) < 60000)
    return cachedFailure(
      key,
      family,
      "Refresh throttled; wait 60 seconds",
      now,
    );
  attempts.set(family, Date.now());
  try {
    const start = new Date(Date.now() - 86400000).toISOString();
    const j = (await getJson(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=100&orderby=time-desc&starttime=${encodeURIComponent(start)}`,
      options,
    )) as any;
    const observations = (j.features ?? []).slice(0, 100).flatMap((f: any) => {
      const c = f.geometry?.coordinates,
        p = f.properties ?? {},
        ms =
          typeof p.time === "number" && Number.isFinite(p.time) ? p.time : NaN,
        mag = p.mag;
      if (
        !Array.isArray(c) ||
        !finite(c[0]) ||
        !finite(c[1]) ||
        c[1] < -90 ||
        c[1] > 90 ||
        c[0] < -180 ||
        c[0] > 180 ||
        !Number.isFinite(ms) ||
        !finite(mag)
      )
        return [];
      return [
        {
          id: `usgs-${String(f.id ?? "")}`,
          layer: "earthquakes",
          point: {
            lat: c[1],
            lon: c[0],
            ...(finite(c[2]) ? { altM: -c[2] * 1000 } : {}),
          },
          observedAt: new Date(ms).toISOString(),
          source: "USGS",
          label: String(p.place ?? "Earthquake").slice(0, MAX_STRING),
          freshness: "fresh",
          properties: { magnitude: mag },
        } as WorldObservation,
      ];
    });
    const r = {
      providerId: "usgs",
      observations: observations.filter(validateObservation),
      retrievedAt: now,
      freshness: "fresh" as Freshness,
    };
    cache.set(key, { at: Date.now(), result: r });
    return r;
  } catch (e) {
    return cachedFailure(
      key,
      "usgs",
      e instanceof Error ? e.message : "Request failed",
      now,
    );
  }
}
export async function refreshNoaaWeather(
  point: GeoPoint,
  options: RefreshOptions = {},
): Promise<ProviderResult> {
  if (!validatePoint(point)) throw new Error("Invalid weather point");
  const now = new Date().toISOString(),
    key = `noaa:${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  if (options.network !== true)
    return cachedFailure(
      key,
      key === "usgs" ? "usgs" : "noaa-weather",
      "Network access is opt-in",
      now,
    );
  if (cache.has(key) && Date.now() - cache.get(key)!.at < 60000)
    return cache.get(key)!.result;
  const family = key === "usgs" ? "usgs" : "noaa-weather";
  if (Date.now() - (attempts.get(family) ?? 0) < 60000)
    return cachedFailure(
      key,
      family,
      "Refresh throttled; wait 60 seconds",
      now,
    );
  attempts.set(family, Date.now());
  try {
    const meta = (await getJson(
      `https://api.weather.gov/points/${point.lat.toFixed(4)},${point.lon.toFixed(4)}`,
      options,
    )) as any;
    const forecast = meta?.properties?.forecast;
    if (typeof forecast !== "string")
      throw new Error("NOAA response has no forecast URL");
    const fu = new URL(forecast);
    if (
      fu.protocol !== "https:" ||
      fu.hostname !== "api.weather.gov" ||
      !/^\/gridpoints\/[^/]+\/[^/]+\/forecast$/.test(fu.pathname)
    )
      throw new Error("NOAA forecast URL is not allowlisted");
    const j = (await getJson(forecast, options)) as any,
      props = j?.properties ?? {},
      period = Array.isArray(props.periods) ? props.periods[0] : null;
    if (!period || typeof period.name !== "string")
      throw new Error("NOAA response has no forecast period");
    const observedAt =
      typeof props.updateTime === "string" &&
      Number.isFinite(Date.parse(props.updateTime))
        ? new Date(props.updateTime).toISOString()
        : typeof props.generatedAt === "string" &&
            Number.isFinite(Date.parse(props.generatedAt))
          ? new Date(props.generatedAt).toISOString()
          : "";
    if (!observedAt || Date.parse(observedAt) > Date.now() + 5000)
      throw new Error("Forecast issuance timestamp missing or invalid");
    const properties = {
      temperature: finite(period.temperature) ? period.temperature : null,
      temperatureUnit:
        typeof period.temperatureUnit === "string"
          ? period.temperatureUnit
          : "",
      windSpeed: typeof period.windSpeed === "string" ? period.windSpeed : "",
      shortForecast:
        typeof period.shortForecast === "string" ? period.shortForecast : "",
      validFrom: typeof period.startTime === "string" ? period.startTime : "",
      validTo: typeof period.endTime === "string" ? period.endTime : "",
    };
    const o: WorldObservation = {
      id: `noaa-weather-${point.lat.toFixed(3)}-${point.lon.toFixed(3)}`,
      layer: "weather",
      point: safePoint(point),
      observedAt,
      source: "NOAA/NWS weather.gov",
      label: `${period.name} forecast`,
      freshness: "fresh",
      properties,
    };
    const expires = Date.parse(String(properties.validTo)),
      state: Freshness = Number.isFinite(expires)
        ? expires > Date.now()
          ? "fresh"
          : "stale"
        : "unknown";
    o.freshness = state;
    const r = {
      providerId: "noaa-weather",
      observations: [o],
      retrievedAt: now,
      freshness: state,
    };
    cache.set(key, { at: Date.now(), result: r });
    return r;
  } catch (e) {
    return cachedFailure(
      key,
      "noaa-weather",
      e instanceof Error ? e.message : "Request failed",
      now,
    );
  }
}
export function providerStatus(
  result: ProviderResult,
  now = Date.now(),
): { status: Freshness; disclosure: string } {
  const retrieved = Date.parse(result.retrievedAt),
    age = now - retrieved;
  if (!Number.isFinite(retrieved) || age < 0)
    return {
      status: "unknown",
      disclosure: `${result.providerId} timestamp is invalid or in the future`,
    };
  if (result.error || result.freshness === "failed")
    return {
      status: "failed",
      disclosure: `${result.providerId} refresh failed; no live claim (${result.error ?? "unknown error"})`,
    };
  if (age > 15 * 60000)
    return {
      status: "stale",
      disclosure: `${result.providerId} snapshot is stale (${Math.round(age / 60000)} min old)`,
    };
  return {
    status: result.freshness,
    disclosure: `${result.providerId} ${result.freshness}; manually refreshed`,
  };
}
