import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobeBounds } from "./worldview-globe-viewport";
import {
  BASEMAP_PROVIDERS,
  DEFAULT_OSM_TEMPLATE,
  TERRAIN_SOURCE,
  TileLoader,
  chooseTileZoom,
  defaultGibsDate,
  fetchGoogleCopyright,
  fetchRelayStatus,
  formatAge,
  hillshade,
  imagerySource,
  isOsmFoundationTemplate,
  metersPerPixel,
  readElevation,
  terrainSource,
  tileBounds,
  tilesForBounds,
  utcDate,
  validateGibsDate,
  validateTileTemplate,
  decodeTerrarium,
  type BasemapProviderId,
  type ElevationGrid,
  type ElevationReading,
  type GlobeBasemap,
  type GlobeBasemapTile,
  type RelayStatus,
  type TileRecord,
} from "./worldview-basemap";
import "./worldview-basemap.css";

type Props = Readonly<{
  active: boolean;
  bounds: readonly GlobeBounds[];
  center: Readonly<{ lat: number; lon: number }>;
  zoom: number;
  onBasemap: (basemap: GlobeBasemap | null) => void;
}>;
type Choice = "" | BasemapProviderId;
type Summary = { at: string; loaded: number; failed: number; throttled: number; fromCache: number; firstError?: string; providerTime?: string; freshness?: string; ageMs?: number | null };

const pixelsOf = async (blob: Blob): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> => {
  // Raw values matter for Terrarium decoding: no premultiply / colour conversion.
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const width = bitmap.width, height = bitmap.height;
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("2D canvas unavailable for terrain decoding");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
};
const decodeImage = (blob: Blob) => createImageBitmap(blob);
const decodeTerrain = async (blob: Blob): Promise<ElevationGrid> => {
  const px = await pixelsOf(blob);
  return { width: px.width, height: px.height, heights: decodeTerrarium(px.rgba, px.width, px.height) };
};
const noop = () => {};
const IMAGERY_ORDER: BasemapProviderId[] = ["gibs-viirs-truecolor", "gibs-modis-terra-truecolor", "gibs-viirs-dnb", "gibs-black-marble", "gibs-modis-lst-day", "osm-standard", "esri-world-imagery", "google-2d-satellite"];

