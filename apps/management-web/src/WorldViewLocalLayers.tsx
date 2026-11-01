import { getDecoder } from "geotiff";
import { useEffect, useMemo, useRef, useState } from "react";
import { createDemoObservations, importObservationPack, type GeoPoint, type WorldObservation } from "./worldview-core";
import { aggregateLocalObservations } from "./worldview-local-hex";
import { inspectLocalRaster, type LocalRaster } from "./worldview-local-raster";
import { createImageryAoi, type ImageryAoi } from "./worldview-imagery-aoi";
import type { LonLat } from "./worldview-draped-raster";
import type { GlobeImageryLayer } from "./worldview-globe-imagery";
import "./worldview-local-layers.css";

const date = (value?: number) => value ? new Date(value).toISOString() : "not supplied";
const fmt = (values: readonly number[]) => values.map(v => Number.isFinite(v) ? Number(v.toPrecision(8)) : String(v)).join(", ");
const seam = (points: readonly GeoPoint[]) => points.some((p, i) => i > 0 && Math.abs(p.lon - points[i - 1].lon) > 180);

// Fetch application code only when the panel opens, never on file selection.
export async function prepareLocalLayers(): Promise<void> {
  await getDecoder(1, { tileWidth: 1, tileHeight: 1, predictor: 1, bitsPerSample: [8], planarConfiguration: 1 });
}

type Props = {
  onImageryLayer?: (key: string, layer: GlobeImageryLayer | null) => void;
  imageryAois: ReadonlyArray<ImageryAoi>;
  selectedAoiId: string | null;
  aoiDraft: ReadonlyArray<LonLat>;
  aoiDrawing: boolean;
  onSelectAoi: (id: string | null) => boolean;
  onStartAoi: (points: LonLat[]) => void;
  onDraftChange: (points: LonLat[]) => void;
  onSaveAoi: (aoi: ImageryAoi, replaceId?: string) => boolean;
  onCancelAoi: () => void;
  onDeleteAoi: (id: string) => boolean;
  onResetAois: () => boolean;
};

