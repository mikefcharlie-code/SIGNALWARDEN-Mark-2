import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobeBounds } from "./worldview-globe-viewport";
import type { WorldObservation } from "./worldview-core";
import { chooseTileZoom, tilesForBounds, utcDate, type TileCoord } from "./worldview-basemap";
import type { OceanGlobeOverlay } from "./worldview-ocean-globe";
import {
  GRID_SCALES, MARINE_SOURCE, MAX_GRID, NDBC_SOURCE, COOPS_SOURCE, NOT_FOR_NAVIGATION, OCEAN_LAYER_ORDER, OCEAN_TILE_LAYERS,
  OceanTileLoader, boundedOceanBbox, defaultOceanDate, fetchOceanRelayStatus, gridPaintOps, refreshCoopsTides, refreshMarineGrid,
  refreshMarinePoint, refreshNdbcBuoys, validateOceanDate,
  type GridArrows, type GridMetric, type MarineResult, type OceanBbox, type OceanLayerId, type OceanRelayStatus, type OceanResult, type OceanTileRecord, type PaintOp, type TideResult,
} from "./worldview-ocean";
import "./worldview-ocean.css";

type Props = Readonly<{
  active: boolean;
  bounds: readonly GlobeBounds[];
  center: Readonly<{ lat: number; lon: number }>;
  zoom: number;
  onOverlay: (overlay: OceanGlobeOverlay | null) => void;
  onObservations: (source: string, observations: WorldObservation[]) => void;
}>;
type Feed = "point" | "grid" | "ndbc" | "coops";
const SOURCES: Record<Exclude<Feed, "grid">, string> = { point: "Open-Meteo Marine", ndbc: "NOAA NDBC", coops: "NOAA CO-OPS" };
const FEED_LABEL: Record<Feed, string> = { point: "Open-Meteo Marine (view centre)", grid: "Open-Meteo Marine grid", ndbc: "NOAA NDBC buoys", coops: "NOAA CO-OPS tides" };

