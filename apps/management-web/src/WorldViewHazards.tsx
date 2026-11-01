import { useEffect, useRef, useState } from "react";
import {
  FIRMS_SOURCES, HAZARD_FEED_INFO, NOWCOAST_PRODUCTS, boundedBboxFrom, buildNowCoastSurface, fetchHazardRelayStatus, loadNowCoastOverlay,
  outlineLayer, refreshEonet, refreshFirms, refreshNhc, refreshWfigs, validateHazardBbox,
  type FirmsSource, type HazardBbox, type HazardOutline, type HazardRelayStatus, type HazardResult, type NowCoastProduct,
} from "./worldview-hazards";
import type { GlobeBounds } from "./worldview-globe-viewport";
import type { GlobeImageryLayer, GlobeImageryStatus } from "./worldview-globe-imagery";
import "./worldview-hazards.css";

type Feed = "firms" | "wfigs" | "eonet" | "nhc";
const SOURCE_LABEL: Record<Feed, string> = { firms: "NASA FIRMS", wfigs: "NIFC WFIGS", eonet: "NASA EONET", nhc: "NOAA NHC/CPHC" };
type Props = Readonly<{
  active: boolean;
  network: boolean;
  bounds?: readonly GlobeBounds[];
  onResult?: (source: string, result: HazardResult) => void;
  onLayer?: (key: string, layer: GlobeImageryLayer | null) => void;
  onStatus?: (status: GlobeImageryStatus | null) => void;
}>;
const noop = () => {};
async function decodeNowCoastSurface(blob: Blob, bbox: HazardBbox) {
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (header.length < 24 || header[0] !== 137 || header[1] !== 80 || header[2] !== 78 || header[3] !== 71) throw new Error("nowCOAST image is not a valid PNG header");
  const width = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(16, false);
  const height = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(20, false);
  if (!width || !height || width > 1024 || height > 1024 || width * height > 1_048_576) throw new Error("nowCOAST PNG dimensions exceed the requested 1024×1024 bound");
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    if (bitmap.width !== width || bitmap.height !== height) throw new Error("nowCOAST PNG dimensions changed during decode");
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error("2D canvas unavailable for nowCOAST image registration");
    context.drawImage(bitmap, 0, 0);
    return buildNowCoastSurface(width, height, context.getImageData(0, 0, width, height).data, bbox);
  } finally { bitmap.close?.(); }
}

