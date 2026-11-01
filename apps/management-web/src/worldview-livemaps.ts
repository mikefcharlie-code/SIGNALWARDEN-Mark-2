/**
 * Near-real-time, animatable WorldView map layers: precipitation radar and
 * geostationary satellite loops draped on the globe.
 *
 * Providers (all keyless and CORS-enabled, so no server relay is needed):
 *  - RainViewer Weather Maps API: global radar composite, past ~2 h at 10-min
 *    steps, z<=7, 100 requests/IP/min, personal/educational use only.
 *  - Iowa Environmental Mesonet (IEM): US NEXRAD base-reflectivity (N0Q)
 *    composite every 5 min; public domain, attribution appreciated.
 *  - NASA GIBS WMTS: GOES-East / GOES-West ABI and Himawari AHI imagery at
 *    10-min cadence (no Meteosat layer is published in GIBS).
 *
 * Nothing here performs a request on import, render or default state. Every
 * read is opt-in (`network: true`), host-allowlisted, size/time bounded and
 * rate-limited; tile reads reuse the basemap TileLoader (LRU cache,
 * per-provider throttle, no redirects, no credentials, no referrer).
 */
import { GIBS_ORIGIN, formatAge, type TileCoord, type TileSource } from "./worldview-basemap";

export const RAINVIEWER_API_URL = "https://api.rainviewer.com/public/weather-maps.json";
export const RAINVIEWER_TILE_ORIGIN = "https://tilecache.rainviewer.com";
export const IEM_ORIGIN = "https://mesonet.agron.iastate.edu";
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_FRAMES = 12;
export const MAX_TILES_PER_FRAME = 16;
export const FRAME_WINDOW_MS = 2 * 3_600_000;
export const PLAY_INTERVAL_MS = 700;
export const REDUCED_MOTION_INTERVAL_MS = 1_500;
export const LAST_FRAME_DWELL_MS = 1_800;

export type LiveChannel = "radar" | "satellite";
export type LiveLayerId =
  | "rainviewer-radar"
  | "iem-nexrad-n0q"
  | "gibs-goes-east-ir"
  | "gibs-goes-west-ir"
  | "gibs-himawari-ir"
  | "gibs-goes-east-geocolor"
  | "gibs-goes-west-geocolor"
  | "gibs-himawari-visible";

export type LiveLayer = Readonly<{
  id: LiveLayerId;
  channel: LiveChannel;
  kind: "rainviewer" | "iem" | "gibs";
  label: string;
  /** Provider update interval. Auto-refresh is never faster than this. */
  cadenceMs: number;
  /** Age (latest frame vs. now) thresholds for the freshness badge. */
  liveWithinMs: number;
  delayedWithinMs: number;
  maxZoom: number;
  perMinute: number;
  concurrency: number;
  attribution: string;
  termsUrl: string;
  licenseNote: string;
  coverageNote: string;
  timeNote: string;
  defaultOpacity: number;
  gibsLayer?: string;
  gibsMatrixSet?: string;
  /** RainViewer's free API is limited to personal / educational use. */
  requiresUseAcknowledgement?: boolean;
}>;

const NASA_TERMS = "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance";
const GIBS_CREDIT = (sat: string) => `NASA EOSDIS GIBS / Worldview; ${sat} imagery courtesy NOAA/NESDIS${sat.startsWith("Himawari") ? " and JMA" : ""}`;
const gibs = (id: LiveLayerId, label: string, layer: string, level: 6 | 7, sat: string, coverage: string): LiveLayer => ({
  id, channel: "satellite", kind: "gibs", label, cadenceMs: 10 * 60_000, liveWithinMs: 60 * 60_000, delayedWithinMs: 3 * 3_600_000,
  maxZoom: level, perMinute: 240, concurrency: 4, attribution: GIBS_CREDIT(sat), termsUrl: NASA_TERMS,
  licenseNote: "NASA open data; no copyright restriction; credit requested", coverageNote: coverage,
  timeNote: "Frame time is the GIBS layer time (scan start, UTC) reported by DescribeDomains / layer-time-actual. GIBS near-real-time latency is typically 20-60 minutes.",
  defaultOpacity: 0.85, gibsLayer: layer, gibsMatrixSet: `GoogleMapsCompatible_Level${level}`,
});