const decode = (blob: Blob) => createImageBitmap(blob);
function newCanvas(size: number): OffscreenCanvas | HTMLCanvasElement {
  return typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(size, size) : Object.assign(document.createElement("canvas"), { width: size, height: size });
}
/** Draw the map tile (if any) and the marine grid paint operations into one 256 px texture. */
function paintTile(base: ImageBitmap | undefined, ops: readonly PaintOp[]): OffscreenCanvas | HTMLCanvasElement | null {
  const canvas = newCanvas(256);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;
  if (base) ctx.drawImage(base, 0, 0, 256, 256);
  for (const op of ops) {
    const [r, g, b, a] = op.rgba;
    if (op.kind === "cell") { ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`; ctx.fillRect(op.x, op.y, op.w, op.h); continue; }
    ctx.save();
    ctx.translate(op.x, op.y);
    ctx.rotate(op.angleRad); // 0 rad = toward north (up), clockwise
    ctx.strokeStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 2;
    const h = op.length / 2;
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, -h + 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -h); ctx.lineTo(-4, -h + 6); ctx.lineTo(4, -h + 6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  return canvas;
}

export default function WorldViewOcean({ active, bounds, center, zoom, onOverlay, onObservations }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [marineNonCommercial, setMarineNonCommercial] = useState(false);
  const [layerId, setLayerId] = useState<"" | OceanLayerId>("");
  const layer = layerId ? OCEAN_TILE_LAYERS[layerId] : null;
  const [date, setDate] = useState("");
  const [detail, setDetail] = useState(0);
  const [gridN, setGridN] = useState(6);
  const [metric, setMetric] = useState<GridMetric>("wave_height");
  const [arrows, setArrows] = useState<GridArrows>("current");
  const [showGrid, setShowGrid] = useState(true);
  const [results, setResults] = useState<Partial<Record<Feed, OceanResult>>>({});
  const [relay, setRelay] = useState<OceanRelayStatus | null>(null);
  const [tileSummary, setTileSummary] = useState<{ at: string; loaded: number; failed: number; throttled: number; fromCache: number; firstError?: string; providerTime?: string; freshness?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Off. No ocean provider requests have been made.");
  const loader = useRef<OceanTileLoader<ImageBitmap> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const next = new OceanTileLoader<ImageBitmap>({ network: enabled && active, decode, cacheEntries: 128, onEvict: (_k, v) => v.data.close?.() });
    loader.current = next;
    return () => { next.cache.clear(); if (loader.current === next) loader.current = null; };
  }, [enabled, active]);
  const effectiveDate = layer?.dated ? date || defaultOceanDate(layer) : "default";
  const dateError = useMemo(() => {
    if (!layer?.dated) return "";
    try { validateOceanDate(layer, effectiveDate); return ""; } catch (e) { return e instanceof Error ? e.message : "invalid date"; }
  }, [layer, effectiveDate]);
  const grid = showGrid && results.grid && "cells" in results.grid ? (results.grid as MarineResult) : null;
  const boundsKey = JSON.stringify(bounds.map((b) => [b.west, b.south, b.east, b.north].map((v) => Math.round(v * 10) / 10)));
  const centerKey = `${Math.round(center.lat)}:${Math.round(center.lon)}`;
  const viewBbox = (maxSpan: number): OceanBbox | null => {
    const v = bounds[0];
    if (!v) return null;
    try { return boundedOceanBbox(v, maxSpan); } catch { return null; }
  };

  // Clear everything this panel put on the globe when it closes.
  useEffect(() => () => {
    abort.current?.abort();
    onOverlay(null);
    Object.values(SOURCES).forEach((s) => onObservations(s, []));
  }, [onOverlay, onObservations]);

  useEffect(() => {
    if (active) return;
    abort.current?.abort();
    setBusy(null);
    setResults({});
    setTileSummary(null);
    onOverlay(null);
    Object.values(SOURCES).forEach((s) => onObservations(s, []));
    setMessage("Globe hidden. Ocean requests paused; overlays and markers cleared.");
  }, [active, onOverlay, onObservations]);

  // Drape the selected map layer and/or marine grid sample over the visible viewport.
  useEffect(() => {
    const gen = ++generation.current;
    if (!enabled || !active || (!layer && !grid) || (layer && dateError)) {
      onOverlay(null); setTileSummary(null);
      return;
    }
    const providerMax = layer ? layer.maxZoom : 8;
    const z = Math.min(providerMax, 8, chooseTileZoom(zoom, providerMax) + detail);
    const credits = [
      ...(layer ? [{ provider: layer.id, text: layer.attribution, termsUrl: layer.termsUrl }] : []),
      ...(grid ? [{ provider: "open-meteo-marine", text: "Marine grid: Open-Meteo.com (CC BY 4.0), Copernicus Marine, ECMWF, NOAA NCEP, DWD", termsUrl: MARINE_SOURCE.licenseUrl }] : []),
    ];
    const sourceId = `${layer?.id ?? "none"}@${effectiveDate}|${grid ? `${grid.retrievedAt}:${metric}:${arrows}` : "nogrid"}`;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const tiles: TileCoord[] = tilesForBounds(bounds, z, center, 48);
      if (!tiles.length) { setMessage("No visible viewport reported yet; nothing requested."); return; }
      let records: OceanTileRecord<ImageBitmap>[] = [];
      if (layer) {
        const r = await loader.current!.load(layer, effectiveDate, tiles, controller.signal);
        if (gen !== generation.current || controller.signal.aborted) return;
        records = r.loaded;
        setTileSummary({ at: new Date().toISOString(), loaded: r.loaded.length, failed: r.failed.length, throttled: r.throttled, fromCache: r.fromCache, firstError: r.failed[0]?.error, providerTime: r.loaded[0]?.providerTime, freshness: r.loaded[0]?.freshness });
      }
      const byKey = new Map(records.map((rec) => [rec.key, rec]));
      const out: { key: string; tile: TileCoord; image?: unknown }[] = [];
      for (const t of tiles) {
        const key = `${t.z}/${t.x}/${t.y}`;
        const base = byKey.get(key)?.data;
        const ops = grid?.grid ? gridPaintOps(grid.cells, grid.grid, metric, arrows, t) : [];
        if (!base && !ops.length) continue;
        out.push({ key, tile: t, image: ops.length ? paintTile(base, ops) ?? base : base });
      }
      onOverlay({ sourceId, tiles: out, opacity: layer?.opacity ?? 0.85, credits, note: layer?.dated ? `Product date ${effectiveDate} (UTC)` : undefined });
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, layerId, effectiveDate, dateError, detail, boundsKey, centerKey, zoom, grid, metric, arrows, onOverlay]);

  const disable = () => {
    abort.current?.abort();
    setEnabled(false);
    setLayerId("");
    setResults({});
    onOverlay(null);
    Object.values(SOURCES).forEach((s) => onObservations(s, []));
    setMessage("Off. Ocean overlays and markers cleared from the globe; tile cache dropped.");
  };

  const run = async (feed: Feed) => {
    if (!enabled || !active || busy) return;
    if ((feed === "point" || feed === "grid") && !marineNonCommercial) {
      setMessage("Open-Meteo Marine free-tier use requires confirmation that this use is personal, educational, or otherwise non-commercial; no request was made.");
      return;
    }
    const box = viewBbox(feed === "ndbc" ? 60 : 30);
    if (feed !== "point" && !box) { setMessage("No visible globe bounds yet; rotate or zoom the globe first."); return; }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const options = { network: true, signal: controller.signal };
    setBusy(feed);
    try {
      const result = feed === "point" ? await refreshMarinePoint(center, options)
        : feed === "grid" ? await refreshMarineGrid(box!, gridN, options)
          : feed === "ndbc" ? await refreshNdbcBuoys(box!, options)
            : await refreshCoopsTides(box!, center, options);
      if (controller.signal.aborted) return;
      setResults((r) => ({ ...r, [feed]: result }));
      if (feed !== "grid" && (result.observations.length || !result.error)) onObservations(SOURCES[feed], result.observations);
      const count = feed === "grid" && "cells" in result ? `${(result as MarineResult).cells.length} grid cell(s)` : `${result.observations.length} live record(s)`;
      setMessage(result.error ? `${FEED_LABEL[feed]}: ${result.error}` : `${FEED_LABEL[feed]}: ${count} retrieved ${result.retrievedAt}${result.truncated ? " (capped; more stations exist in view)" : ""}.`);
    } finally { if (abort.current === controller) { abort.current = null; setBusy(null); } }
  };
  const checkRelay = async () => {
    if (!enabled || !active || busy) return;
    setBusy("relay");
    try { const s = await fetchOceanRelayStatus({ network: true }); setRelay(s); setMessage(s.message); } finally { setBusy(null); }
  };

  const tides = results.coops && "stations" in results.coops ? (results.coops as TideResult).stations : [];
  const today = utcDate(Date.now());
  const off = !enabled || !active || !!busy;
  return <section className="wv-ocean" aria-label="Ocean maps and data">
    <h2><small>LIVE PUBLIC OCEAN DATA · READ-ONLY · OPT-IN</small>Ocean maps & data</h2>
    <p className="oc-nav" role="note"><b>{NOT_FOR_NAVIGATION}</b></p>
    <p>Map layers are draped over the globe for the visible area only (≤48 tiles per view, ≤2 MiB per tile, rate-limited, in-memory cache). Data buttons each send one bounded request when pressed. Nothing is fetched until you opt in below.</p>
    <label className="oc-opt-in"><input type="checkbox" checked={enabled} disabled={!active} onChange={(e) => (e.target.checked ? (setEnabled(true), setMessage("On for this session. Pick a map layer or press a data button.")) : disable())} /> Allow ocean provider requests for this session (NASA GIBS, GEBCO, NOAA NCEI, NOAA ENC, Open-Meteo, NOAA CO-OPS, and the local relay for NOAA NDBC). Only the visible area or view centre is sent.</label>
    <label className="oc-opt-in"><input type="checkbox" checked={marineNonCommercial} onChange={(e) => setMarineNonCommercial(e.target.checked)} /> I confirm that any direct Open-Meteo Marine free-tier use is personal, educational, or otherwise non-commercial. This is required only for the Marine point/grid buttons.</label>
    {!active && <p role="status">Globe not visible: ocean requests are paused and overlays are cleared.</p>}

    <fieldset className="oc-card"><legend>Map layer (draped on the globe)</legend>
      <label>Layer <select aria-label="Ocean map layer" value={layerId} onChange={(e) => { setLayerId(e.target.value as OceanLayerId | ""); setDate(""); }}>
        <option value="">None</option>
        {(["bathymetry", "chart", "ocean-product"] as const).map((cat) => <optgroup key={cat} label={cat === "bathymetry" ? "Bathymetry / ocean relief" : cat === "chart" ? "Nautical charts" : "NASA GIBS ocean products"}>
          {OCEAN_LAYER_ORDER.filter((id) => OCEAN_TILE_LAYERS[id].category === cat).map((id) => <option key={id} value={id}>{OCEAN_TILE_LAYERS[id].label}</option>)}
        </optgroup>)}
      </select></label>
      {layer?.dated && <label>Product date (UTC) <input type="date" aria-label="Ocean product date" value={effectiveDate} min={layer.minDate} max={today} onChange={(e) => setDate(e.target.value)} /></label>}
      <label>Extra detail <select aria-label="Tile detail" value={detail} onChange={(e) => setDetail(Number(e.target.value))}>{[0, 1, 2].map((d) => <option key={d} value={d}>{d ? `+${d} zoom level${d > 1 ? "s" : ""}` : "match globe"}</option>)}</select></label>
      {layer && <p className="fine">{layer.coverageNote}{layer.legend ? ` ${layer.legend}.` : ""} <a href={layer.termsUrl} target="_blank" rel="noreferrer noopener">{layer.licenseNote}</a>.</p>}
      {dateError && <p className="oc-error">Date rejected: {dateError}. Nothing requested.</p>}
      {tileSummary && <p className={tileSummary.failed ? "oc-stale" : ""}>Tiles: {tileSummary.loaded} shown ({tileSummary.fromCache} from cache), {tileSummary.failed} failed, {tileSummary.throttled} throttled · retrieved {tileSummary.at}{tileSummary.providerTime ? ` · provider time ${tileSummary.providerTime}` : ""} · freshness <b>{(tileSummary.freshness ?? "unknown").toUpperCase()}</b>{tileSummary.firstError ? ` · first error: ${tileSummary.firstError}` : ""}</p>}
    </fieldset>

    <div className="oc-grid">
      <div className="oc-card">
        <h3>Open-Meteo Marine · waves, swell, currents, SST</h3>
        <button disabled={off || !marineNonCommercial} onClick={() => run("point")}>Read marine conditions at view centre</button>
        <label>Grid <select aria-label="Marine grid size" value={gridN} onChange={(e) => setGridN(Number(e.target.value))}>{Array.from({ length: MAX_GRID - 1 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}×{n} = {n * n} points</option>)}</select></label>
        <label>Colour <select aria-label="Grid colour metric" value={metric} onChange={(e) => setMetric(e.target.value as GridMetric)}>{(Object.keys(GRID_SCALES) as GridMetric[]).map((m) => <option key={m} value={m}>{GRID_SCALES[m].label} ({GRID_SCALES[m].min}–{GRID_SCALES[m].max} {GRID_SCALES[m].unit})</option>)}</select></label>
        <label>Arrows <select aria-label="Grid arrows" value={arrows} onChange={(e) => setArrows(e.target.value as GridArrows)}><option value="current">Current (toward)</option><option value="wave">Mean waves (travel direction)</option><option value="swell">Swell (travel direction)</option><option value="none">None</option></select></label>
        <button disabled={off || !marineNonCommercial} onClick={() => run("grid")}>Sample grid over visible area (≤30° box)</button>
        <label><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Draw grid on globe</label>
        <p className="fine">Model analysis/forecast, not measurements. Each grid point counts against Open-Meteo's free, non-commercial quota; direct calls are blocked until the confirmation above. Coastal accuracy is limited. Grey/empty cells are land or outside the model.</p>
      </div>
      <div className="oc-card">
        <h3>NOAA NDBC buoys (via relay)</h3>
        <button disabled={off} onClick={() => run("ndbc")}>Fetch latest buoy observations in view</button>
        <button disabled={off} onClick={checkRelay}>Check ocean relay</button>
        {relay && <p className={`oc-status ${relay.state}`}>Relay: {relay.state}</p>}
        <p className="fine">Measured, provisional latest reports (≤300 stations, nearest the centre first). NDBC sends no CORS headers, so this goes through the local server, which must run with <code>UCAS_WORLDVIEW_OCEAN_ENABLED=1</code>. No key is needed.</p>
      </div>
      <div className="oc-card">
        <h3>NOAA CO-OPS tides & water levels</h3>
        <button disabled={off} onClick={() => run("coops")}>Fetch nearest tide stations in view (≤5)</button>
        <p className="fine">Latest measured water level (preliminary unless verified) and the next 48 h of predicted highs and lows (MLLW, metres; IGLD for the Great Lakes). U.S. stations only. Predictions are astronomical and ignore storm surge.</p>
      </div>
    </div>

    <p role="status" className="oc-message">{busy ? `Requesting ${busy}…` : message}</p>
    <ul className="oc-results">
      {(Object.keys(results) as Feed[]).map((f) => {
        const r = results[f]!;
        const info = f === "ndbc" ? NDBC_SOURCE : f === "coops" ? COOPS_SOURCE : MARINE_SOURCE;
        const count = f === "grid" && "cells" in r ? `${(r as MarineResult).cells.length} cell(s)` : `${r.observations.length} record(s)`;
        return <li key={f} className={`oc-${r.status}`}>
          <b>{FEED_LABEL[f]}</b> · {r.status.toUpperCase()} · {count} · retrieved {r.retrievedAt}{r.error ? <> · <span className="oc-error">{r.error}</span></> : null}
          <br /><small>{info.attribution} · <a href={info.termsUrl} target="_blank" rel="noreferrer noopener">terms</a>{r.sourceUrl && !r.sourceUrl.startsWith("/") ? <> · <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">source</a></> : null}</small>
        </li>;
      })}
    </ul>
    {tides.length > 0 && <table className="oc-tides"><caption>Tide stations (times UTC; not for navigation)</caption>
      <thead><tr><th>Station</th><th>Latest water level</th><th>Next tides</th></tr></thead>
      <tbody>{tides.map((t) => <tr key={t.station.id}>
        <td><a href={t.pageUrl} target="_blank" rel="noreferrer noopener">{t.station.name}{t.station.state ? `, ${t.station.state}` : ""}</a></td>
        <td>{t.waterLevelM !== null ? `${t.waterLevelM.toFixed(2)} m ${t.datum} at ${t.waterLevelTime?.slice(11, 16)}Z (${t.quality ?? "unflagged"})` : t.error ?? "no data"}</td>
        <td>{t.predictions.filter((p) => Date.parse(p.time) > Date.now()).slice(0, 3).map((p) => `${p.type === "H" ? "High" : "Low"} ${p.heightM.toFixed(2)} m ${p.time.slice(5, 16).replace("T", " ")}Z`).join(" · ") || "—"}</td>
      </tr>)}</tbody></table>}
  </section>;
}
