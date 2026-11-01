import type { GeoreferencedRasterSurface } from "./worldview-draped-raster";

export type GlobeImageryLayer = Readonly<{
  key: string;
  provider: string;
  productId: string;
  imageUrl?: string;
  surface?: GeoreferencedRasterSurface;
  sourceUrl?: string;
  termsUrl?: string;
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
