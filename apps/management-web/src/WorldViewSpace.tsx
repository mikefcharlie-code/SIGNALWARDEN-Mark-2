import { useEffect, useMemo, useRef, useState } from "react";
import type { SatRec } from "satellite.js";
import type { WorldObservation } from "./worldview-core";
import { parseTle } from "./worldview-orbits";
import {
  forecastVisibility,
  forecastPosition,
  VISIBILITY_DEFAULTS,
  type VisibilityPass,
  type ElementUncertainty,
} from "./worldview-space-visibility";
import {
  CELESTRAK_GROUPS,
  SPACE_PROVIDERS,
  cloudAt,
  refreshCelestrak,
  refreshCloudForecast,
  refreshLaunches,
  refreshSatnogsObservations,
  type CatalogEntry,
  type CatalogQuery,
  type CatalogResult,
  type CelestrakGroup,
  type CloudForecast,
  type LaunchResult,
  type RadioObservationResult,
  type SpaceSourceMeta,
} from "./worldview-space-feeds";
import "./worldview-space.css";

type Props = {
  observer: { lat: number; lon: number };
  /** Provider work is allowed only while the globe/panel is active. */
  active?: boolean;
  /** Receives forecast position markers (layer "satellites"); never observations. */
  onObservations?: (records: WorldObservation[]) => void;
};
type Target = { name: string; noradId: number | null; satrec: SatRec; source: "celestrak" | "pasted"; entry?: CatalogEntry };
type CloudChoice = "nws-skycover" | "open-meteo" | "none";

const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "n/a");
const time = (v: string) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const age = (s: number | null) =>
  s === null ? "age unknown" : s < 120 ? `${s}s old` : s < 7200 ? `${Math.round(s / 60)} min old` : `${(s / 3600).toFixed(1)} h old`;
const VERDICT: Record<VisibilityPass["verdict"], string> = {
  visible: "FORECAST · VISIBLE (sunlit, dark sky)",
  daylight: "FORECAST · not visible: sky too bright",
  eclipsed: "FORECAST · not visible: in Earth's shadow",
};
const CLOUD_LABEL = {
  "clear-to-partly-cloudy": "clear to partly cloudy",
  "partly-cloudy-may-interrupt": "partly cloudy, may interrupt",
  "likely-obscured": "likely obscured",
  "no-forecast": "no cloud forecast for this time",
} as const;

function SourceLine({ meta }: { meta: SpaceSourceMeta }) {
  return (
    <p className={`fine-print space-source space-${meta.freshness}`}>
      <b>{meta.provider}</b> · {meta.freshness.toUpperCase()} · retrieved {when(meta.retrievedAt)} · provider time{" "}
      {when(meta.providerTimestamp)} ({age(meta.ageSeconds)}) · {meta.attribution} ·{" "}
      <a href={meta.licenseUrl} target="_blank" rel="noreferrer">
        {meta.license}
      </a>
      {meta.note ? <> · {meta.note}</> : null}
      {meta.error ? <span className="space-error"> · {meta.error}</span> : null}
    </p>
  );
}

