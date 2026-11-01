import { useState } from "react";
import WorldViewSar from "./WorldViewSar";
import WorldViewUmbra from "./WorldViewUmbra";
import WorldViewSarAutoRefresh from "./WorldViewSarAutoRefresh";
import type { GlobeBounds } from "./worldview-globe-viewport";
import type { GlobeImageryLayer, GlobeImageryStatus } from "./worldview-globe-imagery";
import "./worldview-sar.css";

const SOURCE_KEY = "signalwarden.public-imagery.source.v1";
type Source = "" | "asf" | "umbra";
type Props = Readonly<{
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  bounds: readonly GlobeBounds[];
  globeActive: boolean;
  resetKey: number;
  onLayer: (key: string, layer: GlobeImageryLayer | null) => void;
  onStatus: (status: GlobeImageryStatus | null) => void;
}>;
function savedSource(): Source {
  try {
    const value = localStorage.getItem(SOURCE_KEY);
    return value === "asf" || value === "umbra" ? value : "";
  } catch { return ""; }
}
const noop = () => {};
export default function WorldViewSarSources(props: Props = { autoRefresh: false, onAutoRefreshChange: noop, bounds: [], globeActive: false, resetKey: 0, onLayer: noop, onStatus: noop }) {
  const [source, setSource] = useState<Source>(savedSource);
  const selectSource = (value: Source) => {
    setSource(value);
    try { if (value) localStorage.setItem(SOURCE_KEY, value); else localStorage.removeItem(SOURCE_KEY); } catch { /* Selection remains session-local if storage is unavailable. */ }
  };
  return <div className="wv-sar-sources">
    <label>SAR imagery source <select aria-label="SAR imagery source" value={source} onChange={e => selectSource(e.target.value as Source)}>
      <option value="">Choose a source (no provider selected)</option>
      <option value="asf">ASF — Sentinel-1 acquisitions</option>
      <option value="umbra">Umbra — manually selected public SAR data</option>
    </select></label>
    <p>Sources are independent. Selection alone makes no provider request. Switching source cancels the previous workflow and clears that source's globe preview. ASF has a bounded viewport search. Umbra's verified public S3 workflow has no global spatial/date search, so Umbra directory discovery stays manual and is never crawled.</p>
    <label className="sar-opt-in sar-auto-opt-in"><input type="checkbox" checked={props.autoRefresh} onChange={e => props.onAutoRefreshChange(e.target.checked)} /> Enable automatic refresh of the selected ASF source while this globe is visible (saved on this browser)</label>
    <p className="sar-privacy-note">This explicit, persistent permission sends only the camera-visible WGS84 bounding box(es) and a rolling 30-day UTC date range to ASF. It waits for a stable viewport, sends at most two bbox searches for a date-line split, downloads at most one returned browse image, enforces a 60-second minimum request interval and a 15-minute idle cadence, and stops/clears on opt-out, hidden globe, or leaving World View. Provider IP/connection metadata remains visible to ASF. No observations, telemetry, annotations, uploaded files, credentials, or scene context are sent. A previously saved permission does not fetch at application load; opening this panel is required to start the session.</p>
    <WorldViewSarAutoRefresh key={`auto-${props.resetKey}`} enabled={props.autoRefresh} source={source} active={props.globeActive} bounds={props.bounds} onLayer={props.onLayer} onStatus={props.onStatus} />
    {source === "asf" ? <WorldViewSar key={`asf-${props.resetKey}`} onLayer={props.onLayer} /> : source === "umbra" ? <WorldViewUmbra key={`umbra-${props.resetKey}`} onLayer={props.onLayer} /> : <p role="status">Select ASF Sentinel-1 or Umbra to view its public source panel. No provider requests have been made.</p>}
  </div>;
}
