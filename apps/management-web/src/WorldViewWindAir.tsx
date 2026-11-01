import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { GeoPoint, WorldObservation } from "./worldview-core";
import type { GlobeBounds } from "./worldview-globe-viewport";
import { WEATHER_MODELS, fetchWeatherRelayStatus, isWeatherModel, mergeProviderObservations, type RelayStatus, type WeatherModel } from "./worldview-weather";
import {
  WIND_LEVELS, chooseGridShape, currentHourIndex, fieldStats, isWindLevel, msToKnots, refreshWindField, viewportSpan,
  type GridResult, type WindLevel,
} from "./worldview-windfield";
import {
  AIR_SAT_LAYERS, AIR_VARIABLES, OPENAQ_MAP_SOURCE, airSatSource, defaultAirSatDate, hourIndexFor, isAirSatLayer, isAirVariable, openAqBox,
  refreshAirGrid, refreshOpenAqStations, validateAirSatDate, type AirSatLayerId, type AirVariable, type StationResult,
} from "./worldview-airgrid";
import { TileLoader, chooseTileZoom, formatAge, tilesForBounds, type GlobeBasemapTile } from "./worldview-basemap";
import type { WindAirGlobeState } from "./worldview-windair-globe";
import "./worldview-weather.css";

type Props = {
  active: boolean;
  bounds: GlobeBounds[];
  center: GeoPoint;
  zoom: number;
  onGlobeLayer: (state: WindAirGlobeState | null) => void;
  onRecords?: Dispatch<SetStateAction<WorldObservation[]>>;
};

