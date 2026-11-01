export type GlobeCenter = { lat: number; lon: number };
export function globeVector(
  lat: number,
  lon: number,
  radius = 1,
): [number, number, number] {
  const p = (lat * Math.PI) / 180,
    l = (lon * Math.PI) / 180;
  return [
    radius * Math.cos(p) * Math.sin(l),
    radius * Math.sin(p),
    radius * Math.cos(p) * Math.cos(l),
  ];
}
export function normalizedCenter(lat: number, lon: number): GlobeCenter {
  return {
    lat: Math.max(-89, Math.min(89, Number.isFinite(lat) ? lat : 0)),
    lon: Number.isFinite(lon) ? ((((lon + 180) % 360) + 360) % 360) - 180 : 0,
  };
}
export function orthographic(lat: number, lon: number, center: GlobeCenter) {
  const p = (lat * Math.PI) / 180,
    l = ((lon - center.lon) * Math.PI) / 180,
    c = (center.lat * Math.PI) / 180;
  return {
    x: Math.cos(p) * Math.sin(l),
    y: Math.cos(c) * Math.sin(p) - Math.sin(c) * Math.cos(p) * Math.cos(l),
    visible:
      Math.sin(c) * Math.sin(p) + Math.cos(c) * Math.cos(p) * Math.cos(l) > 0,
  };
}

export function inverseOrthographic(x: number, y: number, center: GlobeCenter): [number, number] | null {
  const radius2 = x * x + y * y;
  if (!Number.isFinite(radius2) || radius2 > 1) return null;
  const z = Math.sqrt(Math.max(0, 1 - radius2)), c = (center.lat * Math.PI) / 180;
  const sinLat = Math.max(-1, Math.min(1, y * Math.cos(c) + z * Math.sin(c)));
  const lonDelta = Math.atan2(x, z * Math.cos(c) - y * Math.sin(c));
  const lon = ((center.lon + (lonDelta * 180) / Math.PI + 540) % 360) - 180;
  return [lon, (Math.asin(sinLat) * 180) / Math.PI];
}