export const LIVE_LAYERS: Readonly<Record<LiveLayerId, LiveLayer>> = Object.freeze({
  "rainviewer-radar": {
    id: "rainviewer-radar", channel: "radar", kind: "rainviewer", label: "RainViewer · global radar composite (past 2 h, 10-min frames)",
    cadenceMs: 10 * 60_000, liveWithinMs: 25 * 60_000, delayedWithinMs: 60 * 60_000, maxZoom: 7, perMinute: 60, concurrency: 2,
    attribution: "Weather data by RainViewer (rainviewer.com)", termsUrl: "https://www.rainviewer.com/api.html",
    licenseNote: "RainViewer free API: personal/educational use only, no SLA, attribution required, 100 requests/IP/min",
    coverageNote: "Mosaic of ~1,200 national weather radars; large gaps over oceans, Africa and much of Asia/South America. Owners can withdraw radars at any time. Not an aviation or warning product.",
    timeNote: "Frame time is RainViewer's frame generation time; individual radars inside a frame can be older.",
    defaultOpacity: 0.75, requiresUseAcknowledgement: true,
  },
  "iem-nexrad-n0q": {
    id: "iem-nexrad-n0q", channel: "radar", kind: "iem", label: "IEM · US NEXRAD base reflectivity composite (N0Q, 5-min)",
    cadenceMs: 5 * 60_000, liveWithinMs: 15 * 60_000, delayedWithinMs: 45 * 60_000, maxZoom: 8, perMinute: 120, concurrency: 2,
    attribution: "NEXRAD composite: Iowa Environmental Mesonet, Iowa State University; source data NOAA/NWS", termsUrl: "https://mesonet.agron.iastate.edu/disclaimer.php",
    licenseNote: "IEM products are public domain; attribution appreciated; provided without warranty and not an operational service",
    coverageNote: "Contiguous US NEXRAD network only (no Alaska/Hawaii/Puerto Rico in this composite). Base reflectivity includes ground clutter, beam blockage and non-weather echoes.",
    timeNote: "Frame time is the composite valid time (UTC) from the IEM scan list.",
    defaultOpacity: 0.75,
  },
  "gibs-goes-east-ir": gibs("gibs-goes-east-ir", "NASA GIBS · GOES-East ABI clean infrared (Band 13)", "GOES-East_ABI_Band13_Clean_Infrared", 6, "GOES-East", "Americas and Atlantic disk (~75.2°W); limb distortion toward the disk edge. Brightness temperature, not cloud height."),
  "gibs-goes-west-ir": gibs("gibs-goes-west-ir", "NASA GIBS · GOES-West ABI clean infrared (Band 13)", "GOES-West_ABI_Band13_Clean_Infrared", 6, "GOES-West", "Eastern/central Pacific and western Americas disk (~137.0°W)."),
  "gibs-himawari-ir": gibs("gibs-himawari-ir", "NASA GIBS · Himawari AHI clean infrared (Band 13)", "Himawari_AHI_Band13_Clean_Infrared", 6, "Himawari", "East Asia, Australia and western Pacific disk (~140.7°E)."),
  "gibs-goes-east-geocolor": gibs("gibs-goes-east-geocolor", "NASA GIBS · GOES-East ABI GeoColor", "GOES-East_ABI_GeoColor", 7, "GOES-East", "Americas and Atlantic disk; GeoColor blends true colour by day with an IR/city-lights rendering at night."),
  "gibs-goes-west-geocolor": gibs("gibs-goes-west-geocolor", "NASA GIBS · GOES-West ABI GeoColor", "GOES-West_ABI_GeoColor", 7, "GOES-West", "Pacific and western Americas disk; GeoColor blends true colour by day with an IR rendering at night."),
  "gibs-himawari-visible": gibs("gibs-himawari-visible", "NASA GIBS · Himawari AHI red visible (Band 3)", "Himawari_AHI_Band3_Red_Visible_1km", 7, "Himawari", "East Asia/Australia disk; visible band is dark at night."),
});

export const RADAR_LAYERS: LiveLayerId[] = ["rainviewer-radar", "iem-nexrad-n0q"];
export const SATELLITE_LAYERS: LiveLayerId[] = ["gibs-goes-east-ir", "gibs-goes-west-ir", "gibs-himawari-ir", "gibs-goes-east-geocolor", "gibs-goes-west-geocolor", "gibs-himawari-visible"];