const num = (v: number | undefined | null, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const ago = (iso: string | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const reducedMotionPreferred = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const decodeImage = (blob: Blob) => createImageBitmap(blob);

export function WorldViewWindAir({ active, bounds, center, zoom, onGlobeLayer, onRecords }: Props) {
  const [optIn, setOptIn] = useState(false);
  const [freeNonCommercial, setFreeNonCommercial] = useState(false);
  const [relay, setRelay] = useState<RelayStatus | { enabled: false; error: string } | null>(null);
  const [model, setModel] = useState<WeatherModel>("gfs_seamless");
  const [density, setDensity] = useState(64);
  const [level, setLevel] = useState<WindLevel>("10m");
  const [reduced] = useState(reducedMotionPreferred);
  const [animate, setAnimate] = useState(() => !reducedMotionPreferred());
  const [showWind, setShowWind] = useState(true);
  const [wind, setWind] = useState<GridResult | null>(null);
  const [air, setAir] = useState<GridResult | null>(null);
  const [airVar, setAirVar] = useState<AirVariable>("us_aqi");
  const [showHeat, setShowHeat] = useState(true);
  const [heatOpacity, setHeatOpacity] = useState(0.55);
  const [validTime, setValidTime] = useState<string | undefined>();
  const [stations, setStations] = useState<StationResult | null>(null);
  const [satId, setSatId] = useState<AirSatLayerId>("modis-aod");
  const [satDate, setSatDate] = useState(() => defaultAirSatDate(AIR_SAT_LAYERS["modis-aod"]));
  const [satOn, setSatOn] = useState(false);
  const [satOpacity, setSatOpacity] = useState(0.8);
  const [satTiles, setSatTiles] = useState<GlobeBasemapTile[]>([]);
  const [satNote, setSatNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);
  const satAbort = useRef<AbortController | null>(null);
  const loader = useRef<TileLoader<ImageBitmap> | null>(null);

  useEffect(() => {
    if (!active) {
      abort.current?.abort(); satAbort.current?.abort(); loader.current?.cache.clear(); loader.current = null;
      onGlobeLayer(null);
      setWind(null); setAir(null); setStations(null); setSatTiles([]); setSatOn(false); setBusy(null);
      onRecords?.((records) => records.filter((r) => r.source !== OPENAQ_MAP_SOURCE));
      return;
    }
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => { clearInterval(t); abort.current?.abort(); satAbort.current?.abort(); loader.current?.cache.clear(); onGlobeLayer(null); };
  }, [active, onGlobeLayer, onRecords]);

  const relayOn = relay?.enabled === true;
  const commercial = relayOn && (relay as RelayStatus).providers?.openMeteo?.tier === "commercial";
  const span = useMemo(() => viewportSpan(bounds), [bounds]);
  const shape = span ? chooseGridShape(span, density) : null;

  const run = async (kind: "relay" | "wind" | "air" | "stations") => {
    if (!optIn || !active || busy) return;
    if ((kind === "wind" || kind === "air") && !commercial && !freeNonCommercial) {
      setSatNote("Open-Meteo free-tier forecast/AQ calls are blocked until you confirm personal, educational, or otherwise non-commercial use.");
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const options = { network: true, signal: controller.signal, relay: commercial };
    setBusy(kind);
    try {
      if (kind === "relay") { setRelay(await fetchWeatherRelayStatus({ network: true, signal: controller.signal })); return; }
      if (kind === "stations") {
        const r = await refreshOpenAqStations(openAqBox(span), { network: true, signal: controller.signal });
        if (controller.signal.aborted) return;
        setStations(r);
        onRecords?.((records) => mergeProviderObservations(records, { providerId: "openaq", observations: r.observations, retrievedAt: r.retrievedAt, freshness: r.status === "live" ? "fresh" : "stale", status: r.status, error: r.error, attribution: r.attribution, termsUrl: r.termsUrl }, OPENAQ_MAP_SOURCE));
        return;
      }
      if (!span || !shape) return;
      const r = kind === "wind" ? await refreshWindField(span, shape, model, options) : await refreshAirGrid(span, shape, options);
      if (controller.signal.aborted) return;
      if (kind === "wind") setWind(r); else setAir(r);
      if (r.field && !validTime) setValidTime(r.field.times[currentHourIndex(r.field.times, Date.now())]);
    } finally {
      setClock(Date.now());
      if (abort.current === controller) { abort.current = null; setBusy(null); }
    }
  };

  // Satellite tiles: only after the user turns a layer on; then visible tiles only, bounded + cached by the shared loader.
  useEffect(() => {
    if (!optIn || !active || !satOn) { satAbort.current?.abort(); setSatTiles([]); return; }
    let source;
    try { source = airSatSource(satId, satDate); } catch (e) { setSatNote(e instanceof Error ? e.message : "Invalid date"); setSatTiles([]); return; }
    loader.current ??= new TileLoader<ImageBitmap>({ network: true, decode: decodeImage, cacheEntries: 96, onEvict: (_k, rec) => rec.data.close?.() });
    const z = chooseTileZoom(zoom, AIR_SAT_LAYERS[satId].maxZoom);
    const tiles = tilesForBounds(bounds, z, center, 32);
    const controller = new AbortController();
    satAbort.current?.abort();
    satAbort.current = controller;
    const timer = setTimeout(async () => {
      setSatNote("Loading visible satellite tiles…");
      const res = await loader.current!.load(source, tiles, controller.signal);
      if (controller.signal.aborted) return;
      setSatTiles(res.loaded.map((r) => ({ key: r.key, tile: r.tile, image: r.data })));
      const newest = res.loaded.find((r) => r.providerTime)?.providerTime;
      const fresh = res.loaded[0];
      setSatNote(`${res.loaded.length}/${tiles.length} tile(s) · ${res.fetched} fetched, ${res.fromCache} cached${res.failed.length ? `, ${res.failed.length} failed (${res.failed[0].error})` : ""}${res.throttled ? `, ${res.throttled} throttled` : ""} · provider day ${newest?.slice(0, 10) ?? satDate} · ${fresh ? `${fresh.freshness}, ${formatAge(fresh.ageMs)} old` : "no tiles"}`);
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [optIn, active, satOn, satId, satDate, bounds, zoom, center.lat, center.lon]);

  const windField = wind?.field, airField = air?.field;
  const times = windField?.times ?? airField?.times ?? [];
  const sliderIndex = Math.max(0, times.indexOf(validTime ?? ""));
  const windHour = hourIndexFor(windField, validTime), airHour = hourIndexFor(airField, validTime);

  const globeState = useMemo<WindAirGlobeState | null>(() => {
    if (!optIn || !active) return null;
    const credits: Array<{ text: string; termsUrl: string }> = [];
    const st: { wind?: WindAirGlobeState["wind"]; heat?: WindAirGlobeState["heat"]; satellite?: WindAirGlobeState["satellite"] } = {};
    if (showWind && windField && wind?.provenance) {
      st.wind = { field: windField, level, hour: windHour, animate: animate && !reduced, validTime: windField.times[windHour] };
      credits.push({ text: wind.provenance.attribution.split(";")[0], termsUrl: wind.provenance.termsUrl }, { text: WEATHER_MODELS[model].label, termsUrl: wind.provenance.licenseUrl });
    }
    if (showHeat && airField && air?.provenance) {
      st.heat = { field: airField, variable: airVar, hour: airHour, opacity: heatOpacity, validTime: airField.times[airHour] };
      credits.push({ text: air.provenance.attribution, termsUrl: air.provenance.termsUrl });
    }
    if (satOn && satTiles.length) {
      const layer = AIR_SAT_LAYERS[satId];
      st.satellite = { sourceId: `air:${layer.gibsLayer}@${satDate}`, label: layer.label, date: satDate, tiles: satTiles, opacity: satOpacity, legendUrl: layer.legendUrl };
      credits.push({ text: "NASA EOSDIS GIBS / Worldview", termsUrl: "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance" });
    }
    if (!st.wind && !st.heat && !st.satellite) return null;
    return { ...st, credits, note: "Not for flight planning or certified use." };
  }, [optIn, active, showWind, windField, wind, level, windHour, animate, reduced, model, showHeat, airField, air, airVar, airHour, heatOpacity, satOn, satTiles, satId, satDate, satOpacity]);

  useEffect(() => { onGlobeLayer(globeState); }, [globeState, onGlobeLayer]);

  const disabled = !optIn || !active || busy !== null;
  const freeTierBlocked = !commercial && !freeNonCommercial;
  const levelDef = WIND_LEVELS[level];
  const wStats = windField ? fieldStats(windField, levelDef.speed, windHour) : null;
  const pStats = windField ? fieldStats(windField, "pressure_msl", windHour) : null;
  const aStats = airField ? fieldStats(airField, airVar, airHour) : null;
  const sat = AIR_SAT_LAYERS[satId];

  return <section className="wv-panel weather-panel windair-panel" aria-label="Wind and air quality map layers">
    <div className="panel-head"><span className="wv-label">WEATHER · MAP LAYERS · WIND &amp; AIR</span><span className="mono">READ-ONLY</span></div>
    <label><input type="checkbox" aria-label="Allow wind and air map layer requests" checked={optIn} disabled={!active} onChange={(e) => { setOptIn(e.target.checked); if (!e.target.checked) { abort.current?.abort(); setSatOn(false); } }} /> allow map-layer requests from this panel</label>
    <label><input type="checkbox" aria-label="Confirm Open-Meteo free-tier non-commercial use" checked={freeNonCommercial} onChange={(e) => setFreeNonCommercial(e.target.checked)} /> I confirm any direct Open-Meteo free-tier wind/AQ use is personal, educational, or otherwise non-commercial. A configured commercial relay does not require this confirmation.</label>
    {!active && <p role="status">Globe not visible: wind/air requests are paused and their map layers are cleared.</p>}
    <p className="fine-print">Off by default; nothing is requested until you press a button. Grids sample the visible globe at ≤{density} points (rounded to 0.01°) in one Open-Meteo request; keyless free-tier calls require the non-commercial confirmation above. A full grid counts as ~1.4 calls per point, so refreshes are spaced ≥2 min (relay: commercial key, ≥30 s). Re-sample after panning.</p>
    <button disabled={disabled} onClick={() => run("relay")}>Check local relay</button>
    <span className="source-note" role="status"> {relay == null ? `Relay not checked: grids may go direct (free tier)${freeTierBlocked ? "; non-commercial confirmation required" : ""}; OpenAQ needs the relay.` : relayOn ? `Relay on · Open-Meteo ${commercial ? "commercial (via relay)" : `free (direct)${freeTierBlocked ? " · blocked until acknowledged" : ""}`} · OpenAQ ${(relay as RelayStatus).providers.openAq?.status ?? "?"}` : `Relay unavailable: ${"error" in relay ? relay.error : "disabled"}`}</span>
    <div>
      <label>Grid <select aria-label="Grid density" value={String(density)} onChange={(e) => setDensity(Number(e.target.value))}>
        <option value="36">≤36 points</option><option value="64">≤64 points</option><option value="100">≤100 points (max)</option>
      </select></label>{" "}
      <span className="fine-print">{shape ? `${shape.rows}×${shape.cols} over ${span!.south.toFixed(1)}…${span!.north.toFixed(1)}°, ${span!.west.toFixed(1)}…${(span!.east > 180 ? span!.east - 360 : span!.east).toFixed(1)}°` : "viewport unknown (rotate the globe once)"}</span>
    </div>

    <div className="panel-head"><span className="wv-label">WIND FIELD · MODEL FORECAST</span></div>
    <label>Model <select aria-label="Wind grid model" value={model} onChange={(e) => { if (isWeatherModel(e.target.value)) setModel(e.target.value); }}>
      {Object.entries(WEATHER_MODELS).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
    </select></label>{" "}
    <button disabled={disabled || !shape || freeTierBlocked} onClick={() => run("wind")}>Sample wind grid for this view</button>
    <div>
      <label>Level <select aria-label="Wind level" value={level} onChange={(e) => { if (isWindLevel(e.target.value)) setLevel(e.target.value); }}>
        {Object.entries(WIND_LEVELS).map(([id, l]) => <option key={id} value={id}>{l.label}</option>)}
      </select></label>{" "}
      <label><input type="checkbox" checked={showWind} onChange={(e) => setShowWind(e.target.checked)} /> show</label>{" "}
      <label title={reduced ? "Your system asks for reduced motion; static arrows are used" : undefined}><input type="checkbox" aria-label="Animate wind particles" checked={animate && !reduced} disabled={reduced} onChange={(e) => setAnimate(e.target.checked)} /> animate particles{reduced ? " (reduced motion: arrows)" : ""}</label>
    </div>
    <GridStatusLine result={wind} now={clock} />
    {wStats && <p className="fine-print">{levelDef.label}: {num(wStats.min)}–{num(wStats.max)} m/s (mean {num(wStats.mean)} m/s ≈ {num(msToKnots(wStats.mean), 0)} kt) over {wStats.count} points · {levelDef.note}.{pStats ? ` MSL pressure ${num(pStats.min, 0)}–${num(pStats.max, 0)} hPa.` : ""}</p>}
    {windField && !wStats && <p className="fine-print">This model has no {levelDef.label} values here.</p>}

    <div className="panel-head"><span className="wv-label">AIR QUALITY · MODELLED HEATMAP (CAMS)</span></div>
    <button disabled={disabled || !shape || freeTierBlocked} onClick={() => run("air")}>Sample air-quality grid for this view</button>{" "}
    <label>Field <select aria-label="Air quality field" value={airVar} onChange={(e) => { if (isAirVariable(e.target.value)) setAirVar(e.target.value); }}>
      {Object.entries(AIR_VARIABLES).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}
    </select></label>{" "}
    <label><input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} /> show</label>{" "}
    <label>Opacity <input type="range" aria-label="Heatmap opacity" min="0.15" max="0.9" step="0.05" value={heatOpacity} onChange={(e) => setHeatOpacity(Number(e.target.value))} /></label>
    <GridStatusLine result={air} now={clock} />
    {aStats && <p className="fine-print">MODELLED {AIR_VARIABLES[airVar].label}: {num(aStats.min, airVar === "aerosol_optical_depth" ? 2 : 0)}–{num(aStats.max, airVar === "aerosol_optical_depth" ? 2 : 0)} {AIR_VARIABLES[airVar].units} · {AIR_VARIABLES[airVar].scaleNote}. Model output (~40 km CAMS global), not measurements.</p>}

    {times.length > 0 && <div>
      <label>Forecast hour <input type="range" aria-label="Forecast hour" min={0} max={times.length - 1} step={1} value={sliderIndex} onChange={(e) => setValidTime(times[Number(e.target.value)])} /></label>{" "}
      <span className="mono">{(times[sliderIndex] ?? "").slice(0, 13).replace("T", " ")}Z (+{Math.round((Date.parse(times[sliderIndex] ?? "") - Date.parse(times[0])) / 3600_000)} h)</span>
    </div>}

    <div className="panel-head"><span className="wv-label">MEASURED STATIONS · OPENAQ (RELAY)</span></div>
    <button disabled={disabled || !span} onClick={() => run("stations")}>Load measured stations near view centre (≤4° box)</button>
    {stations && <p className={`source-note weather-status weather-${stations.status}`}><b>{stations.status === "live" ? "LIVE" : stations.status.toUpperCase().replace("_", " ")}</b> · OpenAQ · relay · {stations.observations.length} station(s){stations.truncated ? " (first 8)" : ""}{stations.error ? ` · ${stations.error}` : ""}{stations.sourceUrl && <> · <a href={stations.sourceUrl} target="_blank" rel="noreferrer">source</a></>} · <a href={stations.termsUrl} target="_blank" rel="noreferrer">terms</a></p>}
    <p className="fine-print">Measured values appear as markers on the globe. Low-cost/community sensors are labelled generically; coverage is uneven.</p>

    <div className="panel-head"><span className="wv-label">SATELLITE AIR LAYERS · NASA GIBS</span></div>
    <label>Layer <select aria-label="Satellite air layer" value={satId} onChange={(e) => { if (isAirSatLayer(e.target.value)) { setSatId(e.target.value); setSatDate(defaultAirSatDate(AIR_SAT_LAYERS[e.target.value])); } }}>
      {Object.values(AIR_SAT_LAYERS).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
    </select></label>{" "}
    <label>Date (UTC) <input type="date" aria-label="Satellite layer date" value={satDate} min={sat.minDate} max={new Date(clock).toISOString().slice(0, 10)} onChange={(e) => { try { setSatDate(validateAirSatDate(sat, e.target.value)); } catch (err) { setSatNote(err instanceof Error ? err.message : "Invalid date"); } }} /></label>{" "}
    <label><input type="checkbox" aria-label="Drape satellite air layer" checked={satOn} disabled={!optIn} onChange={(e) => setSatOn(e.target.checked)} /> drape on globe</label>{" "}
    <label>Opacity <input type="range" aria-label="Satellite layer opacity" min="0.2" max="1" step="0.05" value={satOpacity} onChange={(e) => setSatOpacity(Number(e.target.value))} /></label>
    {satOn && <p className="source-note" role="status">{satNote}</p>}
    {satOn && <img className="windair-legend" src={sat.legendUrl} alt={`Colour legend for ${sat.label} (NASA GIBS)`} referrerPolicy="no-referrer" style={{ maxWidth: "100%", background: "#fff" }} />}
    <p className="fine-print">{sat.note} Daily composites from polar orbiters: swath gaps, cloud gaps and processing latency are normal; a blank tile means no retrieval, not clean air.</p>

    <p className="fine-print">
      Weather data by Open-Meteo.com (CC BY 4.0) · <a href="https://open-meteo.com/en/terms" target="_blank" rel="noreferrer">terms</a>. {WEATHER_MODELS[model].attribution}. Air quality: CAMS / Copernicus via Open-Meteo, modelled. OpenAQ (openaq.org) · <a href="https://docs.openaq.org/about/terms" target="_blank" rel="noreferrer">terms</a>. NASA EOSDIS GIBS / Worldview imagery. Forecasts and modelled fields are not observations; not for flight planning or certified use.
    </p>
  </section>;
}

function GridStatusLine({ result, now }: { result: GridResult | null; now: number }) {
  if (!result) return null;
  const p = result.provenance;
  const label = result.status === "live" ? "LIVE" : result.status.toUpperCase().replace("_", " ");
  return <p className={`source-note weather-status weather-${result.status}`}>
    <b>{label}</b>{p ? <> · {p.provider} · {p.route}{p.cache === "hit" ? " (cached)" : ""} · retrieved {ago(p.retrievedAt, now)} · {p.pointCount} pts · {p.modelRun ? `run ${p.modelRun.slice(0, 16)}Z` : "run time unknown"} · valid {p.validFrom?.slice(5, 13).replace("T", " ")}–{p.validTo?.slice(5, 13).replace("T", " ")}Z · {p.freshness} · <a href={p.sourceUrl} target="_blank" rel="noreferrer">source</a> · <a href={p.termsUrl} target="_blank" rel="noreferrer">terms</a></> : null}
    {result.error ? ` · ${result.error}` : ""}
  </p>;
}

export default WorldViewWindAir;
