export type GlobeImageryLayer = Readonly<{
  key: string;
  provider: "ASF Sentinel-1" | "Umbra Open Data";
  productId: string;
  imageUrl?: string;
  acquisitionStart?: string;
  retrievedAt: string;
  footprint: ReadonlyArray<readonly [number, number]>;
  attribution: string;
  license?: string;
  freshness: "recent" | "stale" | "unknown";
  refreshState: "current" | "manual" | "retained-failed";
  coverageNote: string;
  registrationNote: string;
}>;

export type GlobeImageryStatus = Readonly<{
  provider: string;
  title: string;
  detail: string;
  tone: "info" | "warning" | "error";
}>;
