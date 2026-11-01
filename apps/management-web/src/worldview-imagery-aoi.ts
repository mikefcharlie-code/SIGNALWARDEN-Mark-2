import type { LonLat } from "./worldview-draped-raster";

export type ImageryAoi = Readonly<{
  id: string;
  name: string;
  ring: ReadonlyArray<LonLat>;
}>;
export type ImageryAoiState = Readonly<{
  features: ReadonlyArray<ImageryAoi>;
  selectedId: string | null;
}>;

export const IMAGERY_AOI_STORAGE_KEY = "signalwarden.imagery-aoi.geofences.v1";
const MAX_FEATURES = 50;
const MAX_VERTICES = 128;

function closeRing(points: ReadonlyArray<LonLat>): LonLat[] {
  if (!Array.isArray(points) || points.length < 3 || points.length > MAX_VERTICES + 1) throw new Error("An imagery AOI needs 3–128 vertices");
  const ring = points.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) throw new Error("AOI vertices must be valid WGS84 longitude/latitude coordinates");
    return [point[0], point[1]] as const;
  });
  if (ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]) ring.pop();
  if (ring.length < 3 || ring.length > MAX_VERTICES) throw new Error("An imagery AOI needs 3–128 distinct vertices");
  const unique = new Set(ring.map(([lon, lat]) => `${lon.toFixed(8)},${lat.toFixed(8)}`));
  if (unique.size < 3) throw new Error("An imagery AOI needs at least 3 distinct vertices");
  ring.push(ring[0]);
  return ring;
}

export function createImageryAoi(name: string, points: ReadonlyArray<LonLat>, id = `imagery-aoi-${Date.now()}`): ImageryAoi {
  const label = name.trim();
  if (!label || label.length > 80) throw new Error("AOI name must be 1–80 characters");
  return { id, name: label, ring: closeRing(points) };
}

export function validateImageryAoiState(input: unknown): ImageryAoiState {
  if (!input || typeof input !== "object") return { features: [], selectedId: null };
  const raw = input as { features?: unknown; selectedId?: unknown };
  if (!Array.isArray(raw.features) || raw.features.length > MAX_FEATURES) return { features: [], selectedId: null };
  const features: ImageryAoi[] = [];
  for (const entry of raw.features) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { id?: unknown; name?: unknown; ring?: unknown };
    if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 120 || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 80 || !Array.isArray(value.ring)) continue;
    try { features.push({ id: value.id, name: value.name, ring: closeRing(value.ring as LonLat[]) }); } catch { /* Ignore malformed local preferences. */ }
  }
  const selectedId = typeof raw.selectedId === "string" && features.some((feature) => feature.id === raw.selectedId) ? raw.selectedId : null;
  return { features, selectedId };
}

export function readImageryAoiState(storage?: Pick<Storage, "getItem">): ImageryAoiState {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(IMAGERY_AOI_STORAGE_KEY);
    return raw ? validateImageryAoiState(JSON.parse(raw)) : { features: [], selectedId: null };
  } catch { return { features: [], selectedId: null }; }
}

export function writeImageryAoiState(state: ImageryAoiState, storage?: Pick<Storage, "setItem">): boolean {
  const safe = validateImageryAoiState(state);
  try { (storage ?? globalThis.localStorage).setItem(IMAGERY_AOI_STORAGE_KEY, JSON.stringify(safe)); return true; }
  catch { return false; }
}
