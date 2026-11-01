import { fetchSarBrowse, searchSar, type SarQuery, type SarScene, type SarSearchResult } from "./worldview-sar";
import type { GlobeBounds } from "./worldview-globe-viewport";

export const ASF_VIEWPORT_LOOKBACK_DAYS = 30;
export type ViewportCatalogResult = Readonly<{
  scenes: SarScene[];
  latest: SarScene | null;
  fetchedAt: string;
  queryBoxes: readonly GlobeBounds[];
  possiblyTruncated: boolean;
}>;
type Search = (query: SarQuery, signal: AbortSignal) => Promise<SarSearchResult>;
type Browse = (url: string, signal: AbortSignal) => Promise<Blob>;
const validateBounds = (bounds: readonly GlobeBounds[]) => {
  const safe = bounds.slice(0, 2);
  if (!safe.length || safe.some((b) => !Number.isFinite(b.west) || !Number.isFinite(b.east) || !Number.isFinite(b.south) || !Number.isFinite(b.north) || b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90 || b.west >= b.east || b.south >= b.north)) throw new Error("Invalid or empty visible-globe bounds");
  return safe;
};

/** Search only the visible camera bbox(es), split at the date line, never application context. */
export async function searchSarViewport(
  bounds: readonly GlobeBounds[],
  signal: AbortSignal,
  search: Search = searchSar,
  now: () => number = Date.now,
): Promise<ViewportCatalogResult> {
  const queryBoxes = validateBounds(bounds);
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  const stamp = now();
  const end = new Date(stamp).toISOString().slice(0, 10);
  const start = new Date(stamp - ASF_VIEWPORT_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const queries: SarQuery[] = queryBoxes.map((box) => ({ ...box, start: `${start}T00:00:00Z`, end: `${end}T23:59:59Z` }));
  const results = await Promise.all(queries.map((query) => search(query, signal)));
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  const scenes = [...new Map(results.flatMap((result) => result.scenes).map((scene) => [scene.id, scene])).values()]
    .sort((a, b) => Date.parse(b.acquisitionStart) - Date.parse(a.acquisitionStart))
    .slice(0, 50);
  const fetchedAt = results.map((result) => result.fetchedAt).sort().at(-1) ?? new Date(stamp).toISOString();
  return {
    scenes,
    latest: scenes[0] ?? null,
    fetchedAt,
    queryBoxes,
    possiblyTruncated: results.some((result) => result.possiblyTruncated) || scenes.length >= 50,
  };
}

/** Fetch at most the one explicitly chosen newest browse asset, through the existing fixed ASF relay. */
export async function fetchSarViewportPreview(scene: SarScene, signal: AbortSignal, browse: Browse = fetchSarBrowse): Promise<Blob | null> {
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  if (!scene.browseUrl) return null;
  const blob = await browse(scene.browseUrl, signal);
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  return blob;
}
