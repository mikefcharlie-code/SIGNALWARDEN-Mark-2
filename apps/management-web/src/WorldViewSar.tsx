import { useEffect, useRef, useState } from "react";
import { searchSar, fetchSarBrowse, type SarScene } from "./worldview-sar";
import { sarFreshness, SAR_CATALOG_MAX_AGE_MS, SAR_ACQUISITION_MAX_AGE_MS } from "./worldview-sar-status";
import type { GlobeImageryLayer } from "./worldview-globe-imagery";
import "./worldview-sar.css";

const unavailable = "Not provided by catalog";
const isoDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const show = (value: unknown) => value == null || value === "" ? unavailable : String(value);
const boundsLabels = [["west", "West"], ["south", "South"], ["east", "East"], ["north", "North"]] as const;
type Snapshot = Awaited<ReturnType<typeof searchSar>>;
type Props = { onLayer?: (key: string, layer: GlobeImageryLayer | null) => void };

export default function WorldViewSar({ onLayer }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [bounds, setBounds] = useState({ west: "-78", south: "38", east: "-76", north: "40" });
  const [start, setStart] = useState(() => isoDay(30));
  const [end, setEnd] = useState(() => isoDay());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [image, setImage] = useState<{ url: string; id: string; loadedAt: string } | null>(null);
  const [busy, setBusy] = useState<"search" | "preview" | null>(null);
  const [message, setMessage] = useState("Disabled. No public imagery requests have been made.");
  const [failed, setFailed] = useState(false);
  const [footprints, setFootprints] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const blobUrl = useRef("");
  const clearImage = () => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = "";
    setImage(null);
  };
  const cancel = () => { generation.current++; request.current?.abort(); request.current = null; setBusy(null); };
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => { clearInterval(timer); generation.current++; request.current?.abort(); if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); };
  }, []);
  const selected = snapshot?.scenes.find(scene => scene.id === selectedId);
  useEffect(() => {
    if (!image || !selected) { onLayer?.("manual-asf", null); return; }
    const layer: GlobeImageryLayer = {
      key: "manual-asf",
      provider: "ASF Sentinel-1",
      productId: selected.id,
      imageUrl: image.url,
      acquisitionStart: selected.acquisitionStart,
      retrievedAt: image.loadedAt,
      footprint: selected.footprint,
      attribution: selected.attribution,
      license: selected.license,
      freshness: sarFreshness(selected.acquisitionStart, SAR_ACQUISITION_MAX_AGE_MS, clock),
      refreshState: "manual",
      coverageNote: "Provider-returned product footprint; this manual preview is not a viewport completeness claim.",
      registrationNote: "Genuine provider browse thumbnail pinned near its footprint; thumbnail is not georeferenced or draped on the globe.",
    };
    onLayer?.("manual-asf", layer);
    return () => onLayer?.("manual-asf", null);
  }, [image, selected, clock, onLayer]);
  const search = async () => {
    if (!enabled) return;
    cancel();
    const current = new AbortController(); request.current = current;
    const version = generation.current;
    setBusy("search"); setMessage("Searching ASF Sentinel-1 catalog… Previous results, if any, are not yet refreshed.");
    try {
      const query = { ...Object.fromEntries(boundsLabels.map(([key]) => [key, bounds[key].trim() === "" ? NaN : Number(bounds[key])])), start: `${start}T00:00:00Z`, end: `${end}T23:59:59Z` } as Parameters<typeof searchSar>[0];
      const result = await searchSar(query, current.signal);
      if (version !== generation.current || current.signal.aborted) return;
      clearImage(); setSnapshot(result); setSelectedId(result.scenes[0]?.id ?? ""); setFailed(false); setClock(Date.now());
      setMessage(result.scenes.length ? `Received ${result.scenes.length} matching acquisitions, sorted newest first within the returned set. Select a scene, then explicitly load its browse preview.` : "No matching acquisitions returned. No fallback imagery or synthetic substitute was used.");
    } catch (error) {
      if (version === generation.current && !current.signal.aborted) { setFailed(true); setMessage(`Search failed: ${error instanceof Error ? error.message : "provider unavailable"}. Previous results, if any, are retained and NOT refreshed. No fallback.`); }
    } finally { if (version === generation.current) { setBusy(null); request.current = null; } }
  };
  const preview = async () => {
    if (!enabled || !selected?.browseUrl) return;
    cancel(); clearImage();
    const current = new AbortController(); request.current = current;
    const version = generation.current, scene = selected;
    setBusy("preview"); setMessage("Loading the selected provider browse image…");
    try {
      const blob = await fetchSarBrowse(scene.browseUrl!, current.signal);
      if (version !== generation.current || current.signal.aborted) return;
      const url = URL.createObjectURL(blob); blobUrl.current = url;
      setImage({ url, id: scene.id, loadedAt: new Date().toISOString() });
      setMessage("Provider browse image downloaded. This is a reduced-resolution, non-georeferenced preview, not calibrated full-resolution SAR.");
    } catch (error) {
      if (version === generation.current && !current.signal.aborted) setMessage(`Preview failed: ${error instanceof Error ? error.message : "provider unavailable"}. No image or fallback is displayed.`);
    } finally { if (version === generation.current) { setBusy(null); request.current = null; } }
  };
  const scenes = snapshot?.scenes ?? [];
  const visible = footprints ? scenes.filter(s => !s.footprint.some((p, i) => i > 0 && Math.abs(p[0] - s.footprint[i - 1][0]) > 180)) : [];
  const points = visible.flatMap(s => s.footprint);
  const west = points.length ? Math.min(...points.map(p => p[0])) : -180;
  const east = points.length ? Math.max(...points.map(p => p[0])) : 180;
  const south = points.length ? Math.min(...points.map(p => p[1])) : -90;
  const north = points.length ? Math.max(...points.map(p => p[1])) : 90;
  const polygon = (scene: SarScene) => scene.footprint.map(p => `${20 + (p[0] - west) / Math.max(east - west, 0.001) * 760},${380 - (p[1] - south) / Math.max(north - south, 0.001) * 360}`).join(" ");
  const catalogState = sarFreshness(snapshot?.fetchedAt, SAR_CATALOG_MAX_AGE_MS, clock);
  const catalogOld = catalogState !== "recent";
  const acquisitionState = sarFreshness(selected?.acquisitionStart, SAR_ACQUISITION_MAX_AGE_MS, clock);
  const acquisitionOld = acquisitionState !== "recent";
  return <section className="wv-sar" aria-label="Public SAR satellite imagery">
    <h2>Public SAR satellite imagery <small>LATEST PUBLIC ACQUISITIONS / NOT LIVE VIDEO</small></h2>
    <p>Sentinel-1 C-band radar catalog and genuine provider browse previews from NASA ASF DAAC. No generated imagery, inference, ground-truth claim, or hardware control. This independent read-only panel never sends observations, telemetry, scene context, or uploaded files.</p>
    <label className="sar-opt-in"><input type="checkbox" checked={enabled} onChange={e => {
      const value = e.target.checked; setEnabled(value);
      if (!value) { cancel(); clearImage(); setSnapshot(null); setSelectedId(""); setFailed(false); }
      setMessage(value ? "Public imagery enabled for this panel session only. Nothing fetched yet. Press Search / refresh explicitly." : "Disabled; requests cancelled and imagery/metadata cleared from memory.");
    }} /> Enable public SAR reads for this session</label>
    <p>Enabling alone sends nothing. Search sends only the bounds and date range below to api.daac.asf.alaska.edu; Preview sends only the selected public product identifier to the same-origin local SAR relay, which reads ASF browse/delivery hosts. Providers see normal connection metadata (including IP). No provider cookies, credentials, referrer, polling, or silent alternate providers. Closing clears this session. Cancellation aborts the browser read and prevents late rendering; an already authorized local relay download may finish within its 20-second server deadline.</p>
    <div className="sar-controls">
      {boundsLabels.map(([key, label]) => <label key={key}>{label}<input aria-label={`SAR ${label.toLowerCase()} longitude or latitude`} type="number" step="any" value={bounds[key]} onChange={e => setBounds(old => ({ ...old, [key]: e.target.value }))} /></label>)}
      <label>Acquired from (UTC)<input aria-label="SAR acquisition start date" type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>Through (UTC)<input aria-label="SAR acquisition end date" type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
      <button disabled={!enabled || !!busy} onClick={() => void search()}>Search / refresh SAR</button>
      <button disabled={!busy} onClick={() => { cancel(); setFailed(true); setMessage("Request cancelled. Retained catalog, if any, is NOT refreshed."); }}>Cancel SAR request</button>
    </div>
    <p role="status" className={failed || message.startsWith("Preview failed:") ? "sar-error" : ""}>{message}</p>
    {snapshot && <p className={failed || catalogOld ? "sar-warning" : ""}><b>CATALOG: {failed ? "RETAINED / REFRESH FAILED OR CANCELLED" : catalogOld ? "STALE" : "RETRIEVED (not continuous)"}</b> · Retrieved {snapshot.fetchedAt}. Catalog freshness policy: 15 minutes; manual refresh only. Results correspond to the <a href={snapshot.queryUrl} target="_blank" rel="noreferrer">last submitted ASF query</a>, not unsent edits. Skipped invalid records: {snapshot.skipped}.</p>}
    {snapshot?.possiblyTruncated && <p className="sar-warning">Result limit reached (50). Archive completeness and the absolute newest acquisition are not guaranteed; narrow the dates/bounds and search again. No automatic pagination.</p>}
    {!!scenes.length && <div className="sar-results"><label>Acquisition<select aria-label="SAR acquisition" value={selectedId} onChange={e => { cancel(); clearImage(); setSelectedId(e.target.value); setMessage("Selection changed. Press Load selected SAR preview to fetch this image."); }}>{scenes.map(s => <option key={s.id} value={s.id}>{s.acquisitionStart} · {s.id}</option>)}</select></label></div>}
    {selected && <>
      <p className={acquisitionOld ? "sar-warning" : ""}><b>{acquisitionState === "unknown" ? "ACQUISITION AGE UNKNOWN / FUTURE TIMESTAMP" : acquisitionOld ? "OLDER ACQUISITION (>72 hours)" : "RECENT ACQUISITION (≤72 hours; not real-time)"}</b>. Dataset acquisition age and catalog retrieval age are separate. Coverage, processing, and publication delays vary; the newest match need not describe present conditions.</p>
      <dl>
        <dt>Source / product ID</dt><dd>NASA ASF DAAC / {selected.id}</dd>
        <dt>Acquisition start / end (UTC)</dt><dd>{selected.acquisitionStart} / {show(selected.acquisitionEnd)}</dd>
        <dt>Processing time (UTC; ASF processingDate)</dt><dd>{show(selected.processingTime)}</dd>
        <dt>Publication time (UTC)</dt><dd>{show(selected.publicationTime)}. Retrieval time is not acquisition or publication time.</dd>
        <dt>Platform / sensor / mode</dt><dd>{show(selected.platform)} / {show(selected.sensor)} / {show(selected.mode)}</dd>
        <dt>Polarization</dt><dd>{show(selected.polarization)}. Catalog product polarization does not guarantee a specific browse channel.</dd>
        <dt>Absolute / relative orbit · direction</dt><dd>{show(selected.absoluteOrbit)} / {show(selected.relativeOrbit)} · {show(selected.direction)}</dd>
        <dt>Product type / resolution / pixel spacing</dt><dd>{show(selected.productType)} / {show(selected.resolution)} / {show(selected.pixelSpacing)}. Product metadata is not browse pixel resolution.</dd>
        <dt>Footprint (WGS84 lon, lat)</dt><dd>{JSON.stringify(selected.footprint)}</dd>
        <dt>Attribution / license</dt><dd>{selected.attribution} · {selected.license}</dd>
        <dt>Provider browse asset</dt><dd>{selected.browseUrl || "No eligible public browse asset provided"}</dd>
      </dl>
      <div className="sar-controls"><button disabled={!enabled || !!busy || !selected.browseUrl} onClick={() => void preview()}>Load selected SAR preview</button><button disabled={!image} onClick={clearImage}>Clear SAR preview</button><label><input type="checkbox" checked={footprints} onChange={e => setFootprints(e.target.checked)} /> Show acquisition footprints layer</label></div>
    </>}
    {image && selected && image.id === selected.id && <figure><img src={image.url} alt={`ASF Sentinel-1 browse preview for ${selected.id}; not georeferenced or ground truth`} onError={() => { clearImage(); setMessage("Preview failed: provider bytes could not be decoded as an image. No fallback."); }} /><figcaption>Actual provider browse, reduced resolution; native image orientation (not necessarily north up). Acquired {selected.acquisitionStart}; downloaded {image.loadedAt}. {selected.attribution}. Provider display colors are not optical true-color; channel mapping is not supplied. Not a calibrated measurement or georeferenced map overlay.</figcaption></figure>}
    {!!scenes.length && <figure><svg viewBox="0 0 800 400" role="img" aria-label="SAR acquisition footprint map preview"><rect width="800" height="400" fill="#081820" />{visible.map(s => <polygon key={s.id} points={polygon(s)} fill={s.id === selectedId ? "#e4b663" : "#55bdb2"} fillOpacity={s.id === selectedId ? 0.25 : 0.05} stroke={s.id === selectedId ? "#ffcd75" : "#55bdb2"} strokeWidth={s.id === selectedId ? 2 : 1}><title>{s.id} · {s.acquisitionStart}</title></polygon>)}</svg><figcaption>Footprint-only map layer; selected scene in gold. Equirectangular, data-fit WGS84 extent [{[west, south, east, north].map(n => n.toFixed(4)).join(", ")}], north up. No basemap requests. Browse images are NOT stretched over footprints because they are not georeferenced. {footprints ? scenes.length - visible.length : 0} antimeridian-crossing footprints omitted from this map, retained in metadata. Not a navigation map.</figcaption></figure>}
    <p><b>Interpretation limits:</b> SAR measures radar backscatter, not an optical photograph. Speckle, look/incidence angle, layover, shadow, polarization, terrain, moisture, and processing affect appearance. Different passes are not directly comparable without suitable calibration and geometry. Browse products are unsuitable for quantitative analysis or verified identification. Acquisition schedules and archive latency are not guaranteed. No autonomous decisions or aircraft commands are connected to this panel.</p>
    <p><b>Preview connection requirement:</b> run the local Management API with <code>UCAS_PUBLIC_SAR_ENABLED=1</code> and route <code>/api/v1/public-imagery</code> to it on the same origin. The relay is disabled by default; this UI checkbox and an explicit Preview action are also required. No API key or account is needed for public previews. Provider delivery-host changes fail visibly rather than expanding the allowlist.</p>
    <p>Full-resolution scientific imagery is not downloaded here. ASF full products require an Earthdata Login account and separate authorized tooling; no login, tokens, or credentials are embedded or requested in this application. <a href="https://docs.asf.alaska.edu/asf_search/downloading/" target="_blank" rel="noreferrer">ASF download requirements</a> · <a href="/worldview-sar-notices.txt" target="_blank" rel="noreferrer">Source, licensing, and notices</a>.</p>
  </section>;
}
