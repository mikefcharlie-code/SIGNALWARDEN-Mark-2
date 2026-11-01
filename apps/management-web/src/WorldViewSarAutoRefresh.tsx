import { useEffect, useRef, useState } from "react";
import { sarFreshness, SAR_ACQUISITION_MAX_AGE_MS } from "./worldview-sar-status";
import type { GlobeBounds } from "./worldview-globe-viewport";
import type { GlobeImageryLayer, GlobeImageryStatus } from "./worldview-globe-imagery";
import { ViewportRefreshController, SAR_VIEWPORT_CADENCE_MS, SAR_VIEWPORT_MIN_INTERVAL_MS } from "./worldview-sar-autorefresh";
import { fetchSarViewportPreview, searchSarViewport } from "./worldview-sar-autofetch";

type Props = Readonly<{
  enabled: boolean;
  source: "" | "asf" | "umbra";
  active: boolean;
  bounds: readonly GlobeBounds[];
  onLayer: (key: string, layer: GlobeImageryLayer | null) => void;
  onStatus: (status: GlobeImageryStatus | null) => void;
}>;
const AUTO_LAYER_KEY = "auto-asf-sentinel";
const iso = (time: number) => new Date(time).toISOString();
const boxLabel = (bounds: readonly GlobeBounds[]) => bounds.map((b) => `[${b.west.toFixed(2)}, ${b.south.toFixed(2)}, ${b.east.toFixed(2)}, ${b.north.toFixed(2)}]`).join(" + ");
const detail = (value: unknown) => value instanceof Error ? value.message.slice(0, 180) : "provider unavailable";

