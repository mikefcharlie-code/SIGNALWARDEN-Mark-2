import { useEffect, useRef, useState } from "react";
import type { GeoPoint, WorldObservation } from "./worldview-core";
import {
  areaBounds, ageFreshness, cameraObservations, coverageIncludes, fetchCatalog, fetchProviders, fetchSnapshot, fetchTomTom,
  formatAge, hotlinkUrl, trafficObservations, CATALOG_STALE_MS, OBSERVATION_PREFIX, RelayError, SNAPSHOT_STALE_MS,
  TOMTOM_MAX_RADIUS_KM, type Camera, type CameraCatalog, type ProviderListing, type TrafficResult,
} from "./worldview-public-traffic";
import "./worldview-public-traffic.css";

type Props = Readonly<{
  center: GeoPoint;
  network: boolean;
  active?: boolean;
  selectedId?: string | null;
  onObservations?: (prefix: string, observations: WorldObservation[]) => void;
}>;
type Shown = { kind: "relay"; url: string; imageTime: string | null; imageTimeSource: string; retrievedAt: string; sourceUrl: string }
  | { kind: "hotlink"; url: string; loadedAt: string };

const RADII = [10, 25, 50, 100, 150];
const describe = (e: unknown): string => {
  if (e instanceof RelayError) {
    if (e.code === "not_configured") return `NOT CONFIGURED · ${e.message}`;
    if (e.code === "public_traffic_disabled") return "RELAY DISABLED · the local API needs UCAS_PUBLIC_TRAFFIC_ENABLED=1 and /api/v1/public-traffic routed to it";
    return `FAILED · ${e.message}`;
  }
  return `FAILED · ${e instanceof Error ? e.message : "request failed"}`;
};
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace(".000Z", "Z") : "not provided");