export function WorldViewSpace({ observer, onObservations, active = false }: Props) {
  const [network, setNetwork] = useState(false);
  const [openMeteoConsent, setOpenMeteoConsent] = useState(false);
  const [mode, setMode] = useState<CatalogQuery["kind"]>("catnr");
  const [group, setGroup] = useState<CelestrakGroup>("stations");
  const [term, setTerm] = useState("25544");
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tle, setTle] = useState("");
  const [minEl, setMinEl] = useState<number>(VISIBILITY_DEFAULTS.minElevationDeg);
  const [maxSun, setMaxSun] = useState<number>(VISIBILITY_DEFAULTS.maxSunElevationDeg);
  const [hours, setHours] = useState<number>(VISIBILITY_DEFAULTS.hours);
  const [stdMag, setStdMag] = useState("");
  const [cloudChoice, setCloudChoice] = useState<CloudChoice>("nws-skycover");
  const [forecast, setForecast] = useState<{
    target: Target;
    passes: VisibilityPass[];
    uncertainty: ElementUncertainty;
    refused?: string;
    observer: { lat: number; lon: number };
    computedAt: string;
  } | null>(null);
  const [cloud, setCloud] = useState<CloudForecast | null>(null);
  const [radio, setRadio] = useState<RadioObservationResult | null>(null);
  const [launches, setLaunches] = useState<LaunchResult | null>(null);
  const [viaRelay, setViaRelay] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(active ? "Off. No space-data requests have been made." : "Paused. No space-data requests are made while the globe is hidden.");
  const abort = useRef<AbortController | null>(null);
  const onObservationsRef = useRef(onObservations);
  onObservationsRef.current = onObservations;

  useEffect(() => {
    if (active) return;
    abort.current?.abort();
    abort.current = null;
    setBusy("");
    setCatalog(null);
    setForecast(null);
    setCloud(null);
    setRadio(null);
    setLaunches(null);
    setMessage("Paused. No space-data requests are made while the globe is hidden.");
    onObservationsRef.current?.([]);
  }, [active]);

  const target: Target | null = useMemo(() => {
    const entry = catalog?.entries.find((e) => e.noradId === selected);
    if (entry) return { name: entry.name, noradId: entry.noradId, satrec: entry.satrec, source: "celestrak", entry };
    return null;
  }, [catalog, selected]);

  const run = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (!active) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(label);
    try {
      await work(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setMessage(`${label} failed: ${e instanceof Error ? e.message : "error"}. No fallback data was substituted.`);
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setBusy("");
      }
    }
  };

  const loadCatalog = () =>
    run("CelesTrak", async (signal) => {
      const query: CatalogQuery =
        mode === "group" ? { kind: "group", value: group } : mode === "catnr" ? { kind: "catnr", value: Number(term) } : { kind: "name", value: term };
      const result = await refreshCelestrak(query, { network, signal });
      if (!active || signal.aborted) return;
      setCatalog(result);
      setSelected(result.entries[0]?.noradId ?? null);
      setMessage(
        result.entries.length
          ? `ELEMENTS · ${result.entries.length} object${result.entries.length === 1 ? "" : "s"} (${result.freshness}). Orbital elements are inputs to forecasts, not observations.`
          : `ELEMENTS · none loaded${result.error ? `: ${result.error}` : ""}`,
      );
    });

  const forecastPasses = () =>
    run("Visibility forecast", async (signal) => {
      if (!active || signal.aborted) return;
      let t = target;
      if (!t && tle.trim()) {
        const parsed = parseTle(tle);
        const norad = Number(parsed.line1.slice(2, 7));
        t = { name: parsed.name ?? "Pasted TLE", noradId: Number.isFinite(norad) ? norad : null, satrec: parsed.satrec, source: "pasted" };
      }
      if (!t) {
        setMessage("Select a CelesTrak object or paste a checksum-valid TLE first.");
        return;
      }
      const mag = stdMag.trim() === "" ? undefined : Number(stdMag);
      if (mag !== undefined && (!Number.isFinite(mag) || Math.abs(mag) > 20)) {
        setMessage("Standard magnitude must be a number between -20 and 20, or blank.");
        return;
      }
      const start = new Date();
      const obs = { lat: observer.lat, lon: observer.lon };
      const result = forecastVisibility(t.satrec, obs, start, {
        hours,
        minElevationDeg: minEl,
        maxSunElevationDeg: maxSun,
        standardMagnitude: mag ?? null,
        noradId: t.noradId ?? undefined,
      });
      if (signal.aborted || !active) return;
      setForecast({ target: t, ...result, observer: obs, computedAt: start.toISOString() });
      // Forecast position marker for the globe; explicitly not an observation.
      if (onObservations && !result.refused) {
        const marker = forecastPosition(t.satrec, start);
        if (marker)
          onObservations([
            {
              id: `space-forecast-${t.noradId ?? "pasted"}`,
              layer: "satellites",
              point: { lat: marker.latitude, lon: marker.longitude, altM: marker.altitudeKm * 1000 },
              observedAt: start.toISOString(),
              source: t.source === "celestrak" ? "CelesTrak elements · SGP4 forecast" : "Pasted TLE · SGP4 forecast",
              label: `${t.name} · forecast position, not observed`,
              freshness: result.uncertainty.status === "current" ? "fresh" : "stale",
              properties: {
                kind: "forecast",
                provider: t.source === "celestrak" ? "CelesTrak" : "user-supplied TLE",
                sourceUrl: t.source === "celestrak" ? catalog?.sourceUrl ?? SPACE_PROVIDERS.celestrak.endpoint : "local",
                retrievedAt: t.source === "celestrak" ? catalog?.retrievedAt ?? null : null,
                elementEpoch: result.uncertainty.elementEpoch,
                elementAgeDays: result.uncertainty.elementAgeDays,
                attribution: t.source === "celestrak" ? SPACE_PROVIDERS.celestrak.attribution : "User-supplied TLE",
                license: t.source === "celestrak" ? SPACE_PROVIDERS.celestrak.licenseUrl : "n/a",
              },
            },
          ]);
      }
      let cloudResult: CloudForecast | null = null;
      if (cloudChoice !== "none" && result.passes.some((p) => p.visible)) {
        if (!network) setMessage("Visibility forecast computed locally. Cloud forecast skipped: network opt-in is off.");
        else cloudResult = await refreshCloudForecast(cloudChoice, obs, { network, signal, openMeteoTermsConfirmed: openMeteoConsent });
      }
      if (!active || signal.aborted) return;
      setCloud(cloudResult);
      const visible = result.passes.filter((p) => p.visible).length;
      if (result.refused) setMessage(`FORECAST REFUSED · ${result.refused}`);
      else if (network || cloudChoice === "none" || !result.passes.some((p) => p.visible))
        setMessage(`FORECAST · ${result.passes.length} pass${result.passes.length === 1 ? "" : "es"} above ${minEl}°, ${visible} forecast visible. Predictions, not sightings.`);
    });

  const loadRadio = () =>
    run("SatNOGS", async (signal) => {
      const id = forecast?.target.noradId ?? target?.noradId ?? (mode === "catnr" ? Number(term) : NaN);
      if (!Number.isSafeInteger(id)) {
        setMessage("Choose an object with a NORAD catalog number first.");
        return;
      }
      const r = await refreshSatnogsObservations(id as number, { network, signal });
      if (!active || signal.aborted) return;
      setRadio(r);
      setMessage(r.error ? `RADIO · ${r.error}` : `RADIO · ${r.observations.length} recent ground-station radio observations (observed data, not optical).`);
    });

  const loadLaunches = () =>
    run("Launch Library", async (signal) => {
      const r = await refreshLaunches(viaRelay ? "relay" : "direct", { network, signal });
      if (!active || signal.aborted) return;
      setLaunches(r);
      setMessage(r.error ? `LAUNCHES · ${r.error}` : `LAUNCHES · ${r.launches.length} scheduled launches (schedule, not confirmation).`);
    });

  return (
    <div className="wv-panel space-panel" aria-label="Satellites and space">
      <span className="wv-label">SATELLITES &amp; SPACE</span>
      <p className="fine-print">
        <b>FORECAST</b> = computed from orbital elements (not seen). <b>OBSERVED</b> = SatNOGS ground-station radio receptions (not
        optical sightings). <b>SCHEDULED</b> = launch timetable. Cloud data is a weather <b>forecast</b>.
      </p>
      <label className="space-toggle">
        <input type="checkbox" checked={network} disabled={!active} onChange={(e) => { setNetwork(e.target.checked); if (!e.target.checked) { abort.current?.abort(); setBusy(""); setCatalog(null); setCloud(null); setRadio(null); setLaunches(null); } }} /> Allow network reads for this panel
        (CelesTrak, NWS/Open-Meteo, Launch Library, local relay)
      </label>
      <label className="space-toggle"><input type="checkbox" aria-label="Confirm non-commercial Open-Meteo cloud use" checked={openMeteoConsent} onChange={(e) => { setOpenMeteoConsent(e.target.checked); if (!e.target.checked && cloudChoice === "open-meteo") abort.current?.abort(); }} /> I confirm non-commercial use of the optional Open-Meteo cloud API.</label>

      <fieldset>
        <legend>Orbital elements (CelesTrak)</legend>
        <select aria-label="Catalog query type" value={mode} onChange={(e) => setMode(e.target.value as CatalogQuery["kind"])}>
          <option value="catnr">NORAD ID</option>
          <option value="name">Name</option>
          <option value="group">Group</option>
        </select>
        {mode === "group" ? (
          <select aria-label="CelesTrak group" value={group} onChange={(e) => setGroup(e.target.value as CelestrakGroup)}>
            {CELESTRAK_GROUPS.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        ) : (
          <input aria-label="Catalog search" value={term} maxLength={24} onChange={(e) => setTerm(e.target.value)} />
        )}
        <button disabled={!active || !!busy || !network} onClick={loadCatalog}>
          Load elements
        </button>
        {catalog ? <SourceLine meta={catalog} /> : null}
        {catalog?.entries.length ? (
          <select aria-label="Satellite" value={selected ?? ""} onChange={(e) => setSelected(Number(e.target.value))}>
            {catalog.entries.slice(0, 400).map((e) => (
              <option key={e.noradId} value={e.noradId}>
                {e.name} ({e.noradId}) · epoch age {e.elementAgeDays.toFixed(1)} d{e.ageStatus === "current" ? "" : ` · ${e.ageStatus}`}
              </option>
            ))}
          </select>
        ) : null}
        <textarea
          aria-label="Pasted TLE for visibility forecast"
          maxLength={1000}
          value={tle}
          onChange={(e) => setTle(e.target.value)}
          placeholder="…or paste a checksum-valid TLE (used when no CelesTrak object is selected)"
        />
      </fieldset>

      <fieldset>
        <legend>Visibility forecast for observer {observer.lat.toFixed(3)}, {observer.lon.toFixed(3)}</legend>
        <label>
          Min elevation °
          <input type="number" min={0} max={89} value={minEl} onChange={(e) => setMinEl(Number(e.target.value))} />
        </label>
        <label>
          Sun at/below °
          <input type="number" min={-30} max={0} value={maxSun} onChange={(e) => setMaxSun(Number(e.target.value))} />
        </label>
        <label>
          Hours
          <input type="number" min={1} max={VISIBILITY_DEFAULTS.maxHours} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        <label>
          Std. magnitude (optional)
          <input value={stdMag} maxLength={6} placeholder="auto" onChange={(e) => setStdMag(e.target.value)} />
        </label>
        <label>
          Cloud forecast
          <select value={cloudChoice} onChange={(e) => setCloudChoice(e.target.value as CloudChoice)}>
            <option value="nws-skycover">NOAA/NWS skyCover (US)</option>
            <option value="open-meteo">Open-Meteo cloud_cover</option>
            <option value="none">None</option>
          </select>
        </label>
        <button disabled={!active || !!busy} onClick={forecastPasses}>
          Forecast visible passes
        </button>
      </fieldset>

      <p className="source-note" role="status">
        {busy ? `${busy}…` : message}
      </p>

      {forecast ? (
        <div className="space-passes">
          <p className="fine-print">
            <b>{forecast.target.name}</b> · elements epoch {when(forecast.uncertainty.elementEpoch)} ({forecast.uncertainty.elementAgeDays} d,{" "}
            {forecast.uncertainty.status}) · {forecast.uncertainty.note}
          </p>
          {cloud ? <SourceLine meta={cloud} /> : null}
          {forecast.passes.length === 0 && !forecast.refused ? <p className="muted">No passes above {minEl}° forecast in this window.</p> : null}
          {forecast.passes.map((p) => {
            const v = p.visible;
            const c = v ? cloudAt(cloud, Date.parse(v.max.time)) : null;
            return (
              <div className={`provider-row space-pass space-${p.verdict}`} key={p.rise.time}>
                <b>{VERDICT[p.verdict]}</b>
                <small>
                  {when(p.rise.time)} – {time(p.set.time)} · max {p.maxElevationDeg.toFixed(0)}° · sky at culmination: {p.twilightAtCulmination}
                </small>
                {v ? (
                  <small>
                    Visible {time(v.start.time)} (az {v.start.azimuthDeg.toFixed(0)}°, el {v.start.elevationDeg.toFixed(0)}°) → max {time(v.max.time)} (az{" "}
                    {v.max.azimuthDeg.toFixed(0)}°, el {v.max.elevationDeg.toFixed(0)}°) → {time(v.end.time)} (az {v.end.azimuthDeg.toFixed(0)}°, el{" "}
                    {v.end.elevationDeg.toFixed(0)}°{v.end.illumination === "umbra" || v.end.sunlitFraction < 1 ? ", enters shadow" : ""}) ·
                    brightest {v.brightest.magnitude === null ? "magnitude unknown" : `mag ${v.brightest.magnitude.toFixed(1)}`} at {time(v.brightest.time)}
                  </small>
                ) : null}
                {c ? (
                  <small className={c.label === "likely-obscured" ? "space-error" : undefined}>
                    Cloud forecast ({c.provider}): {c.percent === null ? "n/a" : `${c.percent}%`} → {CLOUD_LABEL[c.label]}
                  </small>
                ) : null}
                <small className="muted">
                  {p.magnitudeNote}. Timing uncertainty ~±{p.uncertainty.timingSeconds}s from element age.
                </small>
              </div>
            );
          })}
          <p className="fine-print">
            Model: SGP4 (satellite.js), low-precision solar ephemeris, conical umbra/penumbra on a spherical Earth, no refraction or
            atmospheric extinction. Spot-checked against Skyfield (see docs/worldview-space.md).
          </p>
        </div>
      ) : null}

      <fieldset>
        <legend>Observed: SatNOGS radio observations</legend>
        <button disabled={!active || !!busy || !network} onClick={loadRadio}>
          Recent radio observations
        </button>
        {radio ? <SourceLine meta={radio} /> : null}
        {radio?.observations.map((o) => (
          <div className="provider-row" key={o.id}>
            <b>OBSERVED (radio) · {o.status}</b>
            <small>
              {when(o.start)} – {time(o.end)} · station {o.stationName || o.stationId} · {o.transmitter} {o.mode}
              {o.frequencyHz ? ` · ${(o.frequencyHz / 1e6).toFixed(3)} MHz` : ""} ·{" "}
              <a href={o.url} target="_blank" rel="noreferrer">
                record
              </a>
            </small>
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Scheduled: upcoming launches</legend>
        <label className="space-toggle">
          <input type="checkbox" checked={viaRelay} onChange={(e) => setViaRelay(e.target.checked)} /> Via local server relay (uses
          server-side API key if configured)
        </label>
        <button disabled={!active || !!busy || !network} onClick={loadLaunches}>
          Upcoming launches
        </button>
        {launches ? <SourceLine meta={launches} /> : null}
        {launches?.keyConfigured === false ? <p className="fine-print">Relay API key: not_configured (keyless rate limits apply).</p> : null}
        {launches?.launches.map((l) => (
          <div className="provider-row" key={l.id}>
            <b>SCHEDULED · {l.status}</b>
            <small>
              NET {when(l.net)} · {l.name} · {l.location || l.pad}
            </small>
          </div>
        ))}
      </fieldset>
    </div>
  );
}

export default WorldViewSpace;
