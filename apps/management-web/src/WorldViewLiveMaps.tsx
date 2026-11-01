import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlobeBounds } from "./worldview-globe-viewport";
import { TileLoader, chooseTileZoom, tilesForBounds, type TileRecord } from "./worldview-basemap";
import {
  LIVE_LAYERS, MAX_TILES_PER_FRAME, RADAR_LAYERS, SATELLITE_LAYERS,
  clampRefreshMs, fetchFrameList, formatAge, formatLocal, formatUtc, frameAt, layerFreshness, liveFrameSource, loadOrder, mergeTimeline,
  playDelayMs, prefersReducedMotion, refreshChoices, stepIndex, summarizeLiveFeeds,
  type FrameList, type LiveChannelStatus, type LiveFeedInput, type LiveFrame, type LiveLayerId, type LiveOverlay, type LiveOverlayChannel,
} from "./worldview-livemaps";
import "./worldview-livemaps.css";

type Props = Readonly<{
  active?: boolean;
  bounds: readonly GlobeBounds[];
  center: Readonly<{ lat: number; lon: number }>;
  zoom: number;
  onOverlay: (overlay: LiveOverlay | null) => void;
  /** Existing WorldView provider state, read only, for the "Live data" strip. */
  feeds?: LiveFeedInput;
}>;
type FrameTiles = { loaded: TileRecord<ImageBitmap>[]; failed: number; expected: number; firstError?: string };
type ChannelState = {
  list: FrameList | null;
  error: string;
  stale: boolean;
  tiles: ReadonlyMap<string, FrameTiles>;
  lastFetchAt: number;
  loading: boolean;
};
const MANUAL_MIN_MS = 60_000;
const RETRY_AFTER_THROTTLE_MS = 20_000;
const noop = () => {};
const decodeImage = (blob: Blob) => createImageBitmap(blob);
const emptyChannel = (): ChannelState => ({ list: null, error: "", stale: false, tiles: new Map(), lastFetchAt: 0, loading: false });
const isReady = (t: FrameTiles | undefined) => !!t && t.loaded.length > 0 && t.loaded.length + t.failed >= t.expected;

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden === true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setHidden(document.hidden === true);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Frame list + per-frame tile loading for one channel (radar or satellite). */
function useLiveChannel(layerId: LiveLayerId | "", opts: { network: boolean; autoRefresh: boolean; refreshMultiplier: number; hidden: boolean; bounds: readonly GlobeBounds[]; center: { lat: number; lon: number }; zoom: number }) {
  const [state, setState] = useState<ChannelState>(emptyChannel);
  const [retryTick, setRetryTick] = useState(0);
  const [manualTick, setManualTick] = useState(0);
  const layer = layerId ? LIVE_LAYERS[layerId] : null;
  const loader = useMemo(() => (layer ? new TileLoader<ImageBitmap>({ network: opts.network, decode: decodeImage, cacheEntries: 224, onEvict: (_key, record) => record.data.close?.() }) : null), [layerId, opts.network]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastFetch = useRef(0);
  const handledManual = useRef(0);
  const refreshMs = layer ? clampRefreshMs(layer, layer.cadenceMs * opts.refreshMultiplier) : 0;

  useEffect(() => () => { loader?.cache.clear(); }, [loader]);

  // Reset when the layer or permission changes.
  useEffect(() => { setState(emptyChannel()); lastFetch.current = 0; }, [layerId, opts.network]);

  // Frame list: once on enable, then (optionally) on the provider's cadence; paused while the tab is hidden.
  useEffect(() => {
    if (!layer || !opts.network || opts.hidden) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      lastFetch.current = Date.now();
      setState((s) => ({ ...s, loading: true }));
      try {
        const list = await fetchFrameList(layer.id, { network: true, signal: controller.signal });
        if (cancelled) return;
        setState((s) => ({ ...s, list, error: "", stale: false, lastFetchAt: lastFetch.current, loading: false }));
      } catch (e) {
        if (cancelled) return;
        setState((s) => ({ ...s, error: `${e instanceof Error ? e.message : "Frame list request failed"}${s.list ? "; keeping the previous frames (stale)" : ""}`, stale: !!s.list, lastFetchAt: lastFetch.current, loading: false }));
      }
      schedule();
    };
    const schedule = () => {
      if (cancelled || !opts.autoRefresh) return;
      timer = setTimeout(run, Math.max(0, lastFetch.current + refreshMs - Date.now()));
    };
    const due = !lastFetch.current || (opts.autoRefresh && Date.now() - lastFetch.current >= refreshMs);
    const manual = manualTick !== handledManual.current && Date.now() - lastFetch.current >= MANUAL_MIN_MS;
    handledManual.current = manualTick;
    if (due || manual) void run();
    else schedule();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [layerId, opts.network, opts.hidden, opts.autoRefresh, refreshMs, manualTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tiles for the visible viewport, newest frame first; throttled tiles retry later rather than hammering.
  const tileZoom = layer ? chooseTileZoom(opts.zoom, layer.maxZoom) : 0;
  const boundsKey = JSON.stringify(opts.bounds.map((b) => [b.west, b.south, b.east, b.north].map((v) => Math.round(v * 10) / 10)));
  const centerKey = `${Math.round(opts.center.lat)}:${Math.round(opts.center.lon)}`;
  useEffect(() => {
    if (!layer || !loader || !opts.network || opts.hidden || !state.list?.frames.length) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const tiles = tilesForBounds(opts.bounds, tileZoom, opts.center, MAX_TILES_PER_FRAME);
      if (!tiles.length) return;
      const out = new Map<string, FrameTiles>();
      const frameIds = new Set(state.list!.frames.map((f) => f.id));
      for (const frame of loadOrder(state.list!.frames)) {
        if (controller.signal.aborted) return;
        const res = await loader.load(liveFrameSource(layer.id, frame), tiles, controller.signal);
        if (controller.signal.aborted) return;
        out.set(frame.id, { loaded: res.loaded, failed: res.failed.length, expected: tiles.length, firstError: res.failed[0]?.error });
        setState((s) => {
          const merged = new Map([...s.tiles].filter(([id]) => frameIds.has(id)));
          out.forEach((v, k) => merged.set(k, v));
          return { ...s, tiles: merged };
        });
        if (res.throttled > 0) { setTimeout(() => setRetryTick((n) => n + 1), RETRY_AFTER_THROTTLE_MS); return; }
      }
    }, 600);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [layerId, loader, opts.network, opts.hidden, state.list, boundsKey, centerKey, tileZoom, retryTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefer complete frames: GIBS answers 404 for tiles of its newest frame until ingest finishes, so a
  // partial frame only joins the loop when no complete frame exists (it is retried on the next refresh).
  const loadedFrames: LiveFrame[] = (state.list?.frames ?? []).filter((f) => isReady(state.tiles.get(f.id)));
  const completeFrames = loadedFrames.filter((f) => state.tiles.get(f.id)!.failed === 0);
  const readyFrames = completeFrames.length ? completeFrames : loadedFrames;
  const refreshNow = useCallback(() => setManualTick((n) => n + 1), []);
  const status: LiveChannelStatus | null = layer && opts.network ? {
    layerId: layer.id, latestFrameMs: state.list?.frames.length ? state.list.frames[state.list.frames.length - 1].timeMs : null,
    retrievedAt: state.list?.retrievedAt, error: state.error || undefined, stale: state.stale, framesReady: readyFrames.length, framesTotal: state.list?.frames.length ?? 0,
  } : null;
  return { layer, state, readyFrames, refreshNow, refreshMs, status, manualAllowedAt: state.lastFetchAt + MANUAL_MIN_MS };
}

export default function WorldViewLiveMaps(props: Props = { active: false, bounds: [], center: { lat: 0, lon: 0 }, zoom: 1, onOverlay: noop }) {
  const [network, setNetwork] = useState(false);
  const [rvAck, setRvAck] = useState(false);
  const [radarId, setRadarId] = useState<LiveLayerId | "">("");
  const [satId, setSatId] = useState<LiveLayerId | "">("");
  const [radarOpacity, setRadarOpacity] = useState(0.75);
  const [satOpacity, setSatOpacity] = useState(0.85);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [multiplier, setMultiplier] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(-1); // -1 = follow newest frame
  const [clock, setClock] = useState(() => Date.now());
  const hidden = usePageHidden() || props.active !== true;
  const reduced = useReducedMotion();
  const onOverlay = props.onOverlay;

  const radarBlocked = radarId === "rainviewer-radar" && !rvAck;
  const common = { network, autoRefresh, refreshMultiplier: multiplier, hidden, bounds: props.bounds, center: props.center, zoom: props.zoom };
  const radar = useLiveChannel(radarBlocked ? "" : radarId, common);
  const sat = useLiveChannel(satId, common);

  useEffect(() => {
    if (hidden) return;
    setClock(Date.now());
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hidden]);

  const timeline = useMemo(() => mergeTimeline([radar.readyFrames, sat.readyFrames]), [radar.readyFrames, sat.readyFrames]);
  const index = timeline.length ? (cursor < 0 || cursor >= timeline.length ? timeline.length - 1 : cursor) : -1;
  const cursorMs = index >= 0 ? timeline[index] : NaN;

  // Playback loop; pauses while the tab is hidden. Reduced motion: no autoplay, slower steps when the user presses play.
  useEffect(() => {
    if (!playing || hidden || timeline.length < 2) return;
    const t = setTimeout(() => setCursor(stepIndex(index, timeline.length, 1)), playDelayMs(index, timeline.length, reduced));
    return () => clearTimeout(t);
  }, [playing, hidden, index, timeline.length, reduced]);
  useEffect(() => { if (timeline.length < 2) setPlaying(false); }, [timeline.length]);

  // Globe hand-off.
  const channelFor = (ch: ReturnType<typeof useLiveChannel>, channel: LiveOverlayChannel["channel"], opacity: number): LiveOverlayChannel | null => {
    if (!ch.layer || !Number.isFinite(cursorMs)) return null;
    const frame = frameAt(ch.readyFrames, cursorMs);
    if (!frame) return null;
    const t = ch.state.tiles.get(frame.id);
    if (!t) return null;
    return {
      channel, layerId: ch.layer.id, frameKey: `${ch.layer.id}@${frame.id}`, frameTime: frame.time, opacity,
      tiles: t.loaded.map((r) => ({ key: r.key, tile: r.tile, image: r.data })),
      credit: { text: ch.layer.attribution, termsUrl: ch.layer.termsUrl },
      freshness: layerFreshness(ch.layer, ch.status?.latestFrameMs, clock).status,
    };
  };
  const satChannel = channelFor(sat, "satellite", satOpacity);
  const radarChannel = channelFor(radar, "radar", radarOpacity);
  const overlayKey = [satChannel, radarChannel].map((c) => (c ? `${c.frameKey}:${c.opacity}:${c.tiles.length}:${c.freshness}` : "-")).join("|");
  useEffect(() => {
    const channels = [satChannel, radarChannel].filter((c): c is LiveOverlayChannel => !!c);
    onOverlay(network && !hidden && channels.length ? { channels } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayKey, network, hidden, onOverlay]);
  useEffect(() => () => onOverlay(null), [onOverlay]);

  const liveChannels = [radar.status, sat.status].filter((s): s is LiveChannelStatus => !!s);
  const rows = summarizeLiveFeeds({ ...(props.feeds ?? {}), liveChannels }, clock);
  const anyLayer = !!(radarId || satId);

  const channelStatus = (ch: ReturnType<typeof useLiveChannel>, title: string) => {
    if (!ch.layer) return null;
    const latest = ch.status?.latestFrameMs ?? null;
    const freshness = layerFreshness(ch.layer, latest, clock);
    const f = ch.state.stale ? { ...freshness, status: "stale" as const } : freshness;
    const shown = Number.isFinite(cursorMs) ? frameAt(ch.readyFrames, cursorMs) : null;
    const failedTiles = [...ch.state.tiles.values()].reduce((n, t) => n + t.failed, 0);
    const firstErr = [...ch.state.tiles.values()].find((t) => t.firstError)?.firstError;
    return <li className={`livemaps-status livemaps-${f.status}`}>
      <b>{title}: <span className={`livemaps-badge livemaps-badge-${f.status}`}>{f.status.toUpperCase()}</span></b> {ch.layer.label}
      {" · "}newest frame {latest != null ? `${formatUtc(latest)} (${formatLocal(latest)}) · ${formatAge(f.ageMs)} old` : ch.state.loading ? "loading…" : "none"}
      {" · "}{ch.status?.framesReady ?? 0}/{ch.status?.framesTotal ?? 0} frames loaded
      {shown ? ` · showing ${formatUtc(shown.timeMs)}${shown.kind === "nowcast" ? " (NOWCAST: forecast, not observed)" : ""}` : ""}
      {ch.state.lastFetchAt ? ` · frame list retrieved ${new Date(ch.state.lastFetchAt).toISOString()}` : ""}
      {ch.state.list ? <> · <a href={ch.state.list.sourceUrl} target="_blank" rel="noreferrer noopener">frame list source</a></> : null}
      {autoRefresh ? ` · auto-refresh every ${Math.round(ch.refreshMs / 60_000)} min${hidden ? " (paused: tab hidden)" : ""}` : " · auto-refresh off"}
      {failedTiles ? ` · ${failedTiles} tile(s) failed${firstErr ? ` (${firstErr})` : ""}; gaps show the layer beneath` : ""}
      {ch.state.error ? <><br /><span className="livemaps-warning">{ch.state.error}</span></> : null}
      <br /><small>{ch.layer.timeNote} {ch.layer.coverageNote} Terms: <a href={ch.layer.termsUrl} target="_blank" rel="noreferrer noopener">{ch.layer.licenseNote}</a>.</small>
    </li>;
  };

  return <section className="wv-livemaps" aria-label="Live animated map layers and live data summary">
    <div className="wv-live-strip" role="status" aria-live="off" aria-label="Live data summary">
      <b>LIVE DATA</b>
      {rows.length ? rows.map((r) => <span key={r.id} className={`live-chip live-chip-${r.status}`} title={r.detail}>
        {r.label} · {r.status.toUpperCase()}{r.ageMs != null ? ` · ${formatAge(r.ageMs)}` : ""}
      </span>) : <span className="live-chip live-chip-none">No live layers or feeds active; everything shown is synthetic, imported or offline.</span>}
    </div>
    <details className="wv-livemaps-panel">
      <summary>Live maps: animated precipitation radar & geostationary satellite loops</summary>
      <p>Read-only, opt-in. Frame lists and visible tiles only (≤{MAX_TILES_PER_FRAME} tiles per frame, ≤12 frames over ~2 h, per-provider rate limits, bounded in-memory cache). Auto-refresh never runs faster than the provider updates, and everything pauses when the tab or globe is hidden. Not an aviation, marine or warning product.</p>
      <label className="livemaps-opt-in"><input type="checkbox" checked={network} disabled={!props.active} onChange={(e) => { setNetwork(e.target.checked); setPlaying(false); setCursor(-1); }} /> Allow requests to RainViewer, the Iowa Environmental Mesonet and NASA GIBS for the selected layers</label>
      <div className="livemaps-controls">
        <label>Radar <select aria-label="Radar layer" value={radarId} onChange={(e) => { setRadarId(e.target.value as LiveLayerId | ""); setCursor(-1); }}>
          <option value="">Off</option>
          {RADAR_LAYERS.map((id) => <option key={id} value={id}>{LIVE_LAYERS[id].label}</option>)}
        </select></label>
        <label>Opacity <input type="range" min={0.2} max={1} step={0.05} value={radarOpacity} aria-label="Radar opacity" onChange={(e) => setRadarOpacity(Number(e.target.value))} /></label>
      </div>
      {radarId === "rainviewer-radar" && <label className={rvAck ? "livemaps-note" : "livemaps-warning"}><input type="checkbox" checked={rvAck} onChange={(e) => setRvAck(e.target.checked)} /> RainViewer's free API is for personal or educational use only (commercial use needs an agreement with RainViewer). I confirm this use qualifies.</label>}
      <div className="livemaps-controls">
        <label>Satellite <select aria-label="Satellite layer" value={satId} onChange={(e) => { setSatId(e.target.value as LiveLayerId | ""); setCursor(-1); }}>
          <option value="">Off</option>
          {SATELLITE_LAYERS.map((id) => <option key={id} value={id}>{LIVE_LAYERS[id].label}</option>)}
        </select></label>
        <label>Opacity <input type="range" min={0.2} max={1} step={0.05} value={satOpacity} aria-label="Satellite opacity" onChange={(e) => setSatOpacity(Number(e.target.value))} /></label>
      </div>
      <div className="livemaps-controls">
        <label><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto-refresh frame lists</label>
        <label>Every <select aria-label="Auto-refresh interval" value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))}>
          {[1, 2, 3].map((k) => <option key={k} value={k}>{k === 1 ? "provider update interval" : `${k}× provider interval`}{radar.layer || sat.layer ? ` (${[radar.layer, sat.layer].filter(Boolean).map((l) => `${Math.round(refreshChoices(l!)[k - 1] / 60_000)} min`).join(" / ")})` : ""}</option>)}
        </select></label>
        <button disabled={!network || !props.active || !anyLayer || (Date.now() < Math.max(radar.layer ? radar.manualAllowedAt : 0, sat.layer ? sat.manualAllowedAt : 0))} onClick={() => { radar.refreshNow(); sat.refreshNow(); }}>Refresh frame lists now</button>
      </div>
      <div className="livemaps-player" role="group" aria-label="Loop playback">
        <button aria-label="Previous frame" disabled={timeline.length < 2} onClick={() => { setPlaying(false); setCursor(stepIndex(index, timeline.length, -1)); }}>◀</button>
        <button aria-pressed={playing} disabled={timeline.length < 2} onClick={() => setPlaying(!playing)}>{playing ? "Pause loop" : "Play loop"}</button>
        <button aria-label="Next frame" disabled={timeline.length < 2} onClick={() => { setPlaying(false); setCursor(stepIndex(index, timeline.length, 1)); }}>▶</button>
        <button disabled={!timeline.length} onClick={() => { setPlaying(false); setCursor(-1); }}>Latest</button>
        <input type="range" min={0} max={Math.max(0, timeline.length - 1)} step={1} value={Math.max(0, index)} disabled={timeline.length < 2}
          aria-label="Frame time" aria-valuetext={Number.isFinite(cursorMs) ? formatUtc(cursorMs) : "no frames"}
          onChange={(e) => { setPlaying(false); const v = Number(e.target.value); setCursor(v >= timeline.length - 1 ? -1 : v); }} />
        <output className="livemaps-time">{Number.isFinite(cursorMs) ? <><b>{formatUtc(cursorMs)}</b> · {formatLocal(cursorMs)} local · frame {index + 1}/{timeline.length}</> : "No frames loaded"}</output>
      </div>
      {reduced && <p className="livemaps-note">Reduced motion is on: the loop does not auto-play and steps slowly if you press play. The newest frame is shown by default.</p>}
      {hidden && <p className="livemaps-note">{props.active ? "Tab hidden" : "Globe not visible"}: playback, refresh, overlays and tile loading are paused.</p>}
      {!network && <p role="status">Live map requests are off. Nothing has been requested.</p>}
      {network && !anyLayer && <p role="status">Network allowed, but no radar or satellite layer is selected. Nothing requested.</p>}
      {network && radarBlocked && <p className="livemaps-warning">RainViewer is selected but its personal/educational-use condition has not been confirmed; no RainViewer request was made.</p>}
      <ul className="livemaps-statuses">{channelStatus(radar, "Radar")}{channelStatus(sat, "Satellite")}</ul>
      <p className="livemaps-note">No Meteosat layer: NASA GIBS does not publish Meteosat (EUMETSAT) imagery, so Europe/Africa geostationary loops are not available here. RainViewer nowcast and satellite-IR products were discontinued by RainViewer on 2026-01-01.</p>
    </details>
  </section>;
}
