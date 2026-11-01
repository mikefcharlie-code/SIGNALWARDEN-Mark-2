import { useMemo, useState } from "react";
import type { GeoPoint, WorldObservation } from "./worldview-core";
import { analyzeSpatial, isSpatiallyEligible, type SpatialBounds } from "./worldview-spatial";

type Props = { center: GeoPoint; selected: WorldObservation | null; records: WorldObservation[] };
const DEFAULT_BOUNDS: SpatialBounds = { south: 37.5, west: -78.6, north: 40.4, east: -75.3 };
const labels: Array<[keyof SpatialBounds, string]> = [["south", "S"], ["west", "W"], ["north", "N"], ["east", "E"]];

export function WorldViewSpatial({ center, selected, records }: Props) {
  const [boundsInput, setBoundsInput] = useState<Record<keyof SpatialBounds, string>>(
    Object.fromEntries(labels.map(([key]) => [key, String(DEFAULT_BOUNDS[key])])) as Record<keyof SpatialBounds, string>,
  );
  const [route, setRoute] = useState(true);
  const [error, setError] = useState("");
  const parsedBounds = useMemo(() => Object.fromEntries(labels.map(([key]) => [key, boundsInput[key].trim() === "" ? Number.NaN : Number(boundsInput[key])])) as SpatialBounds, [boundsInput]);
  const computed = useMemo(() => {
    try { return { analysis: analyzeSpatial(center, selected && isSpatiallyEligible(selected) ? selected.point : null, parsedBounds, records, route), error: "" }; }
    catch (e) { return { analysis: null, error: e instanceof Error ? e.message : "Spatial analysis failed" }; }
  }, [center, selected, parsedBounds, records, route]);
  const analysis = computed.analysis;
  const update = (key: keyof SpatialBounds, value: string) => {
    setBoundsInput((old) => ({ ...old, [key]: value }));
    const n = value.trim() === "" ? Number.NaN : Number(value);
    if (!Number.isFinite(n)) setError("All bounds must be finite numbers.");
    else if (key === "west" || key === "east") setError(n < -180 || n > 180 ? "Longitude must stay within -180..180; date-line-crossing boxes are rejected." : "");
    else setError(n <= -90 || n >= 90 ? "Bounds may not include a pole." : "");
  };
  return <section className="wv-panel spatial-panel" aria-label="Spatial advisory analysis">
    <div className="panel-head"><span className="wv-label">LOCAL SPATIAL ADVISORY</span><span className="mono">TURF / SIMULATION</span></div>
    <p className="fine-print">Synthetic/local scene records only. No provider or live aircraft data is analyzed; this panel is disconnected from command APIs.</p>
    <div className="spatial-bounds">
      {labels.map(([key, label]) => <label key={key}>{label}<input aria-label={`${key} bound`} type="number" step="any" value={boundsInput[key]} onChange={(e) => update(key, e.target.value)} /></label>)}
    </div>
    <label className="spatial-route"><input type="checkbox" checked={route} onChange={(e) => setRoute(e.target.checked)} /> simulate center → selected route</label>
    {error || computed.error ? <p className="spatial-error">{error || computed.error}</p> : analysis ? <>
      <div className="spatial-stats"><span>SELECTED DISTANCE<strong>{analysis.distanceKm == null ? "—" : `${analysis.distanceKm.toFixed(1)} km`}</strong></span><span>SELECTED IN BOX<strong>{analysis.selectedIntersects == null ? "—" : analysis.selectedIntersects ? "YES" : "NO"}</strong></span><span>ROUTE / BOX<strong>{analysis.routeStatus === "rejected-antimeridian" || analysis.routeStatus === "rejected-polar" ? "REJECTED" : analysis.routeIntersects == null ? "—" : analysis.routeIntersects ? "INTERSECTS" : "DISJOINT"}</strong></span></div>
      {analysis.routeStatus === "rejected-antimeridian" && <p className="spatial-error">Antimeridian route crossing rejected: planar intersection is not globally correct.</p>}
      {analysis.routeStatus === "rejected-polar" && <p className="spatial-error">Polar route endpoint rejected: planar intersection is not globally correct.</p>}
      <div className="spatial-matches"><span className="wv-label">SCENE POINTS IN BOUNDARY ({analysis.matches.length})</span>{analysis.matches.length ? analysis.matches.slice(0, 8).map((m) => <div className="spatial-match" key={m.id}><b>{m.label}</b><small>{m.id} · {m.distanceKm.toFixed(1)} km · {m.source}</small></div>) : <p className="fine-print">No eligible synthetic points intersect this rectangle.</p>}</div>
      {analysis.excludedCount > 0 && <p className="fine-print">{analysis.excludedCount} record(s) excluded by explicit synthetic/local freshness and source policy or invalid coordinates.</p>}
    </> : <p className="spatial-error">Invalid rectangle. Use finite, non-degenerate, non-dateline bounds.</p>}
    <p className="spatial-disclaimer">Advisory geometry only; Turf uses planar line intersection and does not issue commands. <a href="/offline-library-notices.txt" target="_blank" rel="noreferrer">Turf attribution / notices</a></p>
  </section>;
}