export default function WorldViewSarAutoRefresh(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const currentLayer = useRef<GlobeImageryLayer | null>(null);
  const objectUrl = useRef("");
  const [message, setMessage] = useState("Automatic public imagery refresh is off. No provider request has been made.");
  const [statusTone, setStatusTone] = useState<GlobeImageryStatus["tone"]>("info");
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");

  const publishStatus = (status: GlobeImageryStatus | null) => {
    setMessage(status ? `${status.title}: ${status.detail}` : "Automatic refresh is off; no provider request is active.");
    if (status) setStatusTone(status.tone);
    latest.current.onStatus(status);
  };
  const publishLayer = (layer: GlobeImageryLayer | null) => {
    currentLayer.current = layer;
    latest.current.onLayer(AUTO_LAYER_KEY, layer);
  };
  const clearLayer = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    publishLayer(null);
  };
  const controller = useRef<ViewportRefreshController | null>(null);
  if (!controller.current) {
    controller.current = new ViewportRefreshController({
      refresh: async (bounds, signal) => {
        const now = Date.now();
        const catalog = await searchSarViewport(bounds, signal);
        const scenes = catalog.scenes;
        if (!scenes.length) {
          clearLayer();
          publishStatus({ provider: "ASF Sentinel-1", title: "No coverage returned", detail: `No matching archive acquisition was returned for viewport ${boxLabel(catalog.queryBoxes)} and the rolling 30-day UTC window. This is not proof of no acquisition; no substitute was used.`, tone: "warning" });
          return "no-coverage";
        }
        const scene = catalog.latest!;
        const prior = currentLayer.current;
        const fetchedAt = catalog.fetchedAt || iso(now);
        const freshness = sarFreshness(scene.acquisitionStart, SAR_ACQUISITION_MAX_AGE_MS, now);
        const coverageNote = `ASF footprint intersects requested bbox ${boxLabel(catalog.queryBoxes)}; search bounds can include off-screen edges.`;
        const base: GlobeImageryLayer = {
          key: AUTO_LAYER_KEY,
          provider: "ASF Sentinel-1",
          productId: scene.id,
          acquisitionStart: scene.acquisitionStart,
          retrievedAt: fetchedAt,
          footprint: scene.footprint,
          attribution: scene.attribution,
          license: scene.license,
          freshness,
          refreshState: "current",
          coverageNote,
          registrationNote: "Genuine browse thumbnail pinned to its footprint; thumbnail is not georeferenced or draped on the globe.",
          ...(prior?.productId === scene.id && prior.imageUrl ? { imageUrl: prior.imageUrl } : {}),
        };
        publishLayer(base);
        if (!scene.browseUrl) {
          publishStatus({ provider: "ASF Sentinel-1", title: "Footprint found; no browse asset", detail: `${scene.id} has no eligible public browse asset. Coverage is shown as an outline only; metadata retrieved ${fetchedAt}.`, tone: "warning" });
          return "updated";
        }
        try {
          const blob = await fetchSarViewportPreview(scene, signal);
          if (!blob) {
            publishStatus({ provider: "ASF Sentinel-1", title: "Footprint found; no browse asset", detail: `${scene.id} has no eligible public browse asset. Coverage is shown as an outline only; metadata retrieved ${fetchedAt}.`, tone: "warning" });
            return "updated";
          }
          const nextUrl = URL.createObjectURL(blob);
          if (objectUrl.current && objectUrl.current !== nextUrl) URL.revokeObjectURL(objectUrl.current);
          objectUrl.current = nextUrl;
          publishLayer({ ...base, imageUrl: nextUrl });
          const age = freshness === "recent" ? "acquisition is within the 72-hour display threshold (not real-time)" : freshness === "stale" ? "historical acquisition is older than 72 hours" : "acquisition age is unknown";
          publishStatus({ provider: "ASF Sentinel-1", title: freshness === "stale" ? "Historical image refreshed" : freshness === "unknown" ? "Image refreshed; age unknown" : "Image refreshed", detail: `Retrieved ${fetchedAt}; ${age}. Coverage outline and thumbnail are shown on the globe. ${catalog.possiblyTruncated ? "Result cap reached; archive completeness is not guaranteed." : ""}`, tone: freshness === "stale" || freshness === "unknown" ? "warning" : "info" });
        } catch (error) {
          if (signal.aborted) throw error;
          if (prior?.productId === scene.id && prior.imageUrl) publishLayer({ ...prior, refreshState: "retained-failed" });
          else {
            if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
            objectUrl.current = "";
            publishLayer({ ...base, refreshState: "retained-failed" });
          }
          throw error;
        }
        return "updated";
      },
      onState: (state, error) => {
        const p = latest.current;
        if (state === "stopped") {
          if (!p.enabled) publishStatus(null);
          else if (p.source === "umbra") publishStatus({ provider: "Umbra Open Data", title: "Automatic viewport search unavailable", detail: "The verified public S3 workflow has no global spatial/date search. No automatic Umbra request is made; a manually loaded asset can still appear on the globe when its footprint is visible.", tone: "warning" });
          else if (p.source === "asf") publishStatus({ provider: "ASF Sentinel-1", title: "Refresh paused", detail: "The globe is off-screen or the browser is hidden. The saved preference remains on, but no provider read occurs until the globe is visible again.", tone: "info" });
          return;
        }
        if (state === "no-viewport") publishStatus({ provider: "ASF Sentinel-1", title: "Waiting for visible globe bounds", detail: "No valid camera/frustum intersection is available yet; no provider request was sent.", tone: "warning" });
        else if (state === "scheduled") publishStatus({ provider: "ASF Sentinel-1", title: "Viewport refresh scheduled", detail: `One debounced request; minimum interval ${Math.round(SAR_VIEWPORT_MIN_INTERVAL_MS / 1000)} seconds, then ${Math.round(SAR_VIEWPORT_CADENCE_MS / 60_000)}-minute cadence. Only the visible globe bbox and rolling UTC dates are sent.`, tone: "info" });
        else if (state === "loading") publishStatus({ provider: "ASF Sentinel-1", title: "Refreshing visible viewport", detail: `Searching only bbox ${boxLabel(p.bounds)}. At most two date-line-split bbox requests; one browse image at most. No observations, telemetry, annotations, files or scene context are sent.`, tone: "info" });
        else if (state === "failed") {
          const prior = currentLayer.current;
          if (prior) publishLayer({ ...prior, refreshState: "retained-failed" });
          const retained = currentLayer.current;
          const retainedDetail = retained?.imageUrl
            ? `A matching preview remains explicitly marked as retained with its original acquisition time and source. ${detail(error)}. No fallback or fabricated image was used.`
            : retained
              ? `The provider footprint for ${retained.productId} remains as metadata only; no browse image is displayed. ${detail(error)}. No fallback or fabricated image was used.`
              : `${detail(error)}. No imagery fallback or fabricated image was used.`;
          publishStatus({ provider: "ASF Sentinel-1", title: "Refresh failed; retained state labeled", detail: retainedDetail, tone: "error" });
        }
      },
      clear: clearLayer,
    });
  }

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    const active = props.active && visible;
    if (props.enabled && props.source === "umbra") {
      controller.current?.configure({ enabled: false, sourceSelected: false, active, bounds: props.bounds });
      publishStatus({ provider: "Umbra Open Data", title: "Automatic viewport search unavailable", detail: "Umbra's verified public S3 workflow has no global spatial/date search. No automatic Umbra requests are made. Select and load an asset manually; its footprint and thumbnail can then appear on the globe.", tone: "warning" });
      return;
    }
    if (props.enabled && props.source === "") {
      controller.current?.configure({ enabled: false, sourceSelected: false, active, bounds: props.bounds });
      publishStatus({ provider: "Public imagery", title: "Choose a source", detail: "The automatic-refresh preference is saved, but no provider is selected. No provider request has been made.", tone: "info" });
      return;
    }
    if (props.enabled && props.source === "asf" && !active) {
      controller.current?.configure({ enabled: true, sourceSelected: true, active: false, bounds: props.bounds });
      publishStatus({ provider: "ASF Sentinel-1", title: "Refresh paused", detail: "The globe is off-screen or the browser is hidden. The saved preference remains on, but no provider read occurs until the globe is visible again.", tone: "info" });
      return;
    }
    controller.current?.configure({ enabled: props.enabled, sourceSelected: props.source === "asf", active, bounds: props.bounds });
    if (!props.enabled) publishStatus(null);
  }, [props.enabled, props.source, props.active, props.bounds, visible]);

  useEffect(() => () => {
    controller.current?.dispose();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    latest.current.onLayer(AUTO_LAYER_KEY, null);
    latest.current.onStatus(null);
  }, []);

  return <p role="status" className={`sar-auto-status tone-${statusTone}`}>{message}</p>;
}
