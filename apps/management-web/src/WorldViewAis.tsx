import { useCallback, useEffect, useRef, useState } from "react";
import type { GeoPoint, WorldObservation } from "./worldview-core";
import {
  AIS_POLL_MS,
  AIS_PROVIDER_IDS,
  AIS_PROVIDER_LABELS,
  AIS_SELF_REPORTED,
  aisBBox,
  aisObservations,
  aisStatusText,
  ageAisObservations,
  fetchAisStatus,
  fetchAisVessels,
  type AisFetcher,
  type AisProviderId,
  type AisProviderInfo,
  type AisVesselsResponse,
} from "./worldview-ais";
import "./worldview-ais.css";

type Props = Readonly<{
  center: GeoPoint;
  active?: boolean;
  /** Replace every observation from `source` with `observations` (empty clears). */
  onObservations: (source: string, observations: WorldObservation[]) => void;
  fetcher?: AisFetcher;
}>;

const noop = () => {};

export default function WorldViewAis(props: Props = { center: { lat: 60.39, lon: 5.32 }, onObservations: noop, active: false }) {
  const { center, onObservations, active = false } = props;
  const fetcher = props.fetcher ?? ((input: string, init: RequestInit) => fetch(input, init));
  const [enabled, setEnabled] = useState(false);
  const [auto, setAuto] = useState(false);
  const [provider, setProvider] = useState<AisProviderId>("aisstream");
  const [statuses, setStatuses] = useState<AisProviderInfo[]>([]);
  const [last, setLast] = useState<AisVesselsResponse | null>(null);
  const [message, setMessage] = useState("AIS relay reads are off. Nothing has been requested.");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const shown = useRef<{ source: string; observations: WorldObservation[] } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const clear = useCallback(() => {
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    if (shown.current) onObservations(shown.current.source, []);
    shown.current = null;
    setLast(null);
  }, [onObservations]);

  useEffect(() => () => { abort.current?.abort(); if (shown.current) onObservations(shown.current.source, []); }, [onObservations]);

  useEffect(() => {
    if (active) return;
    setAuto(false);
    clear();
    setStatuses([]);
    setFailed(false);
    setMessage("AIS is inactive while this globe view is closed. Live vessels were removed from the globe.");
  }, [active, clear]);

  const checkStatus = async () => {
    if (!active || !enabled) return;
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    try {
      const status = await fetchAisStatus(fetcher, controller.signal);
      if (controller.signal.aborted || requestGeneration !== generation.current || !active || !enabled) return;
      setStatuses(status.providers);
      setFailed(false);
      setMessage(`Relay reachable · read-only · no AIS transmit. ${status.providers.filter((p) => p.configured).length} of ${status.providers.length} providers configured on the server.`);
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || !active || !enabled) return;
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "AIS relay status failed");
    } finally {
      if (abort.current === controller && requestGeneration === generation.current) abort.current = null;
    }
  };

  const refresh = async () => {
    if (!active || !enabled || busy) return;
    let bbox;
    try { bbox = aisBBox(center); } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Invalid view"); return; }
    abort.current?.abort();
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      const body = await fetchAisVessels(provider, bbox, fetcher, controller.signal);
      const observations = aisObservations(body);
      if (controller.signal.aborted || requestGeneration !== generation.current || !active || !enabled) return;
      if (shown.current && shown.current.source !== body.source) onObservations(shown.current.source, []);
      shown.current = { source: body.source, observations };
      onObservations(body.source, observations);
      setLast(body);
      setNow(Date.now());
      setFailed(body.status === "error" || body.status === "not_configured");
      setMessage(`${aisStatusText(body)} · ${observations.length} vessel${observations.length === 1 ? "" : "s"} shown${body.truncated ? ` (of ${body.vesselsInBox}; capped)` : ""}`);
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || !active || !enabled) return;
      setFailed(true);
      if (shown.current) {
        const stale = shown.current.observations.map((o) => ({ ...o, freshness: "stale" as const, stale: true }));
        shown.current = { ...shown.current, observations: stale };
        onObservations(shown.current.source, stale);
      }
      setMessage(`${error instanceof Error ? error.message : "AIS refresh failed"}${shown.current ? "; previous vessels kept and marked STALE" : ""}`);
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!active || !enabled || !auto) return;
    void refreshRef.current();
    const timer = window.setInterval(() => void refreshRef.current(), AIS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, enabled, auto, provider]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!shown.current) return;
      const aged = ageAisObservations(shown.current.observations);
      if (aged.some((o, i) => o !== shown.current!.observations[i])) {
        shown.current = { ...shown.current, observations: aged };
        onObservations(shown.current.source, aged);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [onObservations]);

  const bbox = (() => { try { return aisBBox(center); } catch { return null; } })();

  return <section className="wv-ais" aria-label="Live AIS vessels">
    <h2><small>VESSELS LAYER · LIVE AIS VIA LOCAL RELAY</small>Live AIS vessels</h2>
    <p className="ais-disclosure"><b>SELF-REPORTED.</b> {AIS_SELF_REPORTED}</p>
    <label className="ais-opt-in"><input type="checkbox" checked={enabled} onChange={(e) => {
      setEnabled(e.target.checked);
      if (!e.target.checked) { setAuto(false); clear(); setStatuses([]); setFailed(false); setMessage("AIS relay reads are off. Live vessels were removed from the globe."); }
      else setMessage("Enabled for this session. Choose a provider, then Refresh or turn on polling.");
    }} /> Enable AIS reads through the local Management API relay (session only; sends only a capped bounding box around the view centre to your own server)</label>
    <div className="ais-controls">
      <label>Provider <select aria-label="AIS provider" value={provider} disabled={!enabled} onChange={(e) => { clear(); setProvider(e.target.value as AisProviderId); }}>
        {AIS_PROVIDER_IDS.map((id) => <option key={id} value={id}>{AIS_PROVIDER_LABELS[id]}</option>)}
      </select></label>
      <button disabled={!active || !enabled || busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh vessels now"}</button>
      <label><input type="checkbox" checked={auto} disabled={!enabled} onChange={(e) => setAuto(e.target.checked)} /> Poll every {AIS_POLL_MS / 1000}s while open</label>
      <button disabled={!enabled} onClick={() => void checkStatus()}>Check relay status</button>
      <button disabled={!last} onClick={() => { clear(); setMessage("Live vessels cleared from the globe."); }}>Clear vessels</button>
    </div>
    <p role="status" className={failed ? "ais-error" : ""}>{message}</p>
    {bbox && <p className="fine-print">Area: {bbox.south.toFixed(2)}…{bbox.north.toFixed(2)}°N, {bbox.west.toFixed(2)}…{bbox.east.toFixed(2)}°E (capped at 4°×6°; no antimeridian crossing). Stream providers connect only while polled and disconnect after 2 minutes idle.</p>}
    {statuses.length > 0 && <ul className="ais-status-list">{statuses.map((s) => <li key={s.provider} className={`ais-${s.status}`}>{aisStatusText(s, now)}</li>)}</ul>}
    {last && <div className="ais-source">
      <p className={last.status === "live" ? "" : "ais-warning"}><b>{last.status === "live" ? "LIVE" : last.status.toUpperCase().replace("_", " ")}</b> · {last.name} · retrieved {last.retrievedAt}{last.lastMessageAt ? ` · last provider message ${last.lastMessageAt}` : ""}. Vessels older than 10 minutes are marked STALE; positions expire after 30 minutes.</p>
      <p className="fine-print">{last.attribution} · {last.license}{last.licenseUrl ? <> · <a href={last.licenseUrl} target="_blank" rel="noreferrer">licence</a></> : null}{last.termsUrl ? <> · <a href={last.termsUrl} target="_blank" rel="noreferrer">provider terms</a></> : null}. {last.coverage}</p>
      {last.vessels.length > 0 && <table className="ais-table"><thead><tr><th>Vessel</th><th>Type</th><th>SOG kn</th><th>COG°</th><th>HDG°</th><th>Status</th><th>Age</th></tr></thead><tbody>
        {last.vessels.slice(0, 12).map((v) => <tr key={v.mmsi} className={v.stale ? "ais-stale-row" : ""}><td>{v.name || `MMSI ${v.mmsi}`}</td><td>{v.shipTypeText ?? "—"}</td><td>{v.sogKn ?? "—"}</td><td>{v.cogDeg ?? "—"}</td><td>{v.headingDeg ?? "—"}</td><td>{v.navStatusText ?? "—"}</td><td>{v.ageSeconds ?? "?"}s{v.stale ? " STALE" : ""}</td></tr>)}
      </tbody></table>}
    </div>}
    <p className="fine-print">Keys stay on the server (<code>UCAS_AISSTREAM_API_KEY</code>, <code>UCAS_BARENTSWATCH_CLIENT_ID</code>/<code>_SECRET</code>); the Kystverket feed is keyless but must be enabled with <code>UCAS_KYSTVERKET_AIS_ENABLED=1</code>. The whole relay is off unless <code>UCAS_PUBLIC_AIS_ENABLED=1</code>. Receive-only situational awareness: no AIS transmit, no vessel tasking, no identity enrichment.</p>
  </section>;
}
