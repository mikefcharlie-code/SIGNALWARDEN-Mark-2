export const UMBRA_ORIGIN = "https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com";
export const UMBRA_DEFAULT_PREFIX = "sar-data/tasks/";
const OPEN_PREFIX = "open-data/";
const MAX_PREFIX = 600;
const MAX_TOKEN = 2048;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const DEADLINE_MS = 20_000;

export type UmbraObject = {
  key: string;
  url: string;
  size: number;
  lastModified?: string;
  etag?: string;
  kind: "metadata" | "raster" | "other";
};

export type UmbraListing = {
  prefix: string;
  queryUrl: string;
  fetchedAt: string;
  folders: string[];
  objects: UmbraObject[];
  truncated: boolean;
  nextToken?: string;
  skipped: number;
};

export type UmbraMetadata = {
  id: string;
  taskId?: string;
  sourceUrl: string;
  acquisitionStart: string;
  acquisitionEnd?: string;
  processingTime?: string;
  publicationTime?: string;
  metadataCreated?: string;
  metadataUpdated?: string;
  platform: string;
  sensor: string;
  mode: string;
  polarization: string[];
  direction?: string;
  absoluteOrbit?: number;
  relativeOrbit?: number;
  productType: string;
  rangeResolution?: number;
  azimuthResolution?: number;
  pixelSpacing?: string;
  footprint: Array<readonly [number, number]>;
  incidenceAngle?: number;
  lookDirection?: string;
  providerLicense: string;
  attribution: string;
  fetchedAt: string;
  objectLastModified?: string;
};

type Fetcher = typeof fetch;

