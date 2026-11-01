import { useEffect, useMemo, useRef, useState } from "react";
import type { GlobeBounds } from "./worldview-globe-viewport";
import {
  DEFAULT_MIN_AIRCRAFT, GPSJAM_DISCLOSURE, GPSJAM_FAQ_URL, GPSJAM_LEVELS, GPSJAM_SITE_URL, GPSJAM_TERMS_NOTE, MAX_DRAWN_CELLS,
  GpsJamClient, buildGlobeState, dayFreshness, describeError, formatAge, selectCells,
  type GpsJamGlobeState, type GpsJamManifest, type PreparedDay,
} from "./worldview-gpsjam";
import "./worldview-gpsjam.css";

type Props = Readonly<{
  bounds: readonly GlobeBounds[];
  onOverlay: (state: GpsJamGlobeState | null) => void;
  /** Tests inject a fetcher; production uses window.fetch against the same-origin relay. */
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}>;
const MANUAL_REFRESH_MS = 5 * 60_000;
const noop = () => {};
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export default function WorldViewGpsJam(props: Props = { bounds: [], onOverlay: noop }) {
  const [network, setNetwork] = useState(false);
  const [manifest, setManifest] = useState<GpsJamManifest | null>(null);
  const [date, setDate] = useState("");
  const [prepared, setPrepared] = useState<PreparedDay | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");
  const [showLow, setShowLow] = useState(true);
  const [minAircraft, setMinAircraft] = useState(DEFAULT_MIN_AIRCRAFT);
  const [opacity, setOpacity] = useState(0.55);
  const [manifestTick, setManifestTick] = useState(0);
  const [freshnessNow, setFreshnessNow] = useState(() => (props.now ?? Date.now)());
  const lastManual = useRef(0);
  const now = props.now ?? Date.now;
  const client = useMemo(() => new GpsJamClient({ network, fetcher: props.fetcher, now }), [network, props.fetcher]); // eslint-disable-line react-hooks/exhaustive-deps
  const onOverlay = props.onOverlay;

  // Opt-out clears everything; no request is ever made while network is false.
  useEffect(() => { if (!network) { setManifest(null); setPrepared(null); setDate(""); setError(""); setLoading(""); } }, [network]);

  // Re-evaluate age locally while a loaded panel is open; this never triggers a fetch.
  useEffect(() => {
    if (!network || !manifest || !prepared) return;
    const timer = window.setInterval(() => setFreshnessNow(now()), 60_000);
    return () => window.clearInterval(timer);
  }, [network, manifest, prepared, now]);

  useEffect(() => {
    if (!network) return;
    const controller = new AbortController();
    setLoading("Loading GPSJAM date list…");
    client.manifest({ signal: controller.signal, force: manifestTick > 0 }).then((m) => {
      setManifest(m);
      setDate((d) => (d && m.dates.some((x) => x.date === d) ? d : m.latest));
      setError("");
      setLoading("");
    }).catch((e) => { if (!controller.signal.aborted) { setError(describeError(e)); setLoading(""); } });
    return () => controller.abort();
  }, [client, network, manifestTick]);

  useEffect(() => {
    if (!network || !manifest || !date) return;
    if (!manifest.dates.some((d) => d.date === date)) { setPrepared(null); setError(`GPSJAM has no data for ${date} (available ${manifest.earliest} … ${manifest.latest}).`); return; }
    const controller = new AbortController();
    setLoading(`Loading GPSJAM cells for ${date}…`);
    client.day(date, { signal: controller.signal }).then((p) => { setPrepared(p); setError(""); setLoading(""); })
      .catch((e) => { if (!controller.signal.aborted) { setError(describeError(e)); setLoading(""); } });
    return () => controller.abort();
  }, [client, network, manifest, date]);

  const boundsKey = JSON.stringify(props.bounds.map((b) => [b.west, b.south, b.east, b.north].map((v) => Math.round(v))));
  const selection = useMemo(() => (prepared ? selectCells(prepared, props.bounds, { minAircraft, showLow }) : null),
    [prepared, boundsKey, minAircraft, showLow]); // eslint-disable-line react-hooks/exhaustive-deps
  const globeState = useMemo(() => (prepared && selection ? buildGlobeState(prepared, selection, manifest, { opacity, now: freshnessNow }) : null),
    [prepared, selection, manifest, opacity, freshnessNow]);
  useEffect(() => { onOverlay(network && globeState && prepared?.day.date === date ? globeState : null); }, [globeState, network, date, onOverlay]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onOverlay(null), [onOverlay]);

  const entry = manifest?.dates.find((d) => d.date === date);
  const freshness = date && manifest ? dayFreshness(date, manifest, freshnessNow) : null;
  const topCells = selection ? selection.drawn.filter((c) => c.level !== "good").slice(0, 8) : [];
  const canPrev = !!manifest && !!date && date > manifest.earliest;
  const canNext = !!manifest && !!date && date < manifest.latest;

  return <section className="wv-gpsjam" aria-label="GPS interference layer (GPSJAM)">
    <details className="wv-gpsjam-panel">
      <summary>GPS jamming / GNSS interference (GPSJAM daily map)</summary>
      <p className="gpsjam-disclosure">{GPSJAM_DISCLOSURE}</p>
      <label className="gpsjam-opt-in"><input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /> Allow requests to GPSJAM (gpsjam.org) through the SignalWarden relay</label>
      {!network && <p role="status">GPSJAM requests are off. Nothing has been requested.</p>}
      {network && <>
        <div className="gpsjam-controls">
          <button aria-label="Previous day" disabled={!canPrev} onClick={() => setDate(shiftDate(date, -1))}>◀</button>
          <label>UTC day <input type="date" aria-label="GPSJAM date (UTC day)" value={date} min={manifest?.earliest} max={manifest?.latest} disabled={!manifest} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
          <button aria-label="Next day" disabled={!canNext} onClick={() => setDate(shiftDate(date, 1))}>▶</button>
          <button disabled={!manifest || date === manifest.latest} onClick={() => manifest && setDate(manifest.latest)}>Latest</button>
          <button disabled={!manifest} onClick={() => { if (now() - lastManual.current < MANUAL_REFRESH_MS) return; lastManual.current = now(); setManifestTick((n) => n + 1); }}>Check for a new day</button>
        </div>
        <div className="gpsjam-controls">
          <label><input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} /> Show low-interference (green) cells</label>
          <label>Min aircraft per cell <select aria-label="Minimum aircraft per cell" value={minAircraft} onChange={(e) => setMinAircraft(Number(e.target.value))}>
            {[2, 5, 10, 25].map((n) => <option key={n} value={n}>{n}{n === DEFAULT_MIN_AIRCRAFT ? " (GPSJAM default)" : ""}</option>)}
          </select></label>
          <label>Opacity <input type="range" min={0.2} max={0.9} step={0.05} value={opacity} aria-label="GPS interference opacity" onChange={(e) => setOpacity(Number(e.target.value))} /></label>
        </div>
        <div className="gpsjam-legend" aria-label="Legend: share of aircraft reporting low navigation accuracy">
          {(Object.keys(GPSJAM_LEVELS) as Array<keyof typeof GPSJAM_LEVELS>).map((k) => <span key={k}><i style={{ background: GPSJAM_LEVELS[k].hex }} aria-hidden="true" />{GPSJAM_LEVELS[k].label} {GPSJAM_LEVELS[k].range}</span>)}
          <small>share = (low-accuracy aircraft − 1) ÷ all aircraft, per H3 res-4 cell, per UTC day (GPSJAM formula)</small>
        </div>
        {loading && <p role="status">{loading}</p>}
        {error && <p className="gpsjam-warning" role="alert">{error}</p>}
        {freshness && <p className={`gpsjam-status gpsjam-${freshness.status}`}>
          <span className={`gpsjam-badge gpsjam-badge-${freshness.status}`}>{freshness.label}</span>{" "}
          {date} 00:00–24:00 UTC · {freshness.detail}{freshness.status !== "historical" ? ` (${formatAge(freshness.ageMs)} since the day ended)` : ""}
          {entry?.suspect ? <><br /><span className="gpsjam-warning">GPSJAM flags this day as incomplete (data-collection gap). <a href={`${GPSJAM_FAQ_URL}#incomplete-data`} target="_blank" rel="noreferrer noopener">Details</a></span></> : null}
        </p>}
        {prepared && selection && <ul className="gpsjam-facts">
          <li>Source: {prepared.day.sourceLabel} via <a href={GPSJAM_SITE_URL} target="_blank" rel="noreferrer noopener">GPSJAM</a> · <a href={prepared.day.sourceUrl} target="_blank" rel="noreferrer noopener">day file</a>{prepared.day.retrievedAt ? ` · retrieved ${prepared.day.retrievedAt}` : ""}{prepared.day.cache ? ` · relay cache ${prepared.day.cache}` : ""}</li>
          <li>Whole day: {prepared.counts.bad} high · {prepared.counts.medium} medium · {prepared.counts.good} low cells ({prepared.cells.length} with aircraft)</li>
          <li>In view (≥{minAircraft} aircraft): {selection.inViewCounts.bad} high · {selection.inViewCounts.medium} medium · {selection.inViewCounts.good} low · drawing {selection.drawn.length}{selection.truncated ? ` of ${selection.eligible} (cap ${MAX_DRAWN_CELLS}; high/medium kept first; zoom in for the rest)` : ""}</li>
          <li>Hover a hex on the 3D globe for its counts. Cached days: {client.cachedDates.join(", ") || "none"}.</li>
        </ul>}
        {topCells.length > 0 && <table className="gpsjam-top" aria-label="Highest-share interference cells in view">
          <thead><tr><th>Level</th><th>Low-accuracy share</th><th>Low / good / total aircraft</th><th>Cell centre</th></tr></thead>
          <tbody>{topCells.map((c) => <tr key={c.hex}><td>{GPSJAM_LEVELS[c.level].label}</td><td>{c.pct.toFixed(1)} %</td><td>{c.bad} / {c.good} / {c.total}</td><td>{c.lat.toFixed(2)}, {c.lon.toFixed(2)}</td></tr>)}</tbody>
        </table>}
        {prepared && selection && !topCells.length && <p role="status">No medium or high interference cells in the current view for {date}.</p>}
      </>}
      <p className="gpsjam-note">Attribution: GPSJAM by John Wiseman (<a href={GPSJAM_SITE_URL} target="_blank" rel="noreferrer noopener">gpsjam.org</a>), from aircraft reports aggregated by airplanes.live and ADS-B Exchange. <a href={GPSJAM_FAQ_URL} target="_blank" rel="noreferrer noopener">Method and FAQ</a>. Terms: {GPSJAM_TERMS_NOTE}</p>
      <p className="gpsjam-note">Civilian situational awareness only: no jammer location, targeting or source attribution. Not for navigation or flight planning.</p>
    </details>
  </section>;
}
