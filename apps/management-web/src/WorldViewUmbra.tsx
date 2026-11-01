import { useEffect, useRef, useState } from "react";
import { listUmbra, loadUmbraMetadata, type UmbraListing, type UmbraMetadata } from "./worldview-umbra";
import { previewUmbraRaster } from "./worldview-umbra-raster";
import { sarFreshness, SAR_CATALOG_MAX_AGE_MS, SAR_ACQUISITION_MAX_AGE_MS } from "./worldview-sar-status";
import type { GlobeImageryLayer } from "./worldview-globe-imagery";
import "./worldview-sar.css";

type Raster = Awaited<ReturnType<typeof previewUmbraRaster>>;
const missing = "Not supplied by this metadata source";
const show = (v: unknown) => v == null || v === "" ? missing : String(v);
const stem = (key: string) => key.replace(/(?:_METADATA\.json|_GEC\.tif|_MM\.(?:json|tif))$/i, "");
type Props = { onLayer?: (key: string, layer: GlobeImageryLayer | null) => void };

export default function WorldViewUmbra({ onLayer }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [prefix, setPrefix] = useState("sar-data/tasks/");
  const [snapshot, setSnapshot] = useState<UmbraListing | null>(null);
  const [folder, setFolder] = useState("");
  const [metadataKey, setMetadataKey] = useState("");
  const [metadata, setMetadata] = useState<UmbraMetadata | null>(null);
  const [metadataSourceKey, setMetadataSourceKey] = useState("");
  const [raster, setRaster] = useState<Raster | null>(null);
  const [rasterAt, setRasterAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("Disabled. No Umbra requests have been made.");
  const [clock, setClock] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const globeImageUrl = useRef("");
  const cancel = () => { generation.current++; request.current?.abort(); request.current = null; setBusy(false); };
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => { clearInterval(timer); generation.current++; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!raster || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) { setRaster(null); setMessage("Preview failed: this browser cannot draw a canvas. No fallback."); return; }
    const pixels = context.createImageData(raster.width, raster.height);
    pixels.data.set(raster.rgba);
    context.putImageData(pixels, 0, 0);
  }, [raster]);
  const perform = async (action: (signal: AbortSignal, current: () => boolean) => Promise<void>, loading: string) => {
    if (!enabled) return;
    cancel(); const controller = new AbortController(); request.current = controller;
    const version = generation.current;
    setBusy(true); setMessage(loading);
    try { await action(controller.signal, () => version === generation.current && !controller.signal.aborted); }
    catch (error) {
      if (version === generation.current && !controller.signal.aborted) { setFailed(true); setMessage(`Umbra request failed: ${error instanceof Error ? error.message : "provider unavailable"}. Previous data, if any, is retained and NOT refreshed. No fallback.`); }
    } finally { if (version === generation.current) { setBusy(false); request.current = null; } }
  };
  const browse = (nextPrefix: string, token?: string) => void perform(async (signal, current) => {
    const result = await listUmbra(nextPrefix, token, signal);
    if (!current()) return;
    setSnapshot(result); setPrefix(result.prefix); setFolder(result.folders[0] ?? "");
    setMetadataKey(result.objects.find(o => o.kind === "metadata")?.key ?? "");
    setMetadata(null); setMetadataSourceKey(""); setRaster(null); setFailed(false); setClock(Date.now());
    setMessage(`Received ${result.folders.length} folders and ${result.objects.length} actual listed objects. This is one directory page, not an acquisition-date search or complete archive inventory. Select a folder and open it, or explicitly load a metadata object.`);
  }, "Reading one Umbra public directory page…");
  const loadMetadata = () => {
    const object = snapshot?.objects.find(o => o.key === metadataKey && o.kind === "metadata");
    if (!object) return;
    void perform(async (signal, current) => {
      const result = await loadUmbraMetadata(object, signal);
      if (!current()) return;
      setMetadata(result); setMetadataSourceKey(object.key); setRaster(null); setFailed(false); setClock(Date.now());
      setMessage("Genuine Umbra metadata loaded. No image pixels have been requested. Select the explicit range-preview action to read image data.");
    }, "Loading the selected public Umbra metadata object…");
  };
  const imageObject = metadata && snapshot?.objects.find(o => o.kind === "raster" && stem(o.key) === stem(metadataSourceKey));
  useEffect(() => {
    if (!raster || !metadata || !imageObject || !rasterAt) { onLayer?.("manual-umbra", null); return; }
    const thumb = document.createElement("canvas");
    thumb.width = raster.width; thumb.height = raster.height;
    const context = thumb.getContext("2d");
    if (!context) { onLayer?.("manual-umbra", null); return; }
    const pixels = context.createImageData(raster.width, raster.height);
    pixels.data.set(raster.rgba);
    context.putImageData(pixels, 0, 0);
    let cancelled = false;
    thumb.toBlob((blob) => {
      if (cancelled || !blob) return;
      if (globeImageUrl.current) URL.revokeObjectURL(globeImageUrl.current);
      const url = URL.createObjectURL(blob);
      globeImageUrl.current = url;
      onLayer?.("manual-umbra", {
        key: "manual-umbra",
        provider: "Umbra Open Data",
        productId: metadata.id,
        imageUrl: url,
        acquisitionStart: metadata.acquisitionStart,
        retrievedAt: rasterAt,
        footprint: metadata.footprint,
        attribution: metadata.attribution,
        license: metadata.providerLicense,
        freshness: sarFreshness(metadata.acquisitionStart, SAR_ACQUISITION_MAX_AGE_MS, clock),
        refreshState: "manual",
        coverageNote: "Footprint from the selected actual metadata object; public bucket coverage is not globally indexed by viewport.",
        registrationNote: "Locally decoded overview thumbnail pinned near its metadata footprint; it is not registered or draped on the globe.",
      });
    }, "image/png");
    return () => {
      cancelled = true;
      if (globeImageUrl.current) URL.revokeObjectURL(globeImageUrl.current);
      globeImageUrl.current = "";
      onLayer?.("manual-umbra", null);
    };
  }, [raster, metadata, imageObject, rasterAt, clock, onLayer]);
  const preview = () => {
    if (!imageObject || !metadata) return;
    setRaster(null);
    void perform(async (signal, current) => {
      const result = await previewUmbraRaster(imageObject.url, imageObject.size, signal);
      if (!current()) return;
      setRaster(result); setRasterAt(new Date().toISOString()); setFailed(false);
      setMessage("Actual Umbra GeoTIFF pixels decoded locally into a contrast-stretched overview. This is not a calibrated measurement, generated image, or verified ground truth.");
    }, "Reading bounded HTTPS byte ranges from the selected Umbra GeoTIFF… No full-file fallback.");
  };
  const clearAll = () => { cancel(); setSnapshot(null); setMetadata(null); setMetadataSourceKey(""); setMetadataKey(""); setFolder(""); setRaster(null); setFailed(false); };
  const catalogAge = sarFreshness(snapshot?.fetchedAt, SAR_CATALOG_MAX_AGE_MS, clock);
  const acquisitionAge = sarFreshness(metadata?.acquisitionStart, SAR_ACQUISITION_MAX_AGE_MS, clock);
  const ring = metadata?.footprint ?? [];
  const dateLine = ring.some((p, i) => i > 0 && Math.abs(p[0] - ring[i - 1][0]) > 180);
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const west = xs.length ? Math.min(...xs) : -180, east = xs.length ? Math.max(...xs) : 180;
  const south = ys.length ? Math.min(...ys) : -90, north = ys.length ? Math.max(...ys) : 90;
  const points = ring.map(p => `${20 + (p[0] - west) / Math.max(east - west, .00001) * 760},${380 - (p[1] - south) / Math.max(north - south, .00001) * 360}`).join(" ");
  const parent = snapshot?.prefix.replace(/[^/]+\/$/, "");
  return <section className="wv-sar" aria-label="Umbra public SAR imagery">
    <h2>Umbra public SAR data <small>PUBLIC ARCHIVE / NOT LIVE VIDEO / MANUAL DIRECTORY SEARCH</small></h2>
    <p>Data and metadata from the public Umbra Open Data bucket. No account or key is needed. Only the verified HTTPS S3 REST origin is used; the supplied HTTP bucket website is not loaded. This source is independent of Sentinel-1 and never silently falls back to it.</p>
    <label className="sar-opt-in"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); if (!e.target.checked) clearAll(); setMessage(e.target.checked ? "Umbra enabled for this panel session. Nothing fetched; press Search / refresh Umbra directory explicitly." : "Disabled; Umbra requests cancelled and data/pixels cleared."); }} /> Enable Umbra public reads for this session</label>
    <p>Enabling, choosing a source/folder/object, editing a prefix, and opening this panel send nothing. Explicit actions send only the public directory prefix/page token or selected object key and byte ranges to <code>umbra-open-data-catalog.s3.us-west-2.amazonaws.com</code>. No observations, telemetry, uploaded files, cookies, credentials, or referrer are sent. Normal IP/connection metadata remains visible to the host.</p>
    <p className="sar-warning">The checked static STAC index is historical and its checked item asset links are empty. This workflow uses real S3-listed keys instead—never guessed URLs. Directory order is lexicographic, NOT newest-first. There is no verified global date/bbox search API here and no claim of current or complete coverage.</p>
    <div className="sar-controls"><label>Public directory prefix<input className="umbra-prefix" aria-label="Umbra public directory prefix" value={prefix} onChange={e => setPrefix(e.target.value)} /></label><button disabled={!enabled || busy} onClick={() => browse(prefix)}>Search / refresh Umbra directory</button><button disabled={!busy} onClick={() => { cancel(); setFailed(true); setMessage("Umbra request cancelled. Prior data, if any, is retained and NOT refreshed."); }}>Cancel Umbra request</button></div>
    <p>Use <code>sar-data/tasks/</code> to discover locations, or <code>sar-data/tasks/Bingham Copper Mine/</code> for the documented example. Enter only public catalog prefixes; it is the text explicitly sent to the provider.</p>
    <p role="status" className={failed || message.startsWith("Preview failed:") ? "sar-error" : ""}>{message}</p>
    {snapshot && <>
      <p className={failed || catalogAge !== "recent" ? "sar-warning" : ""}><b>DIRECTORY: {failed ? "RETAINED / REQUEST FAILED OR CANCELLED" : catalogAge !== "recent" ? "STALE / AGE UNKNOWN" : "RETRIEVED (not continuous)"}</b> · {snapshot.fetchedAt}. Freshness policy: 15 minutes, manual refresh only. Showing <a href={snapshot.queryUrl} target="_blank" rel="noreferrer">last submitted directory page</a> for <code>{snapshot.prefix}</code>, not unsent edits. Skipped invalid entries: {snapshot.skipped}.</p>
      {snapshot.truncated && <p className="sar-warning">This page is truncated. More data exists; no automatic pagination or crawling. <button disabled={!enabled || busy || !snapshot.nextToken} onClick={() => browse(snapshot.prefix, snapshot.nextToken)}>Load next Umbra directory page</button></p>}
      <div className="sar-controls"><label>Folder<select aria-label="Umbra folder" value={folder} onChange={e => setFolder(e.target.value)}><option value="">Select a listed folder</option>{snapshot.folders.map(f => <option key={f} value={f}>{f}</option>)}</select></label><button disabled={!enabled || busy || !folder} onClick={() => browse(folder)}>Open selected Umbra folder</button><button disabled={!enabled || busy || !parent || !/^(?:sar-data\/tasks\/|open-data\/)/.test(parent)} onClick={() => parent && browse(parent)}>Open parent Umbra folder</button></div>
      {!!snapshot.objects.length && <div className="sar-results"><h3>Actual source objects — not automatically downloaded</h3><ul>{snapshot.objects.map(o => <li key={o.key}><a href={o.url} target="_blank" rel="noreferrer">{o.key.split("/").at(-1)}</a> · {o.size.toLocaleString()} bytes · Object last modified {show(o.lastModified)} · {o.kind}. Links open original data (possibly very large); object modification is not acquisition or verified publication time.</li>)}</ul></div>}
      <div className="sar-controls"><label>Metadata object<select aria-label="Umbra metadata object" value={metadataKey} onChange={e => { cancel(); setMetadataKey(e.target.value); setMetadata(null); setMetadataSourceKey(""); setRaster(null); setMessage("Selection changed; no read initiated."); }}><option value="">Select actual listed metadata</option>{snapshot.objects.filter(o => o.kind === "metadata").map(o => <option key={o.key} value={o.key}>{o.key.split("/").at(-1)}</option>)}</select></label><button disabled={!enabled || busy || !metadataKey} onClick={loadMetadata}>Load selected Umbra metadata</button></div>
    </>}
    {metadata && <>
      <p className={acquisitionAge !== "recent" ? "sar-warning" : ""}><b>{acquisitionAge === "unknown" ? "ACQUISITION AGE UNKNOWN / FUTURE TIMESTAMP" : acquisitionAge === "stale" ? "OLDER ACQUISITION (>72 hours)" : "RECENT ACQUISITION (≤72 hours; not real-time)"}</b>. Acquisition age is independent of directory/metadata retrieval and object modification time.</p>
      <dl><dt>Provider / source product ID / task</dt><dd>Umbra Lab Inc / {metadata.id} / {show(metadata.taskId)}</dd>
        <dt>Metadata source / retrieved (UTC)</dt><dd><a href={metadata.sourceUrl} target="_blank" rel="noreferrer">Actual metadata object</a> / {metadata.fetchedAt}</dd>
        <dt>Acquisition start / end (UTC)</dt><dd>{metadata.acquisitionStart} / {show(metadata.acquisitionEnd)}</dd>
        <dt>Processing / publication time (UTC)</dt><dd>{show(metadata.processingTime)} / {show(metadata.publicationTime)}. Object last modified {show(metadata.objectLastModified)} is not a verified publication time.</dd>
        <dt>Metadata created / updated</dt><dd>{show(metadata.metadataCreated)} / {show(metadata.metadataUpdated)}. These are not substituted for acquisition/publication.</dd>
        <dt>Platform / sensor / mode / polarization</dt><dd>{metadata.platform} / {metadata.sensor} / {metadata.mode} / {metadata.polarization.join(" + ")}</dd>
        <dt>Absolute / relative orbit · direction</dt><dd>{show(metadata.absoluteOrbit)} / {show(metadata.relativeOrbit)} · {show(metadata.direction)}</dd>
        <dt>Look direction / incidence angle</dt><dd>{show(metadata.lookDirection)} / {show(metadata.incidenceAngle)} degrees (if supplied).</dd>
        <dt>Product / ground resolution range × azimuth / pixel spacing</dt><dd>{metadata.productType} / {show(metadata.rangeResolution)} m × {show(metadata.azimuthResolution)} m / {show(metadata.pixelSpacing)}. Source resolution is not overview pixel spacing.</dd>
        <dt>Footprint (WGS84 lon, lat)</dt><dd>{JSON.stringify(metadata.footprint)}</dd>
        <dt>License / attribution</dt><dd>{metadata.providerLicense} · {metadata.attribution}</dd>
      </dl>
      <div className="sar-controls"><button disabled={!enabled || busy || !imageObject} onClick={preview}>Preview selected Umbra GeoTIFF overview</button><button disabled={!raster} onClick={() => setRaster(null)}>Clear Umbra pixels</button></div>
      <p>Preview uses only the matching source GeoTIFF actually listed beside this metadata. It requests bounded HTTPS byte ranges and decodes a safe reduced-resolution overview locally. It will fail visibly if no safe overview exists; it will not fetch the entire full-resolution file, generate a substitute, or fall back to Sentinel-1.</p>
      {raster && <figure><canvas ref={canvas} width={raster.width} height={raster.height} role="img" aria-label={`Actual Umbra GeoTIFF overview for ${metadata.id}; display stretch, not ground truth`} /><figcaption>Real source pixels, locally contrast-stretched for display ({raster.stretch}). Overview {raster.overviewIndex}: {raster.width} × {raster.height}; original {raster.sourceWidth} × {raster.sourceHeight}. Read {raster.bytesRead.toLocaleString()} bytes in {raster.requestCount} range requests at {rasterAt}. Acquired {metadata.acquisitionStart}. {metadata.attribution}. Display processing changes appearance; not calibrated scientific measurements or a registered map raster. <a href={imageObject?.url} target="_blank" rel="noreferrer">Original GeoTIFF</a>.</figcaption></figure>}
      <figure><svg viewBox="0 0 800 400" role="img" aria-label="Umbra acquisition footprint map"><rect width="800" height="400" fill="#081820" />{!dateLine && <polygon points={points} fill="#e4b663" fillOpacity=".2" stroke="#ffcd75" strokeWidth="2"><title>{metadata.id} · {metadata.acquisitionStart}</title></polygon>}</svg><figcaption>Footprint-only map layer, equirectangular WGS84 data-fit extent [{[west, south, east, north].map(v => v.toFixed(5)).join(", ")}], north up; no basemap requests. {dateLine ? "Antimeridian footprint omitted from map; metadata retained." : "The GeoTIFF overview is not stretched onto this footprint."} Not a navigation map.</figcaption></figure>
    </>}
    <p><b>Terms and interpretation:</b> AWS's dataset registry specifies CC BY 4.0; inspected STAC items also declare CC-BY-4.0. The vendor metadata itself need not carry a per-object license. Attribute Umbra Lab Inc, link the source/license, and identify display modifications. The registry's Umbra open-license link currently renders generic website terms rather than the data-license text; that mismatch is disclosed, not presented as verified matching license text. <a href="https://registry.opendata.aws/umbra-open-data/" target="_blank" rel="noreferrer">Dataset license/access statement</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0 terms</a> · <a href="/worldview-sar-notices.txt" target="_blank" rel="noreferrer">Source notices</a>.</p>
    <p>SAR is radar backscatter, not optical photography. Speckle, look/incidence angle, layover/shadow, terrain, polarization, processing, and dataset latency limit interpretation. These public archive products are not verified ground truth or proof of present conditions. No autonomous decisions, hardware commands, cloud processing, observation uploads, continuous refresh, or background crawl are connected.</p>
  </section>;
}
