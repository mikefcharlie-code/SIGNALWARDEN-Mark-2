import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { GeoPoint, WorldObservation } from "./worldview-core";
import {
  WEATHER_MODELS, WEATHER_SOURCES, bboxAround, forecastSource, fetchWeatherRelayStatus, isWeatherModel, lookupAircraftType, mergeProviderObservations,
  refreshOpenAq, refreshOpenMeteoAirQuality, refreshOpenMeteoForecast, refreshOpenSky,
  type AircraftType, type EnrichmentResult, type RelayStatus, type WeatherModel,
} from "./worldview-weather";
import "./worldview-weather.css";

type Props = {
  active?: boolean;
  center: GeoPoint;
  selected: WorldObservation | null;
  onRecords?: Dispatch<SetStateAction<WorldObservation[]>>;
};
type Kind = "forecast" | "aqModel" | "aqMeasured" | "opensky";
const SOURCE_PREFIX: Record<Exclude<Kind, "forecast">, string> = { aqModel: "Open-Meteo CAMS", aqMeasured: "OpenAQ", opensky: "OpenSky" };
const num = (v: unknown, digits = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—");
const age = (iso: string | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown age";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function WorldViewWeather({ active = false, center, selected, onRecords }: Props) {
  const [optIn, setOptIn] = useState(false);
  const [freeTierConsent, setFreeTierConsent] = useState(false);
  const [relay, setRelay] = useState<RelayStatus | { enabled: false; error: string } | null>(null);
  const [model, setModel] = useState<WeatherModel>("gfs_seamless");
  const [halfSpan, setHalfSpan] = useState(1);
  const [results, setResults] = useState<Partial<Record<Kind, EnrichmentResult>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [aircraftType, setAircraftType] = useState<AircraftType | null>(null);
  const [typeError, setTypeError] = useState("");
  const [clock, setClock] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);
  const emittedIds = useRef(new Set<string>());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => {
      clearInterval(timer); abort.current?.abort();
      const ids = new Set(emittedIds.current);
      onRecords?.((records) => records.filter((record) => !ids.has(record.id)));
    };
  }, [onRecords]);
  useEffect(() => {
    if (active && optIn) return;
    abort.current?.abort(); abort.current = null;
    setBusy(null); setResults({}); setRelay(null); setAircraftType(null); setTypeError("");
    const ids = new Set(emittedIds.current); emittedIds.current.clear();
    if (ids.size) onRecords?.((records) => records.filter((record) => !ids.has(record.id)));
  }, [active, optIn, onRecords]);
  const relayOn = relay?.enabled === true;
  const commercialOpenMeteo = relayOn && (relay as RelayStatus).providers?.openMeteo?.tier === "commercial";
  const selectedHex = typeof selected?.properties?.opaqueContactHex === "string" && /^[0-9a-f]{6}$/.test(selected.properties.opaqueContactHex) ? selected.properties.opaqueContactHex : "";

  const run = async (kind: Kind | "relay" | "type") => {
    if (!active || !optIn || busy) return;
    if ((kind === "forecast" || kind === "aqModel") && !commercialOpenMeteo && !freeTierConsent) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const options = { network: true, signal: controller.signal, openMeteoTermsConfirmed: commercialOpenMeteo || freeTierConsent };
    setBusy(kind);
    try {
      if (kind === "relay") {
        const result = await fetchWeatherRelayStatus(options);
        if (!controller.signal.aborted) setRelay(result);
        return;
      }
      if (kind === "type") {
        setTypeError(""); setAircraftType(null);
        try {
          const result = await lookupAircraftType(selectedHex, options);
          if (!controller.signal.aborted) setAircraftType(result);
        }
        catch (e) { if (!controller.signal.aborted) setTypeError(e instanceof Error ? e.message : "Lookup failed"); }
        return;
      }
      const result =
        kind === "forecast" ? await refreshOpenMeteoForecast(center, model, { ...options, relay: commercialOpenMeteo })
        : kind === "aqModel" ? await refreshOpenMeteoAirQuality(center, { ...options, relay: commercialOpenMeteo })
        : kind === "aqMeasured" ? await refreshOpenAq(center, options)
        : await refreshOpenSky(bboxAround(center, halfSpan), options);
      if (controller.signal.aborted) return;
      setResults((old) => ({ ...old, [kind]: result }));
      const prefix = kind === "forecast" ? forecastSource(model) : SOURCE_PREFIX[kind];
      result.observations.forEach((record) => emittedIds.current.add(record.id));
      onRecords?.((records) => mergeProviderObservations(records, result, prefix));
      setClock(Date.now());
    } finally {
      if (abort.current === controller) { abort.current = null; setBusy(null); }
    }
  };

  const forecast = results.forecast;
  const rows = forecast?.series?.filter((_, i) => i % 3 === 0).slice(0, 16) ?? [];
  const disabled = !active || !optIn || busy !== null;
  const modelDisabled = disabled || (!commercialOpenMeteo && !freeTierConsent);
  return <section className="wv-panel weather-panel" aria-label="Weather models, air quality and aviation enrichment">
    <div className="panel-head"><span className="wv-label">WEATHER · AIR QUALITY · AVIATION</span><span className="mono">READ-ONLY</span></div>
    <label><input type="checkbox" aria-label="Allow weather and aviation provider requests" checked={optIn} disabled={!active} onChange={(e) => { setOptIn(e.target.checked); if (!e.target.checked) abort.current?.abort(); }} /> allow requests from this panel</label>
    <label><input type="checkbox" aria-label="Confirm non-commercial Open-Meteo use" checked={freeTierConsent} onChange={(e) => { setFreeTierConsent(e.target.checked); if (!e.target.checked && !commercialOpenMeteo) abort.current?.abort(); }} /> I confirm this use meets Open-Meteo's free non-commercial terms (not needed with a verified commercial relay).</label>
    {!active && <p className="fine-print">Provider requests are paused while the globe is not visible.</p>}
    <p className="fine-print">Off by default; nothing is requested until you press a button. Sends the view center (rounded to 4 decimals) or a ≤5° box to the named provider. Keyed providers run only through the local relay; keys never reach this page.</p>
    <button disabled={disabled} onClick={() => run("relay")}>Check local relay</button>
    <p className="source-note" role="status">
      {relay == null ? "Relay not checked. Open-Meteo works without it (free, non-commercial tier, direct from the browser)." :
        relay.enabled ? `Relay enabled · Open-Meteo ${(relay as RelayStatus).providers.openMeteo?.tier ?? "?"} · OpenAQ ${(relay as RelayStatus).providers.openAq?.status ?? "?"} · OpenSky ${(relay as RelayStatus).providers.openSky?.mode ?? "?"} · adsbdb type-only` :
        `Relay unavailable: ${"error" in relay ? relay.error : "disabled"}`}
    </p>

    <div className="panel-head"><span className="wv-label">MODEL FORECAST · 48 H</span></div>
    <label>Model <select aria-label="Weather model" value={model} onChange={(e) => { if (isWeatherModel(e.target.value)) setModel(e.target.value); }}>
      {Object.entries(WEATHER_MODELS).map(([id, m]) => <option key={id} value={id}>{m.label}</option>)}
    </select></label>{" "}
    <button disabled={modelDisabled} onClick={() => run("forecast")}>Refresh model forecast</button>
    <Status result={forecast} now={clock} />
    {rows.length > 0 && <table className="weather-table">
      <caption className="fine-print">Model forecast, UTC, m/s · not observations. Model run {forecast?.modelRun ? `${forecast.modelRun.slice(0, 16)}Z` : "unknown"}.</caption>
      <thead><tr><th>UTC</th><th>10 m</th><th>80 m</th><th>120 m</th><th>Gust</th><th>°C</th><th>Cloud %</th><th>Precip mm</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.time}>
        <td>{r.time.slice(5, 13).replace("T", " ")}</td>
        <td>{num(r.wind_speed_10m)} @{num(r.wind_direction_10m, 0)}°</td>
        <td>{num(r.wind_speed_80m)}{r.wind_direction_80m == null ? "" : ` @${num(r.wind_direction_80m, 0)}°`}</td>
        <td>{num(r.wind_speed_120m)}{r.wind_direction_120m == null ? "" : ` @${num(r.wind_direction_120m, 0)}°`}</td>
        <td>{num(r.wind_gusts_10m)}</td><td>{num(r.temperature_2m)}</td><td>{num(r.cloud_cover, 0)}</td><td>{num(r.precipitation)}</td>
      </tr>)}</tbody>
    </table>}

    <div className="panel-head"><span className="wv-label">AIR QUALITY</span></div>
    <button disabled={modelDisabled} onClick={() => run("aqModel")}>Refresh modelled AQ (CAMS)</button>{" "}
    <button disabled={disabled} onClick={() => run("aqMeasured")}>Refresh measured AQ (OpenAQ · relay)</button>
    <Status result={results.aqModel} now={clock} />
    {results.aqModel?.observations[0] && <p className="fine-print">MODELLED now: US AQI {num(results.aqModel.observations[0].properties?.us_aqi, 0)} · PM2.5 {num(results.aqModel.observations[0].properties?.pm2_5)} · PM10 {num(results.aqModel.observations[0].properties?.pm10)} · O₃ {num(results.aqModel.observations[0].properties?.ozone, 0)} · NO₂ {num(results.aqModel.observations[0].properties?.nitrogen_dioxide)} µg/m³</p>}
    <Status result={results.aqMeasured} now={clock} />
    {results.aqMeasured?.observations.map((o) => <p className="fine-print" key={o.id}>MEASURED · {o.label.replace("Air quality (MEASURED) · ", "")} ({String(o.properties?.stationType ?? "")}) · {age(o.observedAt, clock)} · PM2.5 {num(o.properties?.pm25)} · PM10 {num(o.properties?.pm10)} · O₃ {num(o.properties?.o3, 3)} · NO₂ {num(o.properties?.no2, 3)}</p>)}

    <div className="panel-head"><span className="wv-label">AIRCRAFT · OPENSKY</span></div>
    <label>Box <select aria-label="OpenSky box half-span" value={String(halfSpan)} onChange={(e) => setHalfSpan(Number(e.target.value))}>
      <option value="0.5">±0.5°</option><option value="1">±1°</option><option value="2.5">±2.5° (max)</option>
    </select></label>{" "}
    <button disabled={disabled} onClick={() => run("opensky")}>Refresh OpenSky aircraft (relay)</button>
    <Status result={results.opensky} now={clock} />
    <p className="fine-print">Positions keyed only by opaque transponder hex. Callsign, squawk, origin country and receiver IDs are removed by the relay. Crowdsourced; coverage gaps are normal. Anonymous: ≤1 request/60 s; OAuth: ≤1/15 s.</p>
    <button disabled={disabled || !selectedHex} onClick={() => run("type")}>{selectedHex ? "Look up selected aircraft type (adsbdb)" : "Select an aircraft to look up its type"}</button>
    {aircraftType && <p className="source-note">{aircraftType.found ? `Type: ${aircraftType.type ?? "—"} (${aircraftType.icaoType ?? "—"}) · ${aircraftType.manufacturer ?? "—"}` : "adsbdb has no type for this transponder"} · {aircraftType.attribution}</p>}
    {typeError && <p className="source-note">Type lookup failed: {typeError}</p>}
    <p className="fine-print">Type only, one selected aircraft at a time. Registration, owner/operator and photos are discarded by the relay under the no-identity-enrichment policy.</p>

    <p className="fine-print">
      {WEATHER_SOURCES.openMeteo.attribution} · <a href={WEATHER_SOURCES.openMeteo.termsUrl} target="_blank" rel="noreferrer">terms</a> · {WEATHER_SOURCES.openMeteo.limits}. {WEATHER_MODELS[model].attribution}. {WEATHER_SOURCES.openAq.attribution} · <a href={WEATHER_SOURCES.openAq.termsUrl} target="_blank" rel="noreferrer">terms</a>. {WEATHER_SOURCES.openSky.attribution} · <a href={WEATHER_SOURCES.openSky.termsUrl} target="_blank" rel="noreferrer">terms</a>. Forecasts and modelled AQ are not observations; not for flight planning or certified use.
    </p>
  </section>;
}

function Status({ result, now }: { result?: EnrichmentResult; now: number }) {
  if (!result) return null;
  const label = result.status === "live" ? "LIVE" : result.status.toUpperCase().replace("_", " ");
  return <p className={`source-note weather-status weather-${result.status}`}>
    <b>{label}</b> · {result.providerId} · {result.route ?? "direct"} · retrieved {age(result.retrievedAt, now)} · {result.observations.length} record(s)
    {result.error ? ` · ${result.error}` : ""}
    {result.sourceUrl && <> · <a href={result.sourceUrl} target="_blank" rel="noreferrer">source</a></>} · <a href={result.termsUrl} target="_blank" rel="noreferrer">terms</a>
  </p>;
}