export default function WorldViewLocalLayers(props: Props) {
  const [points, setPoints] = useState<WorldObservation[]>([]);
  const [provenance, setProvenance] = useState<"synthetic" | "user-supplied">("synthetic");
  const [source, setSource] = useState("No local dataset loaded");
  const [loadedAt, setLoadedAt] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [resolution, setResolution] = useState(5);
  const [raster, setRaster] = useState<LocalRaster | null>(null);
  const [overlay, setOverlay] = useState(true);
  const [globeOverlay, setGlobeOverlay] = useState(false);
  const [message, setMessage] = useState("Local only. Choose a file or explicitly load the synthetic sample.");
  const [aoiName, setAoiName] = useState("");
  const [editingAoiId, setEditingAoiId] = useState<string | null>(null);
  const [aoiMessage, setAoiMessage] = useState("No imagery AOI selected; a visible raster is shown at full validated extent.");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const packGeneration = useRef(0);
  useEffect(() => () => { controller.current?.abort(); packGeneration.current++; }, []);
  useEffect(() => () => props.onImageryLayer?.("local-geotiff", null), [props.onImageryLayer]);
  useEffect(() => {
    if (!raster || !globeOverlay) { props.onImageryLayer?.("local-geotiff", null); return; }
    props.onImageryLayer?.("local-geotiff", {
      key: "local-geotiff",
      provider: "Local GeoTIFF",
      productId: raster.name,
      surface: raster.surface,
      retrievedAt: raster.importedAt,
      footprint: raster.footprint.map(({ lon, lat }) => [lon, lat] as const),
      attribution: "User-selected local file; source attribution is not independently verified.",
      license: "User-supplied; licensing not independently verified",
      freshness: "unknown",
      refreshState: "manual",
      coverageNote: `Validated ${raster.crs} source affine transform; bounded ${raster.surface.width} × ${raster.surface.height} display grid.`,
      registrationNote: `Draped from the file's own ${raster.crs} affine transform, not from its footprint. Display is grayscale and downsampled; acquisition time is unknown.`,
    });
    return () => props.onImageryLayer?.("local-geotiff", null);
  }, [raster, globeOverlay, props.onImageryLayer]);
  const aggregate = useMemo(() => enabled ? aggregateLocalObservations(points, resolution, provenance) : null, [enabled, points, resolution, provenance]);
  const visibleHex = aggregate?.cells.filter(c => !seam(c.boundary)) ?? [];
  const rasterCells = overlay ? raster?.preview.cells.filter(c => c.value !== null && !seam(c.corners)) ?? [] : [];
  const allCorners = [...visibleHex.flatMap(c => c.boundary), ...(overlay && raster && !seam(raster.footprint) ? raster.footprint : [])];
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
      if (!current.signal.aborted) { setRaster(result); setMessage(`User-supplied raster loaded locally and georeferenced from its ${result.crs} affine transform. Globe layer is bounded to ${result.surface.width} × ${result.surface.height}; not authoritative terrain or current imagery.`); }
    } catch (error) { if (!current.signal.aborted) setMessage(error instanceof Error ? error.message : "Raster rejected"); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const selectedAoi = props.imageryAois.find((aoi) => aoi.id === props.selectedAoiId) ?? null;
  const startNewAoi = () => { setEditingAoiId(null); setAoiName(`Imagery AOI ${props.imageryAois.length + 1}`); props.onStartAoi([]); setAoiMessage("Drawing mode is active. Click the globe to add WGS84 vertices; finish after at least three points."); };
  const editSelectedAoi = () => {
    if (!selectedAoi) return;
    setEditingAoiId(selectedAoi.id); setAoiName(selectedAoi.name); props.onStartAoi(selectedAoi.ring.slice(0, -1).map(([lon, lat]) => [lon, lat]));
    setAoiMessage("Editing the selected imagery-only AOI. Adjust coordinates below or click the globe to append vertices.");
  };
  const saveAoi = () => {
    try {
      const aoi = createImageryAoi(aoiName, props.aoiDraft, editingAoiId ?? undefined);
      const persisted = props.onSaveAoi(aoi, editingAoiId ?? undefined); props.onCancelAoi(); setEditingAoiId(null);
      setAoiMessage(persisted ? `Saved ${aoi.name} in this browser; it will clip the displayed georeferenced raster when selected.` : `Saved ${aoi.name} for this session only; browser storage rejected the write.`);
    } catch (error) { setAoiMessage(error instanceof Error ? error.message : "AOI could not be saved"); }
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
      <label><input type="checkbox" checked={globeOverlay} disabled={!raster} onChange={e => { const enabled = e.target.checked; setGlobeOverlay(enabled); setMessage(enabled ? "Validated raster drape enabled on the globe. The selected imagery AOI clips it; source affine/CRS metadata remain below." : "Validated raster drape disabled; the local sample and metadata remain available in this panel."); }} /> Show validated raster on globe</label>
      <button onClick={() => { controller.current?.abort(); packGeneration.current++; setBusy(false); setRaster(null); setPoints([]); setEnabled(false); setSource("No local dataset loaded"); setLoadedAt(""); setMessage("Local layers cleared from this workspace."); }}>Clear local layers</button>
    </div>
    <section className="imagery-aoi" aria-label="Imagery AOI geofences">
      <h3>Imagery AOI geofences <small>DISPLAY CLIPPING ONLY</small></h3>
      <p>These WGS84 polygons are separate from aircraft/flight-safety geofences. They are saved only in this browser and clip georeferenced imagery at display-cell resolution; they do not change provider search scope, upload observations, or send requests.</p>
      <div className="local-layer-controls">
        <label>Selected imagery AOI <select aria-label="Selected imagery AOI" value={props.selectedAoiId ?? ""} onChange={e => { if (!props.onSelectAoi(e.target.value || null)) setAoiMessage("Selection applies for this session only; browser storage rejected the write."); }}><option value="">No AOI — full validated raster</option>{props.imageryAois.map(aoi => <option key={aoi.id} value={aoi.id}>{aoi.name} ({aoi.ring.length - 1} vertices)</option>)}</select></label>
        <button disabled={props.imageryAois.length >= 50} onClick={startNewAoi}>Draw new AOI</button>
        <button disabled={!selectedAoi || props.aoiDrawing} onClick={editSelectedAoi}>Edit selected AOI</button>
        <button disabled={!selectedAoi} onClick={() => { const persisted = selectedAoi ? props.onDeleteAoi(selectedAoi.id) : true; setAoiMessage(persisted ? "Selected imagery AOI deleted from this browser." : "Selected imagery AOI deleted for this session only; browser storage rejected the write."); }}>Delete selected AOI</button>
        <button disabled={!props.imageryAois.length} onClick={() => { const persisted = props.onResetAois(); setAoiMessage(persisted ? "All imagery AOIs removed from this browser." : "All imagery AOIs removed for this session only; browser storage rejected the write."); }}>Reset imagery AOIs</button>
      </div>
      <p>{selectedAoi ? `Active clipping polygon: ${selectedAoi.name} (${selectedAoi.ring.length - 1} vertices). All visible georeferenced raster surfaces are clipped to its interior.` : "No AOI selected: full validated source raster extents are displayed."}</p>
      <p role="status">{aoiMessage}</p>
      {props.aoiDrawing && <div className="imagery-aoi-editor">
        <label>AOI name <input aria-label="Imagery AOI name" maxLength={80} value={aoiName} onChange={e => setAoiName(e.target.value)} /></label>
        <p>Vertices: {props.aoiDraft.length}. Click an unobscured point on the globe or edit coordinates directly. Date-line-crossing polygons are supported.</p>
        <ol>{props.aoiDraft.map(([lon, lat], index) => <li key={index}>
          <label>Longitude <input aria-label={`AOI vertex ${index + 1} longitude`} type="number" min={-180} max={180} step="any" value={lon} onChange={e => { const value = Number(e.target.value); props.onDraftChange(props.aoiDraft.map((point, i) => i === index ? [value, point[1]] : point)); }} /></label>
          <label>Latitude <input aria-label={`AOI vertex ${index + 1} latitude`} type="number" min={-90} max={90} step="any" value={lat} onChange={e => { const value = Number(e.target.value); props.onDraftChange(props.aoiDraft.map((point, i) => i === index ? [point[0], value] : point)); }} /></label>
          <button onClick={() => props.onDraftChange(props.aoiDraft.filter((_, i) => i !== index))}>Remove vertex</button>
        </li>)}</ol>
        <div className="local-layer-controls"><button disabled={props.aoiDraft.length === 0} onClick={() => props.onDraftChange(props.aoiDraft.slice(0, -1))}>Undo last vertex</button><button disabled={props.aoiDraft.length < 3} onClick={saveAoi}>Finish and save AOI</button><button onClick={() => { props.onCancelAoi(); setEditingAoiId(null); setAoiMessage("AOI drawing cancelled; saved geofences are unchanged."); }}>Cancel drawing</button></div>
      </div>}
    </section>
    <p role="status">{message}</p>
    <p><b>Dataset: {provenance.toUpperCase()}</b> · {source} · Loaded {loadedAt || "not yet"}. {points.length} points. Source labels and observation times are supplied by the dataset, not verification.</p>
    {aggregate && <p><b>{aggregate.pointCount} points / {aggregate.cells.length} occupied H3 cells / resolution {aggregate.resolution}</b> · Occupied-cell area: {aggregate.coverageKm2.toFixed(3)} km². This is grid-cell area, not sensor coverage, uncertainty, or observed surface area.</p>}
    <figure>
      <svg viewBox="0 0 800 400" role="img" aria-label="Offline SVG local hex and user-supplied raster overlay">
        <rect width="800" height="400" fill="#081820" />
        {overlay && raster && !seam(raster.footprint) && <polygon points={polygon(raster.footprint)} fill="none" stroke="#9caeb6" strokeDasharray="5 5"><title>User-supplied raster footprint; missing samples remain transparent</title></polygon>}
        {rasterCells.map((cell, i) => <polygon key={`r-${i}`} points={polygon(cell.corners)} fill={color(cell.value!)} opacity="0.75"><title>User-supplied raster first band: {cell.value}</title></polygon>)}
        {visibleHex.map(cell => <polygon key={cell.id} points={polygon(cell.boundary)} fill="#38bdaa" fillOpacity={Math.min(0.8, 0.2 + cell.count / Math.max(1, aggregate!.pointCount))} stroke="#85f4dd" strokeWidth="1"><title>{cell.id}: {cell.count} points · {cell.sources.join(", ")}</title></polygon>)}
        {!allCorners.length && <text x="30" y="200" fill="#bdded7">Load local data and enable a layer to see a preview.</text>}
      </svg>
      <figcaption>SVG / no WebGL required · equirectangular data-fit workbench preview (not a navigation map). WGS84 extent: {fmt([west, south, east, north])}. This separate sample remains ≤32 × 32 cells; the globe surface uses the actual source pixels downsampled to ≤128 × 128 with its validated affine transform. Neither is terrain or current imagery. {raster && seam(raster.footprint) ? "Antimeridian-crossing footprint/sample polygons omitted from this equirectangular preview; the globe surface uses spherical coordinates." : ""} {aggregate && aggregate.cells.length !== visibleHex.length ? "Antimeridian-crossing hexagons omitted from preview; all counts remain in the table." : ""}</figcaption>
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
        <dt>Georeferenced globe surface / transform</dt><dd>{raster.surface.width} × {raster.surface.height} display cells · source {raster.surface.crs} · affine scale {fmt([raster.surface.transform.pixelWidth, raster.surface.transform.pixelHeight])} · WGS84 center grid preserves the file transform</dd>
        <dt>Acquisition time / authority</dt><dd>Unknown. File modification time is not acquisition time. No terrain, elevation datum, or imagery currency is verified.</dd>
      </dl>
    </div>}
    {aggregate && <div className="local-hex-table"><table><caption>Occupied cells, dataset-provided provenance and times (first 100 of {aggregate.cells.length})</caption><thead><tr><th>H3 cell</th><th>Count</th><th>Area km²</th><th>Sources</th><th>First / last observation</th></tr></thead><tbody>{aggregate.cells.slice(0, 100).map(c => <tr key={c.id}><td>{c.id}</td><td>{c.count}</td><td>{c.areaKm2.toFixed(3)}</td><td>{c.sources.join("; ")}</td><td>{c.firstObservedAt} / {c.lastObservedAt}</td></tr>)}</tbody></table></div>}
    <p>Limits: uncompressed TIFF only; ≤16 MiB, ≤4096 per side, ≤4 million pixels, ≤4 bands. Supported CRS: WGS84 geographic, Web Mercator, WGS84 UTM only. Unsupported datums/grids, ambiguous CRS, rotated and PixelIsPoint rasters are rejected.</p>
    <p><a href="/worldview-local-layers-notices.txt" target="_blank" rel="noreferrer">Open-source licenses and notices</a> · H3, GeoTIFF.js, Proj4js. No aircraft control, target selection, sensor tasking, or mission planning.</p>
  </section>;
}