export default function WorldViewBasemap(props: Props = { active: true, bounds: [], center: { lat: 0, lon: 0 }, zoom: 1, onBasemap: noop }) {
  const [network, setNetwork] = useState(false);
  const [choice, setChoice] = useState<Choice>("");
  const [date, setDate] = useState(() => defaultGibsDate());
  const [templateDraft, setTemplateDraft] = useState(DEFAULT_OSM_TEMPLATE);
  const [template, setTemplate] = useState(DEFAULT_OSM_TEMPLATE);
  const [shade, setShade] = useState(false);
  const [relief, setRelief] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [terrainSummary, setTerrainSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState("Schematic globe only. No imagery, basemap or terrain requests have been made.");
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [elevLat, setElevLat] = useState("");
  const [elevLon, setElevLon] = useState("");
  const [reading, setReading] = useState<ElevationReading | null>(null);
  const [readingError, setReadingError] = useState("");
  const imageryLoader = useRef<TileLoader<ImageBitmap> | null>(null);
  const terrainLoader = useRef<TileLoader<ElevationGrid> | null>(null);
  const elevationAbort = useRef<AbortController | null>(null);
  const shadeMemo = useRef(new WeakMap<object, Uint8ClampedArray>());
  const generation = useRef(0);
  const onBasemap = props.onBasemap;
  const provider = choice ? BASEMAP_PROVIDERS[choice] : null;
  const networkAllowed = network && props.active;

  // Recreated (and the bounded caches dropped) whenever the network permission changes.
  useMemo(() => {
    imageryLoader.current = new TileLoader<ImageBitmap>({ network: networkAllowed, decode: decodeImage, cacheEntries: 128 });
    terrainLoader.current = new TileLoader<ElevationGrid>({ network: networkAllowed, decode: decodeTerrain, cacheEntries: 96 });
  }, [network, props.active]);

  const dateError = useMemo(() => {
    if (!provider || provider.kind !== "gibs") return "";
    try { validateGibsDate(provider, date); return ""; } catch (e) { return e instanceof Error ? e.message : "invalid date"; }
  }, [provider, date]);
  const relayBlocked = provider?.kind === "relay" && (!relay || relay.providers[provider.relay === "esri" ? "esri" : "google2d"]?.status !== "configured");
  const terrainOn = shade || relief > 0;
  const tileZoom = chooseTileZoom(props.zoom, provider ? provider.maxZoom : TERRAIN_SOURCE.maxZoom);
  const boundsKey = JSON.stringify(props.bounds.map((b) => [b.west, b.south, b.east, b.north].map((v) => Math.round(v * 10) / 10)));
  const centerKey = `${Math.round(props.center.lat)}:${Math.round(props.center.lon)}`;

  // Keyed providers: check the server relay status when one is selected (no key ever reaches the browser).
  useEffect(() => {
    if (!networkAllowed || provider?.kind !== "relay") return;
    let live = true;
    const controller = new AbortController();
    fetchRelayStatus({ network: true, signal: controller.signal }).then((s) => { if (live) setRelay(s); }).catch(() => {});
    return () => { live = false; controller.abort(); };
  }, [networkAllowed, provider?.kind]);

  useEffect(() => {
    const gen = ++generation.current;
    const imageryOn = !!provider && !dateError && !relayBlocked;
    if (!networkAllowed || (!imageryOn && !terrainOn)) {
      onBasemap(null);
      setSummary(null); setTerrainSummary(null);
      setMessage(!props.active ? "Globe is not visible; provider requests are paused and imagery is cleared." : !network ? "Provider requests are off. The schematic globe is the offline default." : provider && relayBlocked ? `Keyed provider is unavailable on the server relay (${relay?.providers[provider.relay === "esri" ? "esri" : "google2d"]?.status ?? "unknown"}); no tiles requested.` : dateError ? `Date rejected: ${dateError}` : "Network allowed, but no imagery or terrain layer is selected. Nothing requested.");
      return;
    }
    const credits: { provider: string; text: string; termsUrl: string }[] = [];
    if (imageryOn && provider) credits.push({ provider: provider.id, text: provider.id === "google-2d-satellite" ? "Google Maps · viewport copyright pending" : provider.attribution, termsUrl: provider.termsUrl });
    if (terrainOn) credits.push({ provider: TERRAIN_SOURCE.id, text: "Terrain: Mapzen / AWS Terrain Tiles; USGS (3DEP, SRTM, GMTED2010), NOAA ETOPO1 and others", termsUrl: TERRAIN_SOURCE.termsUrl });
    let source;
    try { source = imageryOn && provider ? imagerySource(provider.id, { date, template }) : null; }
    catch (e) { setMessage(`Layer rejected: ${e instanceof Error ? e.message : "invalid"}`); onBasemap(null); return; }
    const sourceId = `${source?.sourceId ?? "none"}|${terrainOn ? "terrain" : ""}`;
    onBasemap({ sourceId, tiles: [], reliefExaggeration: relief, credits, note: "Loading visible tiles…" });
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const tiles = tilesForBounds(props.bounds, tileZoom, props.center);
      if (!tiles.length) { setMessage("No visible viewport reported yet; nothing requested."); return; }
      let resolvedCredits = credits;
      if (provider?.id === "google-2d-satellite") {
        try {
          const copyrights = await Promise.all(props.bounds.slice(0, 2).map((bound) => fetchGoogleCopyright(bound, tileZoom, { network: true, signal: controller.signal })));
          const copyright = [...new Set(copyrights.map((text) => text.trim()).filter(Boolean))].join(" · ");
          if (!copyright || copyrights.some((text) => !text.trim())) throw new Error("Provider returned no viewport copyright for one or more visible bounds");
          resolvedCredits = credits.map((credit) => credit.provider === provider.id ? { ...credit, text: `Google Maps · ${copyright}` } : credit);
        } catch (e) {
          if (controller.signal.aborted || gen !== generation.current) return;
          setSummary(null);
          setMessage(`Google viewport attribution unavailable; no Google tiles displayed (${e instanceof Error ? e.message : "request failed"}).`);
          onBasemap(null);
          return;
        }
      }
      setMessage(`Requesting up to ${tiles.length} visible tiles at zoom ${tileZoom}…`);
      const [img, ter] = await Promise.all([
        source ? imageryLoader.current!.load(source, tiles, controller.signal) : Promise.resolve(null),
        terrainOn ? terrainLoader.current!.load(terrainSource(), tiles, controller.signal) : Promise.resolve(null),
      ]);
      if (gen !== generation.current || controller.signal.aborted) return;
      const byKey = new Map<string, { tile: GlobeBasemapTile["tile"]; image?: ImageBitmap; rec?: TileRecord<ElevationGrid> }>();
      img?.loaded.forEach((r) => byKey.set(r.key, { tile: r.tile, image: r.data }));
      ter?.loaded.forEach((r) => byKey.set(r.key, { ...(byKey.get(r.key) ?? { tile: r.tile }), rec: r }));
      const out: GlobeBasemapTile[] = [];
      for (const [key, v] of byKey) {
        let shadeData: Uint8ClampedArray | undefined;
        if (shade && v.rec) {
          shadeData = shadeMemo.current.get(v.rec);
          if (!shadeData) {
            const b = tileBounds(v.tile);
            const g = v.rec.data;
            shadeData = hillshade(g.heights, g.width, g.height, metersPerPixel((b.north + b.south) / 2, v.tile.z, g.width), 40);
            shadeMemo.current.set(v.rec, shadeData);
          }
        }
        out.push({ key, tile: v.tile, image: v.image, shade: shadeData, heights: relief > 0 ? v.rec?.data : undefined });
      }
      const summarize = (r: typeof img): Summary | null => r && ({
        at: new Date().toISOString(), loaded: r.loaded.length, failed: r.failed.length, throttled: r.throttled, fromCache: r.fromCache,
        firstError: r.failed[0]?.error, providerTime: r.loaded[0]?.providerTime, freshness: r.loaded[0]?.freshness, ageMs: r.loaded[0]?.ageMs,
      });
      setSummary(summarize(img)); setTerrainSummary(summarize(ter as any));
      const failed = (img?.failed.length ?? 0) + (ter?.failed.length ?? 0), throttled = (img?.throttled ?? 0) + (ter?.throttled ?? 0);
      setMessage(failed || throttled ? `Loaded ${out.length} tiles; ${failed} failed, ${throttled} throttled. Failed tiles show the schematic globe beneath.` : `Loaded ${out.length} visible tiles.`);
      onBasemap({ sourceId, tiles: out, reliefExaggeration: relief, credits: resolvedCredits, note: failed ? `${failed} tile(s) failed` : undefined });
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, props.active, choice, date, template, shade, relief, boundsKey, centerKey, tileZoom, dateError, relayBlocked, onBasemap]);

  useEffect(() => {
    if (!props.active) {
      elevationAbort.current?.abort();
      elevationAbort.current = null;
      setReading(null);
      setReadingError("");
    }
    return () => {
      elevationAbort.current?.abort();
      imageryLoader.current?.cache.clear();
      terrainLoader.current?.cache.clear();
      onBasemap(null);
    };
  }, [props.active, onBasemap]);

  const applyTemplate = () => {
    try { setTemplate(validateTileTemplate(templateDraft)); setMessage("Tile URL template applied."); }
    catch (e) { setMessage(`Tile URL template rejected: ${e instanceof Error ? e.message : "invalid"}`); }
  };
  const readPoint = async () => {
    if (!networkAllowed) return;
    setReadingError("");
    const lat = elevLat.trim() === "" ? props.center.lat : Number(elevLat), lon = elevLon.trim() === "" ? props.center.lon : Number(elevLon);
    elevationAbort.current?.abort();
    const controller = new AbortController();
    elevationAbort.current = controller;
    try { setReading(await readElevation(lat, lon, { network: networkAllowed, signal: controller.signal, decodePixels: pixelsOf })); }
    catch (e) { setReading(null); setReadingError(e instanceof Error ? e.message : "Elevation read failed"); }
    finally { if (elevationAbort.current === controller) elevationAbort.current = null; }
  };
  const today = utcDate(Date.now());
  const statusLine = (label: string, s: Summary | null) => s && <li><b>{label}</b>: {s.loaded} tiles ({s.fromCache} from cache), {s.failed} failed, {s.throttled} throttled · retrieved {s.at}{s.providerTime ? ` · provider time ${s.providerTime}` : ""} · freshness <b>{(s.freshness ?? "unknown").toUpperCase()}</b>{s.ageMs != null ? ` (${formatAge(s.ageMs)} old)` : ""}{s.firstError ? ` · first error: ${s.firstError}` : ""}</li>;

  return <section className="wv-basemap" aria-label="Imagery, basemaps and terrain">
    <h2><small>LIVE PROVIDER LAYERS · READ-ONLY · OPT-IN</small>Imagery, basemaps & terrain</h2>
    <p>The original schematic globe stays the default and offline fallback. Layers below are fetched lazily for the visible viewport only (≤48 tiles per view, ≤2 MiB per tile, rate-limited). Eligible public sources use a bounded in-memory cache; keyed Esri/Google tiles and relay metadata use no-store and bypass the tile cache. Provider credit stays visible on the globe while a layer is enabled. Keys for Esri and Google live only on the server relay.</p>
    <label className="basemap-opt-in"><input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /> Allow tile requests to the selected providers (NASA GIBS, AWS Terrain Tiles, OpenStreetMap tile server, or the local keyed-provider relay)</label>
    {!props.active && <p role="status" className="basemap-warning">Globe is not visible. Public imagery/tile requests are paused until it is open and visible.</p>}
    <div className="basemap-controls">
      <label>Imagery / basemap <select aria-label="Imagery or basemap layer" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
        <option value="">Schematic globe only (offline default)</option>
        {IMAGERY_ORDER.map((id) => <option key={id} value={id}>{BASEMAP_PROVIDERS[id].label}</option>)}
      </select></label>
      {provider?.kind === "gibs" && !provider.fixedDate && <label>Imagery date (UTC) <input type="date" aria-label="GIBS imagery date" value={date} min={provider.minDate} max={today} onChange={(e) => setDate(e.target.value)} /></label>}
      {provider?.fixedDate && <span>Fixed composite date {provider.fixedDate}</span>}
    </div>
    {provider?.kind === "xyz" && <div className="basemap-controls">
      <label>XYZ tile URL template <input aria-label="Tile URL template" value={templateDraft} onChange={(e) => setTemplateDraft(e.target.value)} size={48} /></label>
      <button onClick={applyTemplate}>Apply template</button>
      <p className="basemap-note">HTTPS, no query string or credentials. {isOsmFoundationTemplate(template) ? "Using the OpenStreetMap Foundation tile server: light interactive use only under its tile usage policy (visible tiles, ≤2 parallel requests, no bulk download or prefetch; your browser sends its own User-Agent and this page's Referer). For heavier use configure your own or a commercial tile server." : "Custom tile server: you are responsible for its terms and attribution."}</p>
    </div>}
    {provider?.kind === "relay" && <p className={relayBlocked ? "basemap-warning" : ""}>
      <b>{provider.label}</b>: requires <code>{provider.envVar}</code> on the management API and <code>UCAS_PUBLIC_BASEMAP_RELAY_ENABLED=1</code>. Status: <b>{relay ? (relay.providers[provider.relay === "esri" ? "esri" : "google2d"]?.status ?? "unknown").toUpperCase() : network ? "CHECKING…" : "NOT CHECKED (requests off)"}</b>{relay ? ` · ${relay.providers[provider.relay === "esri" ? "esri" : "google2d"]?.detail ?? ""}` : ""}
      {provider.relay === "google" ? " Photorealistic 3D Tiles are not rendered: this Three.js globe has no 3D Tiles renderer, so Google support is scoped to 2D Map Tiles." : ""}
    </p>}
    {provider && <p className="basemap-note">{provider.coverageNote} Terms: <a href={provider.termsUrl} target="_blank" rel="noreferrer noopener">{provider.licenseNote}</a>.</p>}
    <fieldset className="basemap-controls">
      <legend>Terrain · {TERRAIN_SOURCE.label}</legend>
      <label><input type="checkbox" checked={shade} onChange={(e) => setShade(e.target.checked)} /> Hillshade overlay</label>
      <label>Relief exaggeration <input type="range" min={0} max={80} step={10} value={relief} aria-label="Relief exaggeration" onChange={(e) => setRelief(Number(e.target.value))} /> {relief ? `${relief}×` : "off"}</label>
    </fieldset>
    <p className="basemap-note">{TERRAIN_SOURCE.coverageNote}</p>
    <div className="basemap-controls">
      <label>Lat <input aria-label="Elevation latitude" placeholder={props.center.lat.toFixed(4)} value={elevLat} onChange={(e) => setElevLat(e.target.value)} size={9} /></label>
      <label>Lon <input aria-label="Elevation longitude" placeholder={props.center.lon.toFixed(4)} value={elevLon} onChange={(e) => setElevLon(e.target.value)} size={9} /></label>
      <button disabled={!networkAllowed} onClick={() => void readPoint()}>Read terrain elevation (blank = view centre)</button>
    </div>
    {reading && <p role="status" className="basemap-reading"><b>LIVE READ · {reading.meters.toFixed(1)} m</b> at {reading.lat.toFixed(4)}, {reading.lon.toFixed(4)} · {reading.note} · retrieved {reading.retrievedAt}{reading.providerTime ? ` · tile last modified ${reading.providerTime}` : ""} · freshness STATIC DATASET · <a href={reading.sourceUrl} target="_blank" rel="noreferrer noopener">source tile</a> · <a href={reading.termsUrl} target="_blank" rel="noreferrer noopener">{reading.licenseNote}</a></p>}
    {readingError && <p className="basemap-warning">Elevation read failed: {readingError}. No value was estimated.</p>}
    <p role="status">{message}</p>
    {(summary || terrainSummary) && <ul className="basemap-status">{statusLine("Imagery", summary)}{statusLine("Terrain", terrainSummary)}</ul>}
    {summary?.freshness === "historical" || summary?.freshness === "stale" ? <p className="basemap-warning">Selected imagery is not current ({summary.freshness}). It shows conditions on its provider date, not now.</p> : null}
  </section>;
}