export default function WorldViewPublicTraffic({ center, network, active = false, selectedId, onObservations }: Props) {
  const [listing, setListing] = useState<ProviderListing | null>(null);
  const [providerId, setProviderId] = useState("");
  const [radius, setRadius] = useState(25);
  const [catalog, setCatalog] = useState<CameraCatalog | null>(null);
  const [cameraId, setCameraId] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [traffic, setTraffic] = useState<TrafficResult | null>(null);
  const [busy, setBusy] = useState<"" | "providers" | "catalog" | "snapshot" | "traffic">("");
  const [message, setMessage] = useState("Idle. No relay or provider requests have been made.");
  const [trafficMessage, setTrafficMessage] = useState("Idle. TomTom is only queried on request.");
  const [clock, setClock] = useState(Date.now());
  const emit = useRef(onObservations);
  emit.current = onObservations;
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const blob = useRef("");

  const dropImage = () => {
    if (blob.current) URL.revokeObjectURL(blob.current);
    blob.current = "";
    setShown(null);
  };
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => {
      clearInterval(t);
      request.current?.abort();
      if (blob.current) URL.revokeObjectURL(blob.current);
      emit.current?.(OBSERVATION_PREFIX.cameras, []);
      emit.current?.(OBSERVATION_PREFIX.traffic, []);
    };
  }, []);
  // Re-label markers stale once their catalog / traffic read ages out.
  useEffect(() => {
    if (catalog) emit.current?.(OBSERVATION_PREFIX.cameras, cameraObservations(catalog, clock));
  }, [catalog, clock]);
  useEffect(() => {
    if (traffic) emit.current?.(OBSERVATION_PREFIX.traffic, trafficObservations(traffic, clock));
  }, [traffic, clock]);
  // Selecting one of our camera markers on the globe selects it here (no fetch).
  useEffect(() => {
    if (!catalog || !selectedId?.startsWith(`${OBSERVATION_PREFIX.cameras}${catalog.provider}-`)) return;
    const id = selectedId.slice(`${OBSERVATION_PREFIX.cameras}${catalog.provider}-`.length);
    if (catalog.cameras.some((c) => c.id === id) && id !== cameraId) { setCameraId(id); dropImage(); }
  }, [selectedId, catalog, cameraId]);

  const begin = (kind: typeof busy) => {
    request.current?.abort();
    generation.current += 1;
    const c = new AbortController();
    request.current = c;
    setBusy(kind);
    return c;
  };
  const guard = () => {
    if (!active) { setMessage("Public traffic is inactive while this globe view is closed."); return false; }
    if (!network) { setMessage("Enable network opt-in in WorldView before requesting public traffic data."); return false; }
    return true;
  };

  const providers = listing?.cameraProviders ?? [];
  const provider = providers.find((p) => p.id === providerId);
  const camera: Camera | undefined = catalog?.cameras.find((c) => c.id === cameraId);
  let bbox: ReturnType<typeof areaBounds> | null = null;
  try { bbox = areaBounds(center, radius); } catch { bbox = null; }

  const loadProviders = async () => {
    if (!guard()) return;
    const c = begin("providers");
    const requestGeneration = generation.current;
    try {
      const result = await fetchProviders(fetch, c.signal);
      if (c.signal.aborted || requestGeneration !== generation.current || !active || !network) return;
      setListing(result);
      setMessage(`Relay lists ${result.cameraProviders.length} camera providers. Choose one; no provider has been queried yet.`);
    } catch (e) {
      if (!c.signal.aborted && requestGeneration === generation.current && active && network) setMessage(describe(e));
    } finally { if (request.current === c && requestGeneration === generation.current) setBusy(""); }
  };
  const loadCatalog = async () => {
    if (!guard() || !provider || !bbox) return;
    if (provider.status !== "available") { setMessage(provider.status === "not_configured" ? `NOT CONFIGURED · set ${provider.keyEnv} on the server` : "Provider disabled on the server"); return; }
    const c = begin("catalog");
    const requestGeneration = generation.current;
    setMessage(`Requesting ${provider.name} catalog for ±${radius} km around the view centre…`);
    try {
      const result = await fetchCatalog(provider.id, bbox, fetch, c.signal);
      if (c.signal.aborted || requestGeneration !== generation.current || !active || !network) return;
      dropImage(); setCameraId(""); setCatalog(result); setClock(Date.now());
      setMessage(result.status === "out_of_coverage"
        ? `${provider.name} does not cover this area (${provider.region}). No request was sent to the authority.`
        : `${result.cameras.length} of ${result.totalInArea} cameras in the area${result.truncated ? " (nearest 300 shown)" : ""}. Select one and load its snapshot.`);
    } catch (e) {
      if (c.signal.aborted || requestGeneration !== generation.current || !active || !network) return;
      setMessage(`${describe(e)}${catalog ? " · previous catalog kept and marked by age" : ""}`);
    } finally { if (request.current === c && requestGeneration === generation.current) setBusy(""); }
  };
  const loadSnapshot = async () => {
    if (!guard() || !catalog || !camera || !provider) return;
    dropImage();
    if (catalog.snapshotMode === "hotlink") {
      const url = hotlinkUrl(provider, camera);
      if (!url) { setMessage("No allowlisted frame URL for this camera."); return; }
      setShown({ kind: "hotlink", url, loadedAt: new Date().toISOString() });
      setMessage("Frame loads directly from the authority's image host in your browser (not relayed). The authority does not publish a frame time.");
      return;
    }
    const c = begin("snapshot");
    const requestGeneration = generation.current;
    try {
      const snap = await fetchSnapshot(catalog.provider, camera.id, fetch, c.signal);
      if (c.signal.aborted || requestGeneration !== generation.current || !active || !network) return;
      const url = URL.createObjectURL(new Blob([snap.bytes as BlobPart], { type: snap.mime }));
      blob.current = url;
      setShown({ kind: "relay", url, imageTime: snap.imageTime, imageTimeSource: snap.imageTimeSource, retrievedAt: snap.retrievedAt, sourceUrl: snap.sourceUrl });
      setClock(Date.now());
      setMessage("Snapshot loaded through the local relay for display only.");
    } catch (e) {
      if (!c.signal.aborted && requestGeneration === generation.current && active && network) setMessage(describe(e));
    } finally { if (request.current === c && requestGeneration === generation.current) setBusy(""); }
  };
  const loadTraffic = async () => {
    if (!active) { setTrafficMessage("Public traffic is inactive while this globe view is closed."); return; }
    if (!network) { setTrafficMessage("Enable network opt-in in WorldView first."); return; }
    let box;
    try { box = areaBounds(center, Math.min(radius, TOMTOM_MAX_RADIUS_KM)); } catch { setTrafficMessage("Invalid view centre."); return; }
    const c = begin("traffic");
    const requestGeneration = generation.current;
    setTrafficMessage("Requesting TomTom incidents and centre flow segment…");
    try {
      const result = await fetchTomTom(box, fetch, c.signal);
      if (c.signal.aborted || requestGeneration !== generation.current || !active || !network) return;
      setTraffic(result); setClock(Date.now());
      setTrafficMessage(`${result.incidents.length} incident(s)${result.truncated ? " (truncated)" : ""}; ${result.flow ? "flow segment found" : "no flow segment near the centre"}.`);
    } catch (e) {
      if (!c.signal.aborted && requestGeneration === generation.current && active && network) setTrafficMessage(describe(e) + (traffic ? " · previous result kept and marked by age" : ""));
    } finally { if (request.current === c && requestGeneration === generation.current) setBusy(""); }
  };
  const clearAll = () => {
    generation.current += 1;
    request.current?.abort(); request.current = null; setBusy(""); dropImage(); setCatalog(null); setCameraId(""); setTraffic(null);
    setListing(null); setProviderId("");
    emit.current?.(OBSERVATION_PREFIX.cameras, []); emit.current?.(OBSERVATION_PREFIX.traffic, []);
    setMessage("Cleared. Markers removed; nothing is retained."); setTrafficMessage("Cleared.");
  };

  useEffect(() => {
    if (active && network) return;
    clearAll();
    if (!active) setMessage("Public traffic is inactive while this globe view is closed.");
    else setMessage("Enable network opt-in in WorldView before requesting public traffic data.");
  }, [active, network]);

  const catalogAge = catalog ? ageFreshness(catalog.retrievedAt, CATALOG_STALE_MS, clock) : null;
  const imageAge = shown?.kind === "relay" ? ageFreshness(shown.imageTime, SNAPSHOT_STALE_MS, clock) : null;
  const trafficAge = traffic ? ageFreshness(traffic.retrievedAt, CATALOG_STALE_MS, clock) : null;

  return (
    <section className="wv-public-traffic" aria-label="Public traffic cameras and traffic">
      <h3>Public traffic cameras &amp; traffic</h3>
      <p className="wv-pt-note">
        Read-only. Requests go only to the local relay (disabled unless the server sets <code>UCAS_PUBLIC_TRAFFIC_ENABLED=1</code>), which reads public
        road-authority catalogs and, for one selected camera at a time, its current snapshot. Keys stay on the server. Snapshots are displayed only —
        no plate reading, face recognition, image analysis or tracking across cameras. Camera positions are coarse; heading is not modelled.
      </p>
      <div className="wv-pt-row">
        <button onClick={loadProviders} disabled={!!busy}>{listing ? "Reload provider list" : "Load provider list"}</button>
        <label>Provider <select aria-label="Camera provider" value={providerId} onChange={(e) => { setProviderId(e.target.value); setCatalog(null); setCameraId(""); dropImage(); emit.current?.(OBSERVATION_PREFIX.cameras, []); }}>
          <option value="">Choose a provider</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={p.status !== "available"}>
              {p.name} — {p.region}{p.status === "not_configured" ? ` (not configured: ${p.keyEnv})` : p.status === "disabled" ? " (disabled)" : ""}
            </option>
          ))}
        </select></label>
        <label>Area <select aria-label="Area radius" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
          {RADII.map((r) => <option key={r} value={r}>±{r} km</option>)}
        </select></label>
        <button onClick={loadCatalog} disabled={!!busy || !provider || provider.status !== "available"}>Load cameras in area</button>
        <button onClick={clearAll} disabled={!catalog && !traffic}>Clear</button>
      </div>
      {provider && (
        <p className="wv-pt-meta">
          {provider.authority} · {provider.attribution} · <a href={provider.termsUrl} target="_blank" rel="noreferrer noopener">terms</a> · {provider.verified}
          {bbox && !coverageIncludes(provider, bbox) ? " · view centre is outside this provider's coverage" : ""}
        </p>
      )}
      <p role="status" className="wv-pt-status">{busy ? `Working (${busy})… ` : ""}{message}</p>
      {catalog && catalog.status === "ok" && (
        <div className="wv-pt-catalog">
          <p className={`wv-pt-fresh ${catalogAge?.freshness}`}>
            CATALOG {catalogAge?.freshness?.toUpperCase()} · retrieved {when(catalog.retrievedAt)} ({formatAge(catalogAge?.ageSeconds ?? null)}) · provider update {when(catalog.providerUpdatedAt)} · {catalog.attribution} · {catalog.license}
          </p>
          <ul className="wv-pt-list">
            {catalog.cameras.slice(0, 60).map((c) => (
              <li key={c.id}>
                <button aria-pressed={c.id === cameraId} onClick={() => { setCameraId(c.id); dropImage(); }}>
                  {c.name}{c.road ? ` · ${c.road}` : ""}{c.direction ? ` · ${c.direction}` : ""}
                </button>
              </li>
            ))}
          </ul>
          {catalog.cameras.length > 60 && <p className="wv-pt-meta">Showing 60 nearest in the list; all {catalog.cameras.length} are on the globe.</p>}
        </div>
      )}
      {camera && catalog && (
        <div className="wv-pt-camera">
          <p><b>{camera.name}</b> · {camera.lat.toFixed(5)}, {camera.lon.toFixed(5)} (coarse) · {camera.authority}</p>
          <button onClick={loadSnapshot} disabled={!!busy || !camera.snapshotUrl}>{shown ? "Refresh snapshot" : "Load snapshot"}</button>
          {!camera.snapshotUrl && <span> No snapshot published for this camera.</span>}
          {shown && (
            <figure>
              <img src={shown.url} alt={`Authority snapshot: ${camera.name}`} referrerPolicy="no-referrer" />
              <figcaption>
                {shown.kind === "relay"
                  ? <>IMAGE {imageAge?.freshness.toUpperCase()} · image time {when(shown.imageTime)} ({shown.imageTimeSource}; {formatAge(imageAge?.ageSeconds ?? null)}) · retrieved {when(shown.retrievedAt)} · <a href={shown.sourceUrl} target="_blank" rel="noreferrer noopener">source</a></>
                  : <>IMAGE AGE UNKNOWN · loaded {when(shown.loadedAt)} directly from the authority · <a href={shown.url} target="_blank" rel="noreferrer noopener">source</a></>}
                {" "}· {catalog.attribution}. Display only.
              </figcaption>
            </figure>
          )}
        </div>
      )}
      <div className="wv-pt-traffic">
        <h4>TomTom live traffic</h4>
        <p className="wv-pt-meta">
          {listing ? (listing.traffic.status === "available" ? "Configured on the server." : `NOT CONFIGURED · set ${listing.traffic.keyEnv} on the server.`) : "Load the provider list to see configuration."}
          {" "}Incidents in the area (capped at ±{TOMTOM_MAX_RADIUS_KM} km ≈ 10,000 km²) plus the flow segment nearest the centre. Aggregate traffic, not vehicle tracking.
        </p>
        <button onClick={loadTraffic} disabled={!!busy || listing?.traffic.status === "not_configured"}>Load TomTom traffic in area</button>
        <p role="status" className="wv-pt-status">{trafficMessage}</p>
        {traffic && (
          <>
            <p className={`wv-pt-fresh ${trafficAge?.freshness}`}>TRAFFIC {trafficAge?.freshness?.toUpperCase()} · retrieved {when(traffic.retrievedAt)} ({formatAge(trafficAge?.ageSeconds ?? null)}) · {traffic.attribution}</p>
            {traffic.flow && <p>Flow near centre: {Math.round(traffic.flow.currentSpeedKmh)} km/h vs {Math.round(traffic.flow.freeFlowSpeedKmh)} km/h free-flow{traffic.flow.roadClosure ? " · road closed" : ""}{traffic.flow.confidence !== null ? ` · confidence ${traffic.flow.confidence.toFixed(2)}` : ""}</p>}
            <ul className="wv-pt-list">
              {traffic.incidents.slice(0, 40).map((i) => (
                <li key={i.id}>{i.category}{i.description ? ` — ${i.description}` : ""}{i.roadNumbers ? ` · ${i.roadNumbers}` : ""}{i.delaySeconds !== null ? ` · delay ${Math.round(i.delaySeconds / 60)} min` : ""} · reported {when(i.lastReportTime ?? i.startTime)}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