function fail(message: string): never { throw new Error(`Umbra: ${message}`); }
function validatePrefix(prefix: string): string {
  if (typeof prefix !== "string" || prefix.length > MAX_PREFIX || /[\x00-\x1f\x7f?\\]/.test(prefix) || prefix.includes("..")) fail("invalid prefix");
  if (!(prefix.startsWith(UMBRA_DEFAULT_PREFIX) || prefix.startsWith(OPEN_PREFIX))) fail("prefix outside approved subtrees");
  return prefix;
}
function validateToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (typeof token !== "string" || token.length > MAX_TOKEN || /[\x00-\x1f\x7f?\\]/.test(token)) fail("invalid continuation token");
  return token;
}
function encodeKey(key: string): string {
  return `${UMBRA_ORIGIN}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
function kindFor(key: string): UmbraObject["kind"] {
  if (/(?:_METADATA\.json|_MM\.json)$/i.test(key)) return "metadata";
  if (/(?:_GEC\.tif|_MM\.tif)$/i.test(key)) return "raster";
  return "other";
}
function abortable(signal: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Umbra request deadline exceeded")), DEADLINE_MS);
  const relay = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay, { once: true });
  }
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", relay); } };
}
async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > limit) { await response.body?.cancel(); fail(`response exceeds ${limit} bytes`); }
  if (signal.aborted) { await response.body?.cancel(); throw signal.reason ?? new Error("Umbra request aborted"); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0, rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason ?? new Error("Umbra request aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) fail(`response exceeds ${limit} bytes`);
      chunks.push(value);
    }
    const out = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  } finally { signal.removeEventListener("abort", onAbort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function text(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
function xmlDecode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity === "amp") return "&"; if (entity === "lt") return "<"; if (entity === "gt") return ">"; if (entity === "quot") return '"'; if (entity === "apos") return "'";
    const n = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}
function xmlRoot(xml: string): string {
  if (/<\!DOCTYPE|<\!ENTITY/i.test(xml)) fail("DOCTYPE/ENTITY is not allowed");
  const root = xml.match(/^\s*(?:<\?xml[^>]*>\s*)?<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>\s*$/);
  if (!root) fail("unexpected XML root");
  return root[0];
}
function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? xmlDecode(match[1].trim()) : undefined;
}
function tags(xml: string, name: string): string[] {
  const out: string[] = []; const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"); let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function blocks(xml: string, name: string): string[] { return tags(xml, name); }

export async function listUmbra(prefix = UMBRA_DEFAULT_PREFIX, continuationToken?: string, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<UmbraListing> {
  validatePrefix(prefix); validateToken(continuationToken);
  const query = new URL(UMBRA_ORIGIN + "/");
  query.searchParams.set("list-type", "2"); query.searchParams.set("prefix", prefix); query.searchParams.set("delimiter", "/"); query.searchParams.set("max-keys", "100");
  if (continuationToken !== undefined) query.searchParams.set("continuation-token", continuationToken);
  const timed = abortable(signal);
  let response: Response;
  try { response = await fetcher(query.href, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: timed.signal }); }
  catch (error) { timed.cleanup(); throw error; }
  try {
    if (!response.ok) fail(`S3 listing failed (${response.status})`);
    const xml = xmlRoot(text(await bytes(response, MAX_XML_BYTES, timed.signal)));
    const returnedPrefix = tag(xml, "Prefix"); if (returnedPrefix !== prefix) fail("response Prefix does not match request");
    const contents = blocks(xml, "Contents"); const common = blocks(xml, "CommonPrefixes");
    if (contents.length + common.length > 100) fail("listing contains more than 100 entries");
    const folders: string[] = []; const objects: UmbraObject[] = []; let skipped = 0;
    for (const block of common) {
      const value = tag(block, "Prefix"); const rest = value?.slice(prefix.length);
      if (!value || !value.startsWith(prefix) || !rest || !rest.endsWith("/") || /[\x00-\x1f\x7f?\\]/.test(value) || value.includes("..")) { skipped++; continue; }
      if (rest.slice(0, -1).includes("/")) { skipped++; continue; } folders.push(value);
    }
    for (const block of contents) {
      const key = tag(block, "Key"); const rest = key?.slice(prefix.length);
      if (!key || !key.startsWith(prefix) || !rest || rest.includes("/")) { skipped++; continue; }
      const sizeText = tag(block, "Size"); const size = Number(sizeText); if (!sizeText || !Number.isSafeInteger(size) || size < 0) { skipped++; continue; }
      const item: UmbraObject = { key, url: encodeKey(key), size, kind: kindFor(key) };
      const modified = tag(block, "LastModified"); if (modified) item.lastModified = modified;
      const etag = tag(block, "ETag"); if (etag) item.etag = etag;
      objects.push(item);
    }
    const truncated = tag(xml, "IsTruncated")?.toLowerCase() === "true"; const next = tag(xml, "NextContinuationToken");
    if (truncated && !next) fail("truncated listing has no continuation token");
    validateToken(next);
    return { prefix, queryUrl: query.href, fetchedAt: new Date().toISOString(), folders, objects, truncated, ...(next ? { nextToken: next } : {}), skipped };
  } finally { timed.cleanup(); }
}

function stringValue(value: unknown, label: string): string { if (typeof value !== "string" || !value || value.length > 256) fail(`metadata ${label} is missing or invalid`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value && value.length <= 256 ? value : undefined; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function timestamp(value: unknown): string | undefined { return typeof value === "string" && value.length <= 64 && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined; }

export async function loadUmbraMetadata(object: UmbraObject, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<UmbraMetadata> {
  if (!object || object.kind !== "metadata" || !/(?:_METADATA\.json|_MM\.json)$/i.test(object.key) || object.url !== encodeKey(object.key)) fail("object is not a validated Umbra metadata object");
  validatePrefix(object.key);
  const timed = abortable(signal); let response: Response;
  try { response = await fetcher(object.url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: timed.signal }); }
  catch (error) { timed.cleanup(); throw error; }
  try {
    if (!response.ok) fail(`metadata fetch failed (${response.status})`);
    const raw: any = JSON.parse(text(await bytes(response, MAX_METADATA_BYTES, timed.signal)));
    if (!Array.isArray(raw.collects) || raw.collects.length !== 1) fail("metadata must contain exactly one collect");
    const c = raw.collects[0]; const footprint = c.footprintPolygonLla?.coordinates?.[0];
    if (!Array.isArray(footprint) || footprint.length < 4 || footprint.length > 200) fail("metadata footprint is missing or exceeds limits");
    const points = footprint.map((p: unknown) => { if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) fail("metadata footprint is invalid"); return [p[0], p[1]] as const; });
    if (points[0][0] !== points.at(-1)![0] || points[0][1] !== points.at(-1)![1]) fail("metadata footprint is not closed");
    if (!timestamp(c.startAtUTC)) fail("metadata acquisition start is invalid");
    if (c.endAtUTC && (!timestamp(c.endAtUTC) || Date.parse(c.endAtUTC) < Date.parse(c.startAtUTC))) fail("metadata acquisition end is invalid");
    if (Array.isArray(c.polarizations) && (c.polarizations.length > 8 || c.polarizations.some((v: unknown) => typeof v !== "string" || v.length > 16))) fail("metadata polarization is invalid");
    const gec = Array.isArray(raw.derivedProducts?.GEC) && raw.derivedProducts.GEC.length ? raw.derivedProducts.GEC[0] : undefined;
    const fetchedAt = new Date().toISOString();
    return { id: stringValue(c.id, "collect id"), taskId: optionalString(c.taskId), sourceUrl: object.url, acquisitionStart: stringValue(c.startAtUTC, "acquisition start"), acquisitionEnd: optionalString(c.endAtUTC), platform: stringValue(raw.umbraSatelliteName, "platform"), sensor: `${stringValue(c.radarBand, "radar band")}-band SAR`, mode: stringValue(raw.imagingMode, "mode"), polarization: Array.isArray(c.polarizations) ? c.polarizations.filter((p: unknown): p is string => typeof p === "string") : [], direction: optionalString(c.satelliteTrack), productType: gec ? "GEC" : "unknown", rangeResolution: optionalNumber(gec?.groundResolution?.rangeMeters), azimuthResolution: optionalNumber(gec?.groundResolution?.azimuthMeters), footprint: points, incidenceAngle: optionalNumber(c.angleIncidenceDegrees), lookDirection: optionalString(c.observationDirection), providerLicense: "CC BY 4.0 (dataset-level AWS Registry; vendor metadata has no per-object license)", attribution: `Umbra Lab Inc — CC BY 4.0; accessed ${fetchedAt.slice(0, 10)}; unmodified source data; display stretch separate`, fetchedAt, ...(object.lastModified ? { objectLastModified: object.lastModified } : {}) };
  } finally { timed.cleanup(); }
}

export const UMBRA_SOURCE_DISCLOSURE = "The Umbra open-license page currently renders generic Website Terms rather than a full data-license text; dataset-level licensing is therefore attributed to the AWS Registry (CC BY 4.0), corroborated by the inspected STAC item.";
