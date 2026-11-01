export const SAR_CATALOG_MAX_AGE_MS = 15 * 60_000;
export const SAR_ACQUISITION_MAX_AGE_MS = 72 * 3_600_000;
export function sarFreshness(timestamp: string | undefined, maxAgeMs: number, now = Date.now()): "recent" | "stale" | "unknown" {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(now) || time > now || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return "unknown";
  return now - time > maxAgeMs ? "stale" : "recent";
}