// ---------------------------------------------------------------- frames
export type LiveFrame = Readonly<{
  /** Stable id used in the tile cache key. */
  id: string;
  /** Provider frame time (ISO UTC). */
  time: string;
  timeMs: number;
  /** Provider-specific locator (RainViewer path, IEM stamp, GIBS ISO time). */
  locator: string;
  kind: "observed" | "nowcast";
}>;

export type FrameList = Readonly<{
  layerId: LiveLayerId;
  frames: LiveFrame[];
  sourceUrl: string;
  retrievedAt: string;
  /** Provider-reported generation time when available. */
  providerTime?: string;
  host?: string;
}>;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type LiveFetchOptions = { network: boolean; fetcher?: Fetcher; signal?: AbortSignal; timeoutMs?: number; now?: number };

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const allowedJsonUrl = (url: string): boolean => {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443")) return false;
  if (url === RAINVIEWER_API_URL) return true;
  if (u.origin === IEM_ORIGIN) return u.pathname === "/json/radar.py";
  if (u.origin === GIBS_ORIGIN) return u.pathname === "/wmts/epsg3857/best/wmts.cgi" && u.searchParams.get("REQUEST") === "DescribeDomains";
  return false;
};

/** Bounded GET for the small frame-list documents (JSON or XML text). */
export async function fetchLiveText(url: string, opts: LiveFetchOptions): Promise<string> {
  if (opts.network !== true) throw new Error("Network access is opt-in; enable live map requests first");
  if (!allowedJsonUrl(url)) throw new Error("Frame-list URL is not on the live-maps allowlist");
  const fetcher = opts.fetcher ?? ((u: string, i: RequestInit) => fetch(u, i));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(20_000, opts.timeoutMs ?? 12_000)));
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetcher(url, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", signal, headers: { Accept: "application/json, text/xml;q=0.9" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_JSON_BYTES || !response.body) throw new Error("Frame list exceeds 256 KiB or has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_JSON_BYTES) { await reader.cancel(); throw new Error("Frame list exceeds 256 KiB"); }
      chunks.push(part.value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
    return new TextDecoder().decode(all);
  } finally {
    clearTimeout(timer);
  }
}

const RV_PATH = /^\/v2\/radar\/[A-Za-z0-9_-]{1,64}$/;
/** Parses RainViewer weather-maps.json (v2). Nowcast frames are kept (labelled) if the provider ever returns them. */
export function parseRainViewer(body: unknown, now: number): { frames: LiveFrame[]; host: string; providerTime?: string } {
  const b = body as any;
  if (!b || typeof b !== "object") throw new Error("RainViewer response is not an object");
  if (b.host !== RAINVIEWER_TILE_ORIGIN) throw new Error("RainViewer tile host is not the expected tilecache.rainviewer.com");
  const take = (list: unknown, kind: LiveFrame["kind"]): LiveFrame[] => (Array.isArray(list) ? list : []).slice(0, 64).flatMap((f: any) => {
    if (!f || !Number.isInteger(f.time) || typeof f.path !== "string" || !RV_PATH.test(f.path)) return [];
    const ms = f.time * 1000;
    if (ms < now - 6 * 3_600_000 || ms > now + 3 * 3_600_000) return [];
    return [{ id: f.path.slice("/v2/radar/".length), time: iso(ms), timeMs: ms, locator: f.path, kind }];
  });
  const frames = [...take(b.radar?.past, "observed"), ...take(b.radar?.nowcast, "nowcast")].sort((x, y) => x.timeMs - y.timeMs);
  return { frames, host: b.host, providerTime: Number.isInteger(b.generated) ? iso(b.generated * 1000) : undefined };
}

