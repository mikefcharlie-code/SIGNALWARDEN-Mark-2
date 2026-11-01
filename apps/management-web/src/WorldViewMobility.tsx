import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { GeoPoint, WorldObservation } from "./worldview-core";
import {
  STREET_PROVIDERS, ageText, bboxAround, clearMobilityObservations, fetchMobilityStatus, freshnessLabel, geocodePlace, mergeMobilityObservations,
  refreshGbfs, refreshGtfsRt, refreshInfrastructure, refreshRadio, searchNews, searchStreetImagery,
  type MobilityItem, type MobilityRelayStatus, type MobilityResult, type MobilityStatus, type StreetProvider,
} from "./worldview-mobility";
import "./worldview-mobility.css";

type Props = {
  center: GeoPoint;
  active?: boolean;
  onRecords?: Dispatch<SetStateAction<WorldObservation[]>>;
  onCenter?: (point: GeoPoint) => void;
};
type Kind = "gbfs" | "gtfs" | "street" | "geocode" | "radio" | "news" | "infrastructure";
type RelayState = MobilityRelayStatus | { enabled: false; status: MobilityStatus; error: string } | null;
const LIST_LIMIT = 8;

export default function WorldViewMobility({ center, active = false, onRecords, onCenter }: Props) {
  const [optIn, setOptIn] = useState(false);
  const [relay, setRelay] = useState<RelayState>(null);
  const [gbfsFeed, setGbfsFeed] = useState("");
  const [gtfsFeed, setGtfsFeed] = useState("");
  const [halfSpan, setHalfSpan] = useState(0.1);
  const [streetProvider, setStreetProvider] = useState<StreetProvider>("panoramax");
  const [radius, setRadius] = useState(150);
  const [place, setPlace] = useState("");
  const [newsQuery, setNewsQuery] = useState("");
  const [results, setResults] = useState<Partial<Record<Kind, MobilityResult>>>({});
  const [thumb, setThumb] = useState<string | null>(null);
  const [busy, setBusy] = useState<Kind | "relay" | null>(null);
  const [clock, setClock] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => { clearInterval(timer); abort.current?.abort(); onRecords?.(clearMobilityObservations); };
  }, [onRecords]);
  useEffect(() => {
    if (!active) clearAll();
  }, [active]);
  const relayOn = relay !== null && relay.enabled === true;
  const feeds = relayOn ? (relay as MobilityRelayStatus) : null;
  const point = { lat: Number(center.lat.toFixed(5)), lon: Number(center.lon.toFixed(5)) };

  const run = async (kind: Kind | "relay") => {
    if (!active || !optIn || busy) return;
    abort.current?.abort();
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    const options = { network: true, signal: controller.signal };
    setBusy(kind);
    try {
      if (kind === "relay") {
        const status = await fetchMobilityStatus(options);
        setRelay(status);
        if (status.enabled) {
          const s = status as MobilityRelayStatus;
          setGbfsFeed((f) => f || s.gbfs[0]?.id || "");
          setGtfsFeed((f) => f || s.gtfsRealtime.find((x) => x.status === "configured")?.id || s.gtfsRealtime[0]?.id || "");
        }
        return;
      }
      const box = bboxAround(point, halfSpan);
      const result =
        kind === "gbfs" ? await refreshGbfs(gbfsFeed, box, options)
        : kind === "gtfs" ? await refreshGtfsRt(gtfsFeed, box, options)
        : kind === "street" ? await searchStreetImagery(streetProvider, point, radius, options)
        : kind === "geocode" ? await geocodePlace(place, options)
        : kind === "radio" ? await refreshRadio(point, 25, options)
        : kind === "news" ? await searchNews(newsQuery, point, options)
        : await refreshInfrastructure(bboxAround(point, Math.min(halfSpan, 0.5)), options);
      if (controller.signal.aborted || requestGeneration !== generation.current || !active || !optIn) return;
      setResults((old) => ({ ...old, [kind]: result }));
      // Geocoder candidates are not observations of anything; keep them in the list only.
      if (kind !== "geocode") onRecords?.((records) => mergeMobilityObservations(records, result));
      setClock(Date.now());
    } finally {
      if (abort.current === controller && requestGeneration === generation.current) { abort.current = null; setBusy(null); }
    }
  };
  const clearAll = () => {
    generation.current += 1;
    abort.current?.abort();
    abort.current = null;
    setBusy(null);
    setResults({});
    setThumb(null);
    onRecords?.(clearMobilityObservations);
  };

  const disabled = !optIn || busy !== null;
  return <section className="wv-panel mobility-panel" aria-label="Transit, street imagery and context feeds">
    <div className="panel-head"><span className="wv-label">TRANSIT · STREET IMAGERY · CONTEXT</span><span className="mono">READ-ONLY</span></div>
    <label><input type="checkbox" aria-label="Allow transit and context relay requests" checked={optIn} onChange={(e) => { const next = e.target.checked; setOptIn(next); if (!next) clearAll(); }} /> allow requests from this panel</label>
    <p className="fine-print">Off by default; nothing is requested until you press a button. Requests go only to the local relay, which sends the view center or a small box to the named provider. Keys stay on the server. No face, plate or identity processing; no stream relay; no control paths.</p>
    <button disabled={disabled} onClick={() => run("relay")}>Check local relay</button>{" "}
    <button onClick={clearAll}>Clear panel layers</button>
    <p className="source-note" role="status">
      {relay == null ? "Relay not checked." : relay.enabled ? `Relay enabled · ${feeds?.gbfs.length ?? 0} GBFS · ${feeds?.gtfsRealtime.length ?? 0} GTFS-RT feeds · Mapillary ${feeds?.streetImagery.mapillary} · geocoder ${feeds?.geocoder}` : `Relay unavailable: ${"error" in relay ? relay.error : "disabled"}`}
    </p>
    <label>Box <select aria-label="Transit box half-span" value={String(halfSpan)} onChange={(e) => setHalfSpan(Number(e.target.value))}>
      <option value="0.05">±0.05°</option><option value="0.1">±0.1°</option><option value="0.25">±0.25°</option><option value="0.5">±0.5° (GBFS max)</option>
    </select></label>

    <div className="panel-head"><span className="wv-label">BIKESHARE · GBFS</span></div>
    <label>Feed <select aria-label="GBFS feed" value={gbfsFeed} onChange={(e) => setGbfsFeed(e.target.value)} disabled={!feeds?.gbfs.length}>
      {(feeds?.gbfs ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select></label>{" "}
    <button disabled={disabled || !gbfsFeed} onClick={() => run("gbfs")}>Refresh bikeshare</button>
    <Status result={results.gbfs} now={clock} />
    <Items result={results.gbfs} render={(i) => i.kind === "station" ? `${i.label} · bikes ${num(i.properties.bikesAvailable)} · docks ${num(i.properties.docksAvailable)}` : `${i.label}${i.properties.vehicleType ? ` (${i.properties.vehicleType})` : ""}`} />

    <div className="panel-head"><span className="wv-label">TRANSIT VEHICLES · GTFS-REALTIME</span></div>
    <label>Feed <select aria-label="GTFS-realtime feed" value={gtfsFeed} onChange={(e) => setGtfsFeed(e.target.value)} disabled={!feeds?.gtfsRealtime.length}>
      {(feeds?.gtfsRealtime ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}{f.status === "not_configured" ? " (key not configured)" : ""}</option>)}
    </select></label>{" "}
    <button disabled={disabled || !gtfsFeed} onClick={() => run("gtfs")}>Refresh transit vehicles</button>
    <Status result={results.gtfs} now={clock} />
    <Items result={results.gtfs} render={(i) => `${i.label} · ${i.freshness} · ${typeof i.ageSeconds === "number" ? `${i.ageSeconds}s old` : "age unknown"}`} />

    <div className="panel-head"><span className="wv-label">STREET-LEVEL IMAGERY (METADATA)</span></div>
    <label>Provider <select aria-label="Street imagery provider" value={streetProvider} onChange={(e) => { const v = e.target.value as StreetProvider; if (STREET_PROVIDERS.includes(v)) setStreetProvider(v); }}>
      <option value="panoramax">Panoramax</option><option value="kartaview">KartaView</option><option value="mapillary">Mapillary{feeds && feeds.streetImagery.mapillary !== "configured" ? " (token not configured)" : ""}</option>
    </select></label>{" "}
    <label>Radius <select aria-label="Street imagery radius" value={String(radius)} onChange={(e) => setRadius(Number(e.target.value))}>
      <option value="50">50 m</option><option value="150">150 m</option><option value="300">300 m</option><option value="500">500 m</option>
    </select></label>{" "}
    <button disabled={disabled} onClick={() => run("street")}>Find images near view center</button>
    <Status result={results.street} now={clock} />
    {results.street?.items.slice(0, LIST_LIMIT).map((i) => <p className="fine-print" key={i.id}>
      {i.label} · captured {i.providerTimestamp ? i.providerTimestamp.slice(0, 10) : "unknown"} · {String(i.properties.author ?? "")} · {String(i.properties.license ?? "")}
      {typeof i.properties.pageUrl === "string" && <> · <a href={i.properties.pageUrl} target="_blank" rel="noreferrer">open</a></>}
      {typeof i.properties.thumbnailUrl === "string" && <> · <button className="link-button" onClick={() => setThumb(thumb === i.properties.thumbnailUrl ? null : String(i.properties.thumbnailUrl))}>{thumb === i.properties.thumbnailUrl ? "hide thumbnail" : "show thumbnail"}</button></>}
    </p>)}
    {thumb && <img className="mobility-thumb" src={thumb} alt="Street-level thumbnail from the provider (loaded on request)" referrerPolicy="no-referrer" loading="lazy" />}

    <div className="panel-head"><span className="wv-label">PLACE SEARCH · NOMINATIM</span></div>
    <input aria-label="Place search" value={place} maxLength={200} onChange={(e) => setPlace(e.target.value)} placeholder="place or address" />{" "}
    <button disabled={disabled || place.trim().length < 2} onClick={() => run("geocode")}>Search place</button>
    <Status result={results.geocode} now={clock} />
    {results.geocode?.items.slice(0, LIST_LIMIT).map((i) => <p className="fine-print" key={i.id}>
      {i.label}{i.point && onCenter && <> · <button className="link-button" onClick={() => onCenter(i.point as GeoPoint)}>go to</button></>}
    </p>)}

    <div className="panel-head"><span className="wv-label">CONTEXT · RADIO · NEWS · INFRASTRUCTURE</span></div>
    <button disabled={disabled} onClick={() => run("radio")}>Radio stations within 25 km</button>
    <Status result={results.radio} now={clock} />
    <Items result={results.radio} render={(i) => `${i.label}${i.properties.language ? ` · ${i.properties.language}` : ""}`} link="homepage" />
    <input aria-label="News search" value={newsQuery} maxLength={120} onChange={(e) => setNewsQuery(e.target.value)} placeholder="news keywords" />{" "}
    <button disabled={disabled || newsQuery.trim().length < 3} onClick={() => run("news")}>Search news links (GDELT)</button>
    <Status result={results.news} now={clock} />
    <Items result={results.news} render={(i) => `${i.label}${i.properties.domain ? ` · ${i.properties.domain}` : ""} · ${ageText(i.providerTimestamp, clock)}`} link="articleUrl" />
    <button disabled={disabled} onClick={() => run("infrastructure")}>Data centers and dams in view (OSM)</button>
    <Status result={results.infrastructure} now={clock} />
    <Items result={results.infrastructure} render={(i) => `${i.kind === "dam" ? "Dam" : "Data center"} · ${i.label}`} link="osmUrl" />

    <p className="fine-print">Positions are operator/agency-reported or crowdsourced, never surveyed. Street imagery capture times are historical. News markers sit at the searched place, not where events happened. Each source keeps its own licence; see the attribution on every status line.</p>
  </section>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "—");

