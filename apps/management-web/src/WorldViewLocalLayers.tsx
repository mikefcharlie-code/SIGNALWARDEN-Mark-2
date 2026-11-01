import { getDecoder } from "geotiff";
import { useEffect, useMemo, useRef, useState } from "react";
import { createDemoObservations, importObservationPack, type GeoPoint, type WorldObservation } from "./worldview-core";
import { aggregateLocalObservations } from "./worldview-local-hex";
import { inspectLocalRaster, type LocalRaster } from "./worldview-local-raster";
import "./worldview-local-layers.css";

const date = (value?: number) => value ? new Date(value).toISOString() : "not supplied";
const fmt = (values: readonly number[]) => values.map(v => Number.isFinite(v) ? Number(v.toPrecision(8)) : String(v)).join(", ");
const seam = (points: readonly GeoPoint[]) => points.some((p, i) => i > 0 && Math.abs(p.lon - points[i - 1].lon) > 180);

// Fetch application code only when the panel opens, never on file selection.
export async function prepareLocalLayers(): Promise<void> {
  await getDecoder(1, { tileWidth: 1, tileHeight: 1, predictor: 1, bitsPerSample: [8], planarConfiguration: 1 });
}

export default function WorldViewLocalLayers() {
  const [points, setPoints] = useState<WorldObservation[]>([]);
  const [provenance, setProvenance] = useState<"synthetic" | "user-supplied">("synthetic");
  const [source, setSource] = useState("No local dataset loaded");
  const [loadedAt, setLoadedAt] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [resolution, setResolution] = useState(5);
  const [raster, setRaster] = useState<LocalRaster | null>(null);
  const [overlay, setOverlay] = useState(true);
  const [message, setMessage] = useState("Local only. Choose a file or explicitly load the synthetic sample.");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const packGeneration = useRef(0);
  useEffect(() => () => { controller.current?.abort(); packGeneration.current++; }, []);
  const aggregate = useMemo(() => enabled ? aggregateLocalObservations(points, resolution, provenance) : null, [enabled, points, resolution, provenance]);
  const visibleHex = aggregate?.cells.filter(c => !seam(c.boundary)) ?? [];
  const rasterCells = overlay ? raster?.preview.cells.filter(c => c.value !== null) ?? [] : [];
  const allCorners = [...visibleHex.flatMap(c => c.boundary), ...(overlay && raster ? raster.footprint : [])];
  const xs = allCorners.map(p => p.lon), ys = allCorners.map(p => p.lat);
  const west = xs.length ? Math.min(...xs) : -180, east = xs.length ? Math.max(...xs) : 180;
  const south = ys.length ? Math.min(...ys) : -90, north = ys.length ? Math.max(...ys) : 90;
  const dx = Math.max(east - west, 0.0001), dy = Math.max(north - south, 0.0001);
  const polygon = (corners: readonly GeoPoint[]) => corners.map(p => `${20 + (p.lon - west) / dx * 760},${380 - (p.lat - south) / dy * 360}`).join(" ");
  const color = (value: number) => {
    const min = raster?.preview.min ?? value, max = raster?.preview.max ?? value;
    const shade = max === min ? 160 : Math.round(35 + (value - min) / (max - min) * 200);
    return `rgb(${shade},${shade},${shade})`;
  };
  const loadPack = async (file?: File) => {
    const generation = ++packGeneration.current;
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("Observation pack exceeds 2 MB");
      const pack = importObservationPack(await file.text());
      if (generation !== packGeneration.current) return;
      setPoints(pack.observations); setProvenance("user-supplied"); setSource(file.name);
      setLoadedAt(new Date().toISOString()); setMessage(`Loaded ${pack.observations.length} user-supplied points locally; provenance is not independently verified.`);
    } catch (error) { if (generation === packGeneration.current) setMessage(String(error)); }
  };
  const loadRaster = async (file?: File) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setRaster(null);
    if (!file) { setBusy(false); return; }
    setBusy(true); setMessage("Inspecting local raster…");
    try {
      const result = await inspectLocalRaster(file, { signal: current.signal, name: file.name, lastModified: file.lastModified });
      if (!current.signal.aborted) { setRaster(result); setMessage("User-supplied raster loaded locally. Grayscale first-band sample; not authoritative terrain or current imagery."); }
    } catch (error) { if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "Raster rejected"); }
    finally { if (controller.current === current) setBusy(false); }
  };
  return <section className="wv-local-layers" aria-label="Local offline layers">
    <h2>Local offline layers <small>INFORMATIONAL / SIMULATION ONLY</small></h2>
    <p>No uploads, remote URLs, tile requests, or provider connections. Only the selected local pack or synthetic scene is shown; feeds and telemetry are not included. Files and results remain in browser memory and are not included in scene sharing or exports.</p>
    <div className="local-layer-controls">
      <label>Local observation pack <input type="file" accept=".json,application/json" aria-label="Local observation pack" onChange={e => { void loadPack(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} /></label>
      <button onClick={() => { packGeneration.current++; setPoints(createDemoObservations()); setProvenance("synthetic"); setSource("Bundled synthetic demo (not real observations)"); setLoadedAt(new Date().toISOString()); setMessage("Synthetic sample loaded; enable H3 counts explicitly."); }}>Load synthetic points</button>
      <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable local H3 counts</label>
      <label>H3 resolution <select aria-label="H3 resolution" value={resolution} onChange={e => setResolution(Number(e.target.value))}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></label>
      <label title="Uncompressed TIFF only; 16 MiB, 4096 per side, 4 million pixels, 4 bands">User-supplied GeoTIFF <input type="file" accept=".tif,.tiff,image/tiff" aria-label="User-supplied GeoTIFF" onChange={e => { void loadRaster(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} /></label>
      <button disabled={!busy} onClick={() => { controller.current?.abort(); setBusy(false); setMessage("Raster inspection cancelled; no result retained."); }}>Cancel raster inspection</button>
      <label><input type="checkbox" checked={overlay} onChange={e => setOverlay(e.target.checked)} /> Show user-supplied raster sample</label>
      <button onClick={() => { controller.current?.abort(); packGeneration.current++; setBusy(false); setRaster(null); setPoints([]); setEnabled(false); setSource("No local dataset loaded"); setLoadedAt(""); setMessage("Local layers cleared from this workspace."); }}>Clear local layers</button>
    </div>
    <p role="status">{message}</p>
    <p><b>Dataset: {provenance.toUpperCase()}</b> · {source} · Loaded {loadedAt || "not yet"}. {points.length} points. Source labels and observation times are supplied by the dataset, not verification.</p>
    {aggregate && <p><b>{aggregate.pointCount} points / {aggregate.cells.length} occupied H3 cells / resolution {aggregate.resolution}</b> · Occupied-cell area: {aggregate.coverageKm2.toFixed(3)} km². This is grid-cell area, not sensor coverage, uncertainty, or observed surface area.</p>}
    <figure>
      <svg viewBox="0 0 800 400" role="img" aria-label="Offline SVG local hex and user-supplied raster overlay">
        <rect width="800" height="400" fill="#081820" />
        {overlay && raster && <polygon points={polygon(raster.footprint)} fill="none" stroke="#9caeb6" strokeDasharray="5 5"><title>User-supplied raster footprint; missing samples remain transparent</title></polygon>}
        {rasterCells.map((cell, i) => <polygon key={`r-${i}`} points={polygon(cell.corners)} fill={color(cell.value!)} opacity="0.75"><title>User-supplied raster first band: {cell.value}</title></polygon>)}
        {visibleHex.map(cell => <polygon key={cell.id} points={polygon(cell.boundary)} fill="#38bdaa" fillOpacity={Math.min(0.8, 0.2 + cell.count / Math.max(1, aggregate!.pointCount))} stroke="#85f4dd" strokeWidth="1"><title>{cell.id}: {cell.count} points · {cell.sources.join(", ")}</title></polygon>)}
        {!allCorners.length && <text x="30" y="200" fill="#bdded7">Load local data and enable a layer to see a preview.</text>}
      </svg>
      <figcaption>SVG / no WebGL required · equirectangular data-fit preview (not a navigation map). WGS84 extent: {fmt([west, south, east, north])}. Raster: up to 32 × 32 sparse original first-band pixel samples, not a full-resolution image, terrain, or current imagery. {aggregate && aggregate.cells.length !== visibleHex.length ? "Antimeridian-crossing hexagons omitted from preview; all counts remain in the table." : ""}</figcaption>
    </figure>
    {raster && <div className="local-raster-metadata">
      <h3>User-supplied raster metadata</h3>
      <dl>
        <dt>Source file / bytes</dt><dd>{raster.name} / {raster.bytes}</dd>
        <dt>File modified / imported</dt><dd>{date(raster.lastModified)} / {raster.importedAt}</dd>
        <dt>CRS</dt><dd>{raster.crs}</dd>
        <dt>Native bounds / pixel resolution</dt><dd>{fmt(raster.nativeBounds)} / {fmt(raster.resolution)}</dd>
        <dt>Dimensions / data bands</dt><dd>{raster.width} × {raster.height} / {raster.bands} · Preview uses first band only</dd>
        <dt>Sample bit depths / compression</dt><dd>{raster.bitsPerSample.join(", ")} / {raster.compression}</dd>
        <dt>Nodata / sampled valid and missing cells</dt><dd>{String(raster.nodata)} / {raster.preview.validCount} valid / {raster.preview.nodataCount} missing · missing pixels transparent</dd>
        <dt>Acquisition time / authority</dt><dd>Unknown. File modification time is not acquisition time. No terrain, elevation datum, or imagery currency is verified.</dd>
      </dl>
    </div>}
    {aggregate && <div className="local-hex-table"><table><caption>Occupied cells, dataset-provided provenance and times (first 100 of {aggregate.cells.length})</caption><thead><tr><th>H3 cell</th><th>Count</th><th>Area km²</th><th>Sources</th><th>First / last observation</th></tr></thead><tbody>{aggregate.cells.slice(0, 100).map(c => <tr key={c.id}><td>{c.id}</td><td>{c.count}</td><td>{c.areaKm2.toFixed(3)}</td><td>{c.sources.join("; ")}</td><td>{c.firstObservedAt} / {c.lastObservedAt}</td></tr>)}</tbody></table></div>}
    <p>Limits: uncompressed TIFF only; ≤16 MiB, ≤4096 per side, ≤4 million pixels, ≤4 bands. Supported CRS: WGS84 geographic, Web Mercator, WGS84 UTM only. Unsupported datums/grids, ambiguous CRS, rotated and PixelIsPoint rasters are rejected.</p>
    <p><a href="/worldview-local-layers-notices.txt" target="_blank" rel="noreferrer">Open-source licenses and notices</a> · H3, GeoTIFF.js, Proj4js. No aircraft control, target selection, sensor tasking, or mission planning.</p>
  </section>;
}