const IEM_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?Z$/;
/** Parses the IEM json/radar.py?operation=list scan list ({"scans":[{"ts":"YYYY-MM-DDTHH:MMZ"}]}). */
export function parseIemScans(body: unknown, now: number): LiveFrame[] {
  const scans = (body as any)?.scans;
  if (!Array.isArray(scans)) throw new Error("IEM scan list missing");
  return scans.slice(0, 600).flatMap((s: any) => {
    const m = typeof s?.ts === "string" ? IEM_TS.exec(s.ts) : null;
    if (!m) return [];
    const parts = m.slice(1, 6).map(Number);
    const ms = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
    const date = new Date(ms);
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2] || date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4]) return [];
    if (!Number.isFinite(ms) || ms > now + 10 * 60_000 || ms < now - 6 * 3_600_000) return [];
    const stamp = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`;
    return [{ id: stamp, time: iso(ms), timeMs: ms, locator: stamp, kind: "observed" as const }];
  }).sort((a: LiveFrame, b: LiveFrame) => a.timeMs - b.timeMs);
}

const DUR = /^PT(?:(\d{1,2})H)?(?:(\d{1,3})M)?$/;
/**
 * Parses a GIBS WMTS DescribeDomains document: a comma-separated list of
 * `start/end/PTnM` intervals inside <Domain>. Expands to frame times inside
 * [from, to], capped.
 */
export function parseGibsDomains(xml: string, from: number, to: number, cap = 400): LiveFrame[] {
  if (typeof xml !== "string" || xml.length > MAX_JSON_BYTES) throw new Error("GIBS domain document invalid");
  if (/<ExceptionReport/i.test(xml)) throw new Error("GIBS returned an exception report (layer or time unavailable)");
  const m = /<Domain>([^<]{0,20000})<\/Domain>/.exec(xml);
  if (!m) throw new Error("GIBS DescribeDomains response has no time domain");
  const out = new Map<number, LiveFrame>();
  for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500)) {
    const [a, b = a, p = "PT10M"] = part.split("/");
    const start = Date.parse(a), end = Date.parse(b);
    const d = DUR.exec(p);
    const step = d ? (Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0)) * 60_000 : 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || step < 60_000) continue;
    const first = start < from ? start + Math.ceil((from - start) / step) * step : start;
    for (let t = first; t <= Math.min(end, to) && out.size < cap; t += step) {
      const time = iso(t);
      out.set(t, { id: time, time, timeMs: t, locator: time, kind: "observed" });
    }
  }
  return [...out.values()].sort((x, y) => x.timeMs - y.timeMs);
}

/**
 * Keeps at most `max` frames inside the window ending at the newest frame:
 * always the newest, then evenly spaced older frames (so a 5-min feed shows a
 * 2-hour loop at ~10-min steps instead of only the last hour).
 */
export function pickFrames(frames: readonly LiveFrame[], max = MAX_FRAMES, windowMs = FRAME_WINDOW_MS): LiveFrame[] {
  if (!frames.length) return [];
  const sorted = [...frames].sort((a, b) => a.timeMs - b.timeMs);
  const newest = sorted[sorted.length - 1].timeMs;
  const inWindow = sorted.filter((f) => f.timeMs >= newest - windowMs);
  if (inWindow.length <= max) return inWindow;
  const picked: LiveFrame[] = [];
  const stride = (inWindow.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) picked.push(inWindow[Math.round(inWindow.length - 1 - (max - 1 - i) * stride)]);
  return [...new Map(picked.map((f) => [f.id, f])).values()];
}

export function frameListUrl(layer: LiveLayer, now: number): string {
  if (layer.kind === "rainviewer") return RAINVIEWER_API_URL;
  const from = iso(now - FRAME_WINDOW_MS - 30 * 60_000), to = iso(now + 5 * 60_000);
  if (layer.kind === "iem") {
    const short = (s: string) => s.slice(0, 16) + "Z";
    return `${IEM_ORIGIN}/json/radar.py?operation=list&product=N0Q&radar=USCOMP&start=${short(from)}&end=${short(to)}`;
  }
  // GIBS: the window starts 3 h back so GIBS latency still leaves ~2 h of frames.
  const gfrom = iso(now - FRAME_WINDOW_MS - 3_600_000);
  return `${GIBS_ORIGIN}/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=${layer.gibsLayer}&TILEMATRIXSET=${layer.gibsMatrixSet}&TIME=${gfrom}/${to}`;
}

/** Fetches and parses the provider's current frame list. */
export async function fetchFrameList(layerId: LiveLayerId, opts: LiveFetchOptions): Promise<FrameList> {
  const layer = LIVE_LAYERS[layerId];
  if (!layer) throw new Error("Unknown live layer");
  const now = opts.now ?? Date.now();
  const url = frameListUrl(layer, now);
  const text = await fetchLiveText(url, opts);
  const retrievedAt = iso(now);
  if (layer.kind === "gibs") {
    const frames = pickFrames(parseGibsDomains(text, now - FRAME_WINDOW_MS - 3_600_000, now + 5 * 60_000));
    if (!frames.length) throw new Error("Invalid frame-list payload: no valid frames");
    return { layerId, frames, sourceUrl: url, retrievedAt };
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error("Frame list was not valid JSON"); }
  if (layer.kind === "rainviewer") {
    const parsed = parseRainViewer(body, now);
    const frames = pickFrames(parsed.frames);
    if (!frames.length) throw new Error("Invalid frame-list payload: no valid frames");
    return { layerId, frames, sourceUrl: url, retrievedAt, providerTime: parsed.providerTime, host: parsed.host };
  }
  const gen = (body as any)?.generated_at;
  const frames = pickFrames(parseIemScans(body, now));
  if (!frames.length) throw new Error("Invalid frame-list payload: no valid frames");
  return { layerId, frames, sourceUrl: url, retrievedAt, providerTime: typeof gen === "string" && Number.isFinite(Date.parse(gen)) ? iso(Date.parse(gen)) : undefined };
}

// ---------------------------------------------------------------- tiles
const assertTile = (t: TileCoord, maxZoom: number) => {
  if (!Number.isInteger(t.z) || t.z < 0 || t.z > maxZoom || !Number.isInteger(t.x) || !Number.isInteger(t.y) || t.x < 0 || t.y < 0 || t.x >= 2 ** t.z || t.y >= 2 ** t.z)
    throw new Error("tile coordinate out of range");
};

export function liveTileUrl(layerId: LiveLayerId, frame: LiveFrame, t: TileCoord): string {
  const layer = LIVE_LAYERS[layerId];
  if (!layer) throw new Error("Unknown live layer");
  assertTile(t, layer.maxZoom);
  if (layer.kind === "rainviewer") {
    if (!RV_PATH.test(frame.locator)) throw new Error("invalid RainViewer frame path");
    // 256 px tiles, colour scheme 2 (Universal Blue, the only scheme still offered), smoothed, snow colours on.
    return `${RAINVIEWER_TILE_ORIGIN}${frame.locator}/256/${t.z}/${t.x}/${t.y}/2/1_1.png`;
  }
  if (layer.kind === "iem") {
    if (!/^\d{12}$/.test(frame.locator)) throw new Error("invalid IEM frame stamp");
    return `${IEM_ORIGIN}/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${frame.locator}/${t.z}/${t.x}/${t.y}.png`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(frame.locator)) throw new Error("invalid GIBS frame time");
  return `${GIBS_ORIGIN}/wmts/epsg3857/best/${layer.gibsLayer}/default/${frame.locator}/${layer.gibsMatrixSet}/${t.z}/${t.y}/${t.x}.png`;
}

/** Tile source for one frame, consumable by the shared basemap TileLoader. */
export function liveFrameSource(layerId: LiveLayerId, frame: LiveFrame): TileSource {
  const layer = LIVE_LAYERS[layerId];
  if (!layer) throw new Error("Unknown live layer");
  return {
    sourceId: `${layer.id}@${frame.id}`, provider: layer.label, attribution: layer.attribution, termsUrl: layer.termsUrl,
    licenseNote: layer.licenseNote, requestedDate: frame.time, urlFor: (t) => liveTileUrl(layerId, frame, t),
    freshnessFor: (_time, at) => { const f = layerFreshness(layer, frame.timeMs, at); return { freshness: f.status === "live" ? "recent" : f.status === "unknown" ? "unknown" : "stale", ageMs: f.ageMs }; },
    concurrency: layer.concurrency, perMinute: layer.perMinute,
    ...(layer.kind === "rainviewer" ? { allowOrigin: RAINVIEWER_TILE_ORIGIN } : layer.kind === "iem" ? { allowOrigin: IEM_ORIGIN } : {}),
  };
}

// ---------------------------------------------------------------- freshness / timing
export type LiveFreshness = "live" | "delayed" | "stale" | "unknown";
export function layerFreshness(layer: LiveLayer, latestFrameMs: number | null | undefined, now: number): { status: LiveFreshness; ageMs: number | null } {
  if (latestFrameMs == null || !Number.isFinite(latestFrameMs) || latestFrameMs > now + 15 * 60_000) return { status: "unknown", ageMs: null };
  const ageMs = Math.max(0, now - latestFrameMs);
  return { status: ageMs <= layer.liveWithinMs ? "live" : ageMs <= layer.delayedWithinMs ? "delayed" : "stale", ageMs };
}

/** Auto-refresh choices for a layer: its own cadence, 2x and 3x. Never faster than the provider updates. */
export function refreshChoices(layer: LiveLayer): number[] { return [1, 2, 3].map((k) => layer.cadenceMs * k); }
export function clampRefreshMs(layer: LiveLayer, requestedMs: number): number {
  if (!Number.isFinite(requestedMs)) return layer.cadenceMs;
  return Math.max(layer.cadenceMs, Math.min(layer.cadenceMs * 6, Math.round(requestedMs)));
}

export function formatUtc(ms: number): string {
  if (!Number.isFinite(ms)) return "time unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
export function formatLocal(ms: number, locale?: string, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "time unknown";
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).format(ms);
  } catch {
    return new Date(ms).toString();
  }
}
export { formatAge };

/** Unified timeline across active channels (sorted unique frame times). */
export function mergeTimeline(lists: ReadonlyArray<readonly LiveFrame[]>): number[] {
  return [...new Set(lists.flatMap((l) => l.map((f) => f.timeMs)))].sort((a, b) => a - b);
}
/** Frame of a channel to show at a timeline cursor: latest frame at or before it, else the earliest. */
export function frameAt(frames: readonly LiveFrame[], cursorMs: number): LiveFrame | null {
  if (!frames.length) return null;
  let best: LiveFrame | null = null;
  for (const f of frames) if (f.timeMs <= cursorMs && (!best || f.timeMs > best.timeMs)) best = f;
  return best ?? frames.reduce((a, b) => (a.timeMs <= b.timeMs ? a : b));
}
export function stepIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
/** Delay before advancing from `index`: a longer dwell on the newest frame. */
export function playDelayMs(index: number, length: number, reducedMotion: boolean): number {
  const base = reducedMotion ? REDUCED_MOTION_INTERVAL_MS : PLAY_INTERVAL_MS;
  return index >= length - 1 ? Math.max(base, LAST_FRAME_DWELL_MS) : base;
}
/** Order in which frames are loaded: newest first, so the current state appears before the loop fills in. */
export function loadOrder(frames: readonly LiveFrame[]): LiveFrame[] { return [...frames].sort((a, b) => b.timeMs - a.timeMs); }

export function prefersReducedMotion(): boolean {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

// ---------------------------------------------------------------- globe hand-off
export type LiveOverlayTile = Readonly<{ key: string; tile: TileCoord; image: unknown }>;
export type LiveOverlayChannel = Readonly<{
  channel: LiveChannel;
  layerId: LiveLayerId;
  frameKey: string;
  frameTime: string;
  tiles: ReadonlyArray<LiveOverlayTile>;
  opacity: number;
  credit: Readonly<{ text: string; termsUrl: string }>;
  freshness: LiveFreshness;
}>;
export type LiveOverlay = Readonly<{ channels: ReadonlyArray<LiveOverlayChannel> }>;

// ---------------------------------------------------------------- live data summary strip
export type LiveFeedRow = Readonly<{
  id: string;
  label: string;
  kind: "provider" | "feed-records" | "globe-imagery" | "basemap" | "live-map";
  status: LiveFreshness | "failed";
  ageMs: number | null;
  detail: string;
}>;
type ProviderLike = { providerId: string; retrievedAt: string; freshness: string; error?: string; observations?: ReadonlyArray<{ id: string }> };
type RecordLike = { id: string; source: string; observedAt: string; freshness?: string; stale?: boolean; properties?: Record<string, unknown> };
type ImageryLike = { key: string; provider: string; retrievedAt: string; acquisitionStart?: string; freshness: string; refreshState?: string };
export type LiveChannelStatus = Readonly<{ layerId: LiveLayerId; latestFrameMs: number | null; retrievedAt?: string; error?: string; stale?: boolean; framesReady: number; framesTotal: number }>;
export type LiveFeedInput = {
  providerResults?: Readonly<Record<string, ProviderLike>>;
  records?: ReadonlyArray<RecordLike>;
  imagery?: Readonly<Record<string, ImageryLike>> | ReadonlyArray<ImageryLike>;
  basemap?: { sourceId: string; credits: ReadonlyArray<{ provider: string; text: string }> } | null;
  liveChannels?: ReadonlyArray<LiveChannelStatus>;
  /** Bounded, precomputed rows from independent live context layers (for example daily GPSJAM). */
  extraRows?: ReadonlyArray<LiveFeedRow>;
};

const STALE_FEED_MS = 15 * 60_000;
const ageOf = (iso: unknown, now: number): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t <= now + 60_000 ? Math.max(0, now - t) : null;
};

/**
 * Read-only roll-up of which live layers/feeds are active across WorldView and
 * how old they are. Synthetic demo rows and imported packs (no retrieval time)
 * are excluded; nothing here makes a request.
 */
export function summarizeLiveFeeds(input: LiveFeedInput, now: number): LiveFeedRow[] {
  const rows: LiveFeedRow[] = [];
  const covered = new Set<string>();
  for (const r of Object.values(input.providerResults ?? {})) {
    if (!r || typeof r.providerId !== "string") continue;
    (r.observations ?? []).forEach((o) => covered.add(o.id));
    const ageMs = ageOf(r.retrievedAt, now);
    const status: LiveFeedRow["status"] = r.error || r.freshness === "failed" ? "failed" : ageMs === null ? "unknown" : r.freshness === "stale" || ageMs > STALE_FEED_MS ? "stale" : "live";
    rows.push({ id: `provider:${r.providerId}`, label: r.providerId, kind: "provider", status, ageMs, detail: r.error ? r.error.slice(0, 160) : `${r.observations?.length ?? 0} observations` });
  }
  const groups = new Map<string, { n: number; newest: number | null; stale: number }>();
  for (const o of input.records ?? []) {
    if (!o || covered.has(o.id) || o.freshness === "synthetic") continue;
    const retrieved = o.properties?.retrievedAt;
    if (typeof retrieved !== "string") continue; // imported packs / synthetic rows carry no retrieval time
    const name = typeof o.properties?.provider === "string" ? (o.properties.provider as string) : o.source;
    const g = groups.get(name) ?? { n: 0, newest: null, stale: 0 };
    const age = ageOf(retrieved, now);
    g.n++;
    if (age !== null) g.newest = g.newest === null ? age : Math.min(g.newest, age);
    if (o.stale || o.freshness === "stale") g.stale++;
    groups.set(name, g);
  }
  for (const [name, g] of groups) {
    const status: LiveFeedRow["status"] = g.newest === null ? "unknown" : g.stale === g.n || g.newest > STALE_FEED_MS ? "stale" : "live";
    rows.push({ id: `records:${name}`, label: name.slice(0, 80), kind: "feed-records", status, ageMs: g.newest, detail: `${g.n} records on the globe` });
  }
  const imagery = Array.isArray(input.imagery) ? input.imagery : Object.values(input.imagery ?? {});
  for (const l of imagery.slice(0, 8)) {
    const ageMs = ageOf(l.acquisitionStart ?? l.retrievedAt, now);
    rows.push({ id: `imagery:${l.key}`, label: l.provider, kind: "globe-imagery", status: l.refreshState === "retained-failed" ? "failed" : l.freshness === "recent" ? "live" : l.freshness === "stale" ? "stale" : "unknown", ageMs, detail: l.acquisitionStart ? "age from acquisition time" : "age from retrieval time" });
  }
  if (input.basemap && input.basemap.credits.length) {
    rows.push({ id: "basemap", label: input.basemap.credits.map((c) => c.provider).join(" + "), kind: "basemap", status: "unknown", ageMs: null, detail: "Imagery/terrain tiles; age is per provider date (see imagery panel)" });
  }
  for (const c of input.liveChannels ?? []) {
    const layer = LIVE_LAYERS[c.layerId];
    if (!layer) continue;
    const f = layerFreshness(layer, c.latestFrameMs, now);
    rows.push({ id: `live:${c.layerId}`, label: layer.label, kind: "live-map", status: c.error && c.latestFrameMs == null ? "failed" : c.stale ? "stale" : f.status, ageMs: f.ageMs, detail: c.error ? c.error.slice(0, 160) : `${c.framesReady}/${c.framesTotal} frames loaded` });
  }
  for (const row of (input.extraRows ?? []).slice(0, 8)) {
    if (row && typeof row.id === "string") rows.push(row);
  }
  return rows;
}