function Items({ result, render, link }: { result?: MobilityResult; render: (i: MobilityItem) => string; link?: string }) {
  if (!result?.items.length) return null;
  return <ul className="mobility-items">
    {result.items.slice(0, LIST_LIMIT).map((i) => <li key={i.id} className={`mobility-${i.freshness}`}>
      {render(i)}
      {link && typeof i.properties[link] === "string" && <> · <a href={String(i.properties[link])} target="_blank" rel="noreferrer noopener">link</a></>}
    </li>)}
    {result.items.length > LIST_LIMIT && <li className="fine-print">+{result.items.length - LIST_LIMIT} more on the globe</li>}
  </ul>;
}

function Status({ result, now }: { result?: MobilityResult; now: number }) {
  if (!result) return null;
  return <p className={`source-note mobility-status mobility-${result.status}`}>
    <b>{freshnessLabel(result, now)}</b> · {result.providerName} · {result.items.length} item(s)
    {result.error ? ` · ${result.error}` : ""}
    {result.notice ? <><br /><span className="fine-print">{result.notice}</span></> : null}
    {result.attribution ? <><br /><span className="fine-print">{result.attribution}{result.license ? ` · ${result.license}` : ""}</span></> : null}
    {result.sourceUrl && <> · <a href={result.sourceUrl} target="_blank" rel="noreferrer">source</a></>}
    {result.termsUrl && <> · <a href={result.termsUrl} target="_blank" rel="noreferrer">terms</a></>}
    {result.licenseUrl && <> · <a href={result.licenseUrl} target="_blank" rel="noreferrer">licence</a></>}
  </p>;
}