export default function WorldViewHazards({ active, network, bounds = [], onResult = noop, onLayer = noop, onStatus = noop }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [box, setBox] = useState({ west: "-124", south: "36", east: "-114", north: "46" });
  const [firmsSource, setFirmsSource] = useState<FirmsSource>("VIIRS_NOAA20_NRT");
  const [firmsDays, setFirmsDays] = useState(1);
  const [eonetDays, setEonetDays] = useState(7);
  const [eonetCategory, setEonetCategory] = useState("all");
  const [product, setProduct] = useState<NowCoastProduct>("radar");
  const [results, setResults] = useState<Partial<Record<Feed, HazardResult>>>({});
  const [relay, setRelay] = useState<HazardRelayStatus | null>(null);
  const [overlay, setOverlay] = useState<{ layer: GlobeImageryLayer; url: string } | null>(null);
  const [outlines, setOutlines] = useState<HazardOutline[]>([]);
  const [showOutlines, setShowOutlines] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Disabled. No hazard provider requests have been made.");
  const blobUrl = useRef("");
  const abort = useRef<AbortController | null>(null);
  const allowed = enabled && network && active;

  useEffect(() => () => { abort.current?.abort(); if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); onStatus(null); }, [onStatus]);
  useEffect(() => {
    if (!overlay) { onLayer("hazard-nowcoast", null); onStatus(null); return; }
    onLayer("hazard-nowcoast", { ...overlay.layer, imageUrl: overlay.url });
    return () => { onLayer("hazard-nowcoast", null); onStatus(null); };
  }, [overlay, onLayer, onStatus]);
  useEffect(() => {
    const shown = showOutlines ? [...outlines].slice(0, 2) : [];
    const keys = ["hazard-outline-0", "hazard-outline-1"];
    keys.forEach((k, i) => onLayer(k, shown[i] ? outlineLayer(shown[i]) : null));
    return () => keys.forEach((k) => onLayer(k, null));
  }, [outlines, showOutlines, onLayer]);

  const bbox = (): HazardBbox => validateHazardBbox({ west: Number(box.west), south: Number(box.south), east: Number(box.east), north: Number(box.north) });
  const useViewport = () => {
    const v = bounds[0];
    if (!v) { setMessage("No visible globe bounds yet; enter a bounding box."); return; }
    try {
      const b = boundedBboxFrom(v);
      setBox({ west: String(b.west), south: String(b.south), east: String(b.east), north: String(b.north) });
      setMessage("Bounding box set from the visible globe (capped to 20° per side around its centre).");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Invalid viewport"); }
  };
  const disable = () => {
    abort.current?.abort();
    setEnabled(false);
    setOverlay(null);
    setOutlines([]);
    onStatus(null);
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = "";
    setMessage("Disabled. In-memory hazard overlays cleared; already-loaded markers stay labelled with their retrieval time.");
  };

  const run = async (feed: Feed) => {
    if (!allowed || busy) return;
    let b: HazardBbox | undefined;
    if (feed !== "nhc") { try { b = bbox(); } catch (e) { setMessage(e instanceof Error ? e.message : "Invalid bounding box"); return; } }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const options = { network: true, signal: controller.signal };
    setBusy(feed);
    try {
      const result = feed === "firms" ? await refreshFirms(b!, { source: firmsSource, days: firmsDays }, options)
        : feed === "wfigs" ? await refreshWfigs(b!, options)
          : feed === "eonet" ? await refreshEonet(b!, { days: eonetDays, category: eonetCategory }, options)
            : await refreshNhc(options);
      if (controller.signal.aborted) return;
      setResults((r) => ({ ...r, [feed]: result }));
      onResult(SOURCE_LABEL[feed], result);
      if (result.outlines) {
        const other = feed === "nhc" ? "NIFC WFIGS" : "NOAA NHC";
        setOutlines((prev) => [...result.outlines!, ...prev.filter((o) => o.provider === other)]);
      }
      setMessage(result.error ? `${SOURCE_LABEL[feed]}: ${result.error}` : `${SOURCE_LABEL[feed]}: ${result.observations.length} record(s); freshness ${result.freshness}; retrieved ${result.retrievedAt}${result.truncated ? " (provider limit reached; results truncated)" : ""}.`);
    } finally { if (abort.current === controller) { abort.current = null; setBusy(null); } }
  };
  const checkRelay = async () => {
    if (!allowed || busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy("relay");
    try { const s = await fetchHazardRelayStatus({ network: true, signal: controller.signal }); if (!controller.signal.aborted) { setRelay(s); setMessage(s.message); } }
    finally { if (abort.current === controller) { abort.current = null; setBusy(null); } }
  };
  const loadOverlay = async () => {
    if (!allowed || busy) return;
    let b: HazardBbox;
    const visible = bounds[0];
    if (!visible) { setMessage("No visible globe viewport; nowCOAST imagery is not requested."); return; }
    try { b = boundedBboxFrom(visible); } catch (e) { setMessage(e instanceof Error ? e.message : "Invalid viewport"); return; }
    setBox({ west: String(b.west), south: String(b.south), east: String(b.east), north: String(b.north) });
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy("nowcoast");
    try {
      const result = await loadNowCoastOverlay(product, b, { network: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      const surface = await decodeNowCoastSurface(result.blob, b);
      if (controller.signal.aborted) return;
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = URL.createObjectURL(result.blob);
      const layer = { ...result.layer, surface, registrationNote: "North-up WMS pixels are draped from the exact requested EPSG:4326 bbox and clipped to the selected imagery AOI (if any); this is not a flight-control geofence." };
      setOverlay({ layer, url: blobUrl.current });
      onStatus({ provider: "NOAA nowCOAST", title: `${NOWCOAST_PRODUCTS[product].title}`, detail: `Valid ${result.validTime} UTC · retrieved ${layer.retrievedAt} · ${layer.freshness.toUpperCase()} · ${layer.attribution} · terms: ${HAZARD_FEED_INFO.nowcoast.termsUrl}.`, tone: layer.freshness === "recent" ? "info" : "warning" });
      setMessage(`nowCOAST ${NOWCOAST_PRODUCTS[product].title}: exact provider time ${result.validTime} UTC; viewport bbox ${b.west},${b.south},${b.east},${b.north}; georeferenced raster draped.`);
    } catch (e) {
      if (!controller.signal.aborted) setMessage(`nowCOAST: ${e instanceof Error ? e.message : "request failed"}${overlay ? "; previous overlay retained with its own provider time and freshness" : "; no live layer shown"}`);
    } finally { if (abort.current === controller) { abort.current = null; setBusy(null); } }
  };

  const disabledReason = !active ? "Open the globe and keep it visible; public provider requests pause when it is hidden." : !network ? "Enable WorldView network opt-in first." : !enabled ? "Enable hazard feeds for this session." : "";
  return <section className="wv-hazards" aria-label="Fire and hazard feeds">
    <h2><small>PUBLIC FEEDS · READ-ONLY · FRESHNESS SHOWN</small>Fire and hazard feeds</h2>
    <p>Each button sends one bounded request when pressed. Nothing is fetched on load. Satellite fire points are <b>heat detections (thermal anomalies), not confirmed fires</b>. EONET is curated event metadata; its reported spatial/time extents may be approximate. No EONET or event-source imagery is fetched or embedded. Perimeters, cyclone cones and events are not official warnings and are not certified for operational decisions.</p>
    <label className="hz-opt-in"><input type="checkbox" checked={enabled} onChange={(e) => (e.target.checked ? (setEnabled(true), setMessage("Enabled for this session. Press a feed button to make a request.")) : disable())} /> Enable hazard feed requests for this session (sends only the bounding box below to the provider or the local relay)</label>
    {disabledReason && <p role="note" className="hz-note">{disabledReason}</p>}
    <fieldset className="hz-bbox"><legend>Bounding box (WGS84°, max 20° per side)</legend>
      {(["west", "south", "east", "north"] as const).map((k) => <label key={k}>{k}<input inputMode="decimal" value={box[k]} onChange={(e) => setBox({ ...box, [k]: e.target.value })} /></label>)}
      <button type="button" onClick={useViewport}>Use visible globe area</button>
    </fieldset>
    <div className="hz-grid">
      <div className="hz-card">
        <h3>NASA FIRMS thermal anomalies</h3>
        <label>Satellite source <select value={firmsSource} onChange={(e) => setFirmsSource(e.target.value as FirmsSource)}>{FIRMS_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Days <select value={firmsDays} onChange={(e) => setFirmsDays(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <button disabled={!allowed || !!busy} onClick={() => run("firms")}>Fetch FIRMS detections (via relay)</button>
        <button disabled={!allowed || !!busy} onClick={checkRelay}>Check relay / MAP_KEY status</button>
        <p className="fine">Goes through the local server, which holds the MAP_KEY (<code>UCAS_NASA_FIRMS_MAP_KEY</code>). The key never reaches the browser. Without a key, FIRMS shows <b>not_configured</b>. If the box sits inside one FIRMS region and you ask for 1–2 days, the keyless public regional files are used instead. Times are acquisition times in UTC.</p>
        {relay && <p className={`hz-status ${relay.state}`}>Relay: {relay.state}{relay.firmsKey ? ` · MAP_KEY ${relay.firmsKey}` : ""}</p>}
      </div>
      <div className="hz-card">
        <h3>NIFC WFIGS fire perimeters</h3>
        <button disabled={!allowed || !!busy} onClick={() => run("wfigs")}>Fetch current perimeters</button>
        <p className="fine">U.S. interagency perimeters for active incidents (up to 200, largest first, simplified). Not every incident has a perimeter. The data are not legal documents and come with no warranty.</p>
      </div>
      <div className="hz-card">
        <h3>NASA EONET curated event metadata</h3>
        <label>Look back <select aria-label="EONET event date range" value={eonetDays} onChange={(e) => setEonetDays(Number(e.target.value))}>{[1, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}</select></label>
        <label>Category <select aria-label="EONET event category" value={eonetCategory} onChange={(e) => setEonetCategory(e.target.value)}><option value="all">All categories</option><option value="wildfires">Wildfires</option><option value="severeStorms">Severe storms</option><option value="volcanoes">Volcanoes</option><option value="seaLakeIce">Sea and lake ice</option><option value="dustHaze">Dust and haze</option><option value="floods">Floods</option><option value="landslides">Landslides</option><option value="earthquakes">Earthquakes</option></select></label>
        <button disabled={!allowed || !!busy} onClick={() => run("eonet")}>Fetch EONET event metadata</button>
        <p className="fine">Manual, keyless metadata-only request to NASA EONET v3, bounded to the WGS84 box and date range above. Map markers use provider-dated point locations or an approximate polygon-ring centre. Each event retains its event page, geometry timestamp(s), source name, source homepage, and event-specific source link. Linked third-party imagery and EONET imagery/layers are never requested or displayed; source links open only after you choose them. Empty, malformed and old records are not labeled live. NASA says event extents may be approximations and are not official spatial/temporal determinations.</p>
        {results.eonet?.eonetEvents?.length ? <ol className="hz-eonet-events" aria-label="NASA EONET event metadata results">{results.eonet.eonetEvents.map((event) => <li key={event.id}>
          <strong><a href={event.eventUrl} target="_blank" rel="noreferrer noopener">{event.title}</a></strong> · {event.categories.join(", ") || "Uncategorized"}{event.closedAt ? <> · closed <time dateTime={event.closedAt}>{event.closedAt}</time></> : null}
          <ul><li>Provider geometry time(s): {event.geometryTimes.map((stamp, i) => <time key={`${stamp}-${i}`} dateTime={stamp}>{i ? ", " : ""}{stamp}</time>)}</li>
            {event.sources.map((source, i) => <li key={`${source.id}-${i}`}><strong>{source.name}</strong> ({source.id}){source.homepageUrl ? <> · <a href={source.homepageUrl} target="_blank" rel="noreferrer noopener">source homepage</a></> : null}{source.eventUrl ? <> · <a href={source.eventUrl} target="_blank" rel="noreferrer noopener">event-specific source</a></> : null}{source.catalogUrl ? <> · <a href={source.catalogUrl} target="_blank" rel="noreferrer noopener">EONET source catalog</a></> : null}</li>)}
          </ul>{event.sourcesTruncated ? <small>Additional source references were returned but omitted at the display bound.</small> : null}
        </li>)}</ol> : null}
      </div>
      <div className="hz-card">
        <h3>NOAA NHC/CPHC tropical cyclones</h3>
        <button disabled={!allowed || !!busy} onClick={() => run("nhc")}>Fetch active storms (via relay)</button>
        <p className="fine">Advisory positions, forecast points and the forecast cone (Atlantic, eastern and central Pacific). The cone shows where the storm's centre will probably go. It is not the area of impacts.</p>
      </div>
      <div className="hz-card">
        <h3>NOAA nowCOAST overlay</h3>
        <label>Product <select value={product} onChange={(e) => setProduct(e.target.value as NowCoastProduct)}>{(Object.keys(NOWCOAST_PRODUCTS) as NowCoastProduct[]).map((p) => <option key={p} value={p}>{NOWCOAST_PRODUCTS[p].title}</option>)}</select></label>
        <button disabled={!allowed || !!busy} onClick={loadOverlay}>Load overlay at latest exact time</button>
        <button disabled={!overlay} onClick={() => { if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); blobUrl.current = ""; setOverlay(null); onStatus(null); }}>Clear overlay</button>
        <p className="fine">Fetches WMS capabilities and the exact advertised product time for the currently visible globe bounds only. The raster is placed from its EPSG:4326 bbox and clipped by the selected imagery AOI. No request is made while the globe is hidden.</p>
        {overlay && <p className="hz-status">{overlay.layer.productId} · {overlay.layer.freshness} · acquired/provider time {overlay.layer.acquisitionStart} · retrieved {overlay.layer.retrievedAt} · {overlay.layer.attribution} · <a href={HAZARD_FEED_INFO.nowcoast.termsUrl} target="_blank" rel="noreferrer">terms</a></p>}
      </div>
    </div>
    <label className="hz-opt-in"><input type="checkbox" checked={showOutlines} onChange={(e) => setShowOutlines(e.target.checked)} /> Outline the two most recent cone/perimeter polygons on the globe (the globe draws at most four imagery outlines in total)</label>
    <p role="status" className="hz-message">{busy ? `Requesting ${busy}…` : message}</p>
    <ul className="hz-results">
      {(Object.keys(results) as Feed[]).map((f) => {
        const r = results[f]!;
        const info = HAZARD_FEED_INFO[f];
        return <li key={f} className={`hz-${r.freshness}`}>
          <b>{info.name}</b> · {r.freshness}{r.keyStatus === "not_configured" ? " · MAP_KEY not_configured" : ""}{r.mode ? ` · ${r.mode}` : ""} · {r.observations.length} record(s) · retrieved {r.retrievedAt}
          {r.error ? <> · <span className="hz-error">{r.error}</span></> : null}
          <br /><small>{info.attribution} · <a href={info.termsUrl} target="_blank" rel="noreferrer">terms</a>{r.sourceUrl ? <> · <a href={r.sourceUrl.startsWith("/") || r.sourceUrl.includes("[MAP_KEY]") ? info.endpoint : r.sourceUrl} target="_blank" rel="noreferrer">source</a></> : null}</small>
        </li>;
      })}
    </ul>
  </section>;
}
