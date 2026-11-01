import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorldObservation,
  GeoPoint,
  Scene,
  SceneLayer,
  Annotation,
  DirectorKeyframe,
  ProviderResult,
} from "./worldview-core";
import {
  LAYER_IDS,
  createDemoObservations,
  queryObservations,
  countByLayer,
  searchCities,
  encodeScene,
  decodeScene,
  exportObservationPack,
  importObservationPack,
  replayAt,
  refreshUsgsEarthquakes,
  refreshNoaaWeather,
  providerStatus,
  PROVIDER_MATRIX,
} from "./worldview-core";
import "./worldview.css";
import { WorldGlobe } from "./WorldGlobe";
import { parseTle, predictPasses, satellitePosition } from "./worldview-orbits";
import { findLocalPlace, directorAt } from "./worldview-scene-runtime";
import { refreshAdsb } from "./worldview-open-feeds";
import { WorldViewAnalyst } from "./WorldViewAnalyst";
import { parseAnalystVoice, type AnalystContext } from "./worldview-analyst";
import { WorldViewSpatial } from "./WorldViewSpatial";
import type { GlobeBounds } from "./worldview-globe-viewport";
import type { GlobeImageryLayer, GlobeImageryStatus } from "./worldview-globe-imagery";

const WorldViewSar = lazy(() => import("./WorldViewSarSources"));
const AUTO_IMAGERY_PREF_KEY = "signalwarden.public-imagery.auto-refresh.v1";
const readAutoImageryPreference = () => {
  try { return localStorage.getItem(AUTO_IMAGERY_PREF_KEY) === "true"; }
  catch { return false; }
};

const WorldViewLocalLayers = lazy(async () => {
  const module = await import("./WorldViewLocalLayers");
  await module.prepareLocalLayers();
  return module;
});

type Center = GeoPoint;
type Props = {
  records?: WorldObservation[];
  center?: Center;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onCenter?: (center: Center) => void;
  style?: string;
  detection?: boolean;
  tilt?: boolean;
  zoom?: number;
  onStyleChange?: (style: string) => void;
  onDetectionChange?: (v: boolean) => void;
  onTiltChange?: (v: boolean) => void;
  onZoomChange?: (v: number) => void;
};
type Row = {
  raw: WorldObservation;
  id: string;
  name: string;
  kind: string;
  source: string;
  c: Center;
};
const STYLES = ["Standard", "CRT", "NVG", "FLIR", "Noir", "Snow"];
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "0.000");
const km = (a: Center, b: Center) => {
  const r = Math.PI / 180,
    dLat = (b.lat - a.lat) * r,
    dLon = (b.lon - a.lon) * r,
    q =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371.0088 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)));
};
const download = (name: string, body: string, type = "application/json") => {
  const u = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 0);
};

export function WorldView(props: Props) {
  const [localLayersOpen, setLocalLayersOpen] = useState(false);
  const [sarOpen, setSarOpen] = useState(false);
  const [sarEverOpened, setSarEverOpened] = useState(false);
  const [sarAutoRefresh, setSarAutoRefresh] = useState(readAutoImageryPreference);
  const [sarResetKey, setSarResetKey] = useState(0);
  const [globeActive, setGlobeActive] = useState(true);
  const [viewportBounds, setViewportBounds] = useState<GlobeBounds[]>([]);
  const [globeImagery, setGlobeImagery] = useState<Record<string, GlobeImageryLayer>>({});
  const [imageryStatus, setImageryStatus] = useState<GlobeImageryStatus | null>(null);
  const globeSlotRef = useRef<HTMLDivElement>(null);
  const [records, setRecords] = useState<WorldObservation[]>(() =>
    props.records?.length ? props.records : createDemoObservations(),
  );
  const [center, setCenter] = useState<Center>(
    props.center ?? { lat: 38.9072, lon: -77.0369 },
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    props.selectedId ?? null,
  );
  const [style, setStyle] = useState(props.style ?? "Standard"),
    [detection, setDetection] = useState(props.detection ?? false),
    [tilt, setTilt] = useState(props.tilt ?? false),
    [zoom, setZoom] = useState(Math.max(0.65, Math.min(1.8, props.zoom ?? 1)));
  const [query, setQuery] = useState(""),
    [command, setCommand] = useState(""),
    [notice, setNotice] = useState("");
  const [layers, setLayers] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(LAYER_IDS.map((x) => [x, true])),
  );
  const [annotations, setAnnotations] = useState<Annotation[]>([]),
    [keyframes, setKeyframes] = useState<DirectorKeyframe[]>([]);
  const [playing, setPlaying] = useState(false),
    [replaying, setReplaying] = useState(false),
    [timeMs, setTimeMs] = useState(0);
  const [providerResults, setProviderResults] = useState<
      Record<string, ProviderResult>
    >({}),
    [network, setNetwork] = useState(false),
    [voiceOptIn, setVoiceOptIn] = useState(false),
    [listening, setListening] = useState(false),
    [tleText, setTleText] = useState(""),
    [passes, setPasses] = useState<ReturnType<typeof predictPasses>>([]);
  const [observationHistory, setHistory] = useState<WorldObservation[]>([]);
  const [passContext, setPassContext] = useState<{
    lat: number;
    lon: number;
    calculatedAt: string;
    tleEpoch?: string;
  } | null>(null);
  const recognition = useRef<any>(null);
  const savedView = useRef<{
    center: Center;
    zoom: number;
    tilt: boolean;
    layers: Record<string, boolean>;
  } | null>(null);
  const [globalContext, setGlobalContext] = useState(false),
    [paused, setPaused] = useState(false),
    [tracking, setTracking] = useState(false),
    [radius, setRadius] = useState(250);
  const [busy, setBusy] = useState(false),
    [clock, setClock] = useState(Date.now());
  const receiveImageryLayer = useCallback((key: string, layer: GlobeImageryLayer | null) => {
    setGlobeImagery((previous) => {
      const next = { ...previous };
      if (layer) next[key] = layer;
      else delete next[key];
      return next;
    });
  }, []);
  const receiveImageryStatus = useCallback((status: GlobeImageryStatus | null) => setImageryStatus(status), []);
  const receiveViewport = useCallback((bounds: GlobeBounds[]) => setViewportBounds(bounds), []);
  const setAutoImageryPermission = useCallback((enabled: boolean) => {
    setSarAutoRefresh(enabled);
    try { localStorage.setItem(AUTO_IMAGERY_PREF_KEY, String(enabled)); } catch { /* Preference remains session-local if storage is unavailable. */ }
    if (!enabled) {
      setSarResetKey((value) => value + 1);
      setGlobeImagery({});
      setImageryStatus({ provider: "Public imagery", title: "Automatic reads disabled", detail: "Any in-memory globe imagery is cleared; active browser requests are cancelled. Re-enable explicitly to resume.", tone: "info" });
    }
  }, []);
  useEffect(() => {
    const target = globeSlotRef.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") { setGlobeActive(true); return; }
    const observer = new IntersectionObserver((entries) => setGlobeActive(Boolean(entries[0]?.isIntersecting && entries[0].intersectionRatio >= 0.25)), { threshold: [0, 0.25] });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const now = useMemo(() => Date.now(), []);
  const replaySamples = useMemo(
    () =>
      createDemoObservations(new Date(now)).flatMap((r, i) => [
        {
          ...r,
          observedAt: new Date(now).toISOString(),
          label: `${r.label} · SYNTHETIC REPLAY`,
        },
        {
          ...r,
          observedAt: new Date(now + 120000).toISOString(),
          point: {
            ...r.point,
            lat: Math.max(
              -90,
              Math.min(90, r.point.lat + Math.sin(i + 1) * 0.18),
            ),
            lon: ((r.point.lon + Math.cos(i + 1) * 0.25 + 540) % 360) - 180,
          },
          label: `${r.label} · SYNTHETIC REPLAY`,
        },
      ]),
    [now],
  );
  const shownRecords = replaying
    ? replayAt(replaySamples, now + timeMs).map((r) => ({
        ...r,
        id: r.id.split("@")[0],
        freshness: "synthetic" as const,
        source: "SignalWarden synthetic replay",
      }))
    : records;
  const rows = useMemo<Row[]>(
    () =>
      shownRecords.map((input) => {
        const raw = { ...input };
        const age = Math.max(clock, Date.now()) - Date.parse(raw.observedAt);
        if (
          raw.freshness === "fresh" &&
          ((raw.source === "adsb.lol" && age > 120000) ||
            (raw.source === "NOAA/NWS weather.gov" &&
              Date.parse(String(raw.properties?.validTo ?? "")) <
                Math.max(clock, Date.now())))
        )
          raw.freshness = "stale";
        return {
          raw,
          id: raw.id,
          name: raw.label || raw.title || raw.id,
          kind: raw.layer,
          source: raw.source,
          c: raw.point,
        };
      }),
    [shownRecords, clock],
  );
  const activeRows = useMemo(
    () => rows.filter((r) => layers[r.kind] !== false),
    [rows, layers],
  );
  const filtered = useMemo(() => {
    const q = query.trim();
    const found = q
      ? queryObservations(
          activeRows.map((x) => x.raw),
          { text: q, origin: center, maxDistanceKm: radius, limit: 80 },
        )
      : queryObservations(
          activeRows.map((x) => x.raw),
          { origin: center, maxDistanceKm: radius, limit: 80 },
        );
    return found
      .map((raw) => rows.find((r) => r.id === raw.id)!)
      .filter(Boolean);
  }, [activeRows, query, center, rows, radius]);
  const selected = activeRows.find((r) => r.id === selectedId) ?? filtered[0];
  const counts = countByLayer(activeRows.map((r) => r.raw));
  const syncCenter = (c: Center) => {
    setCenter(c);
    props.onCenter?.(c);
  };
  const syncSelect = (id: string) => {
    setSelectedId(id);
    props.onSelect?.(id);
  };
  useEffect(() => {
    if ((!playing && !replaying) || paused) return;
    const started = Date.now() - timeMs;
    const timer = window.setInterval(() => {
      const duration = playing
        ? Math.max(1000, ...keyframes.map((k) => k.atMs))
        : 120000;
      const elapsed = (Date.now() - started) % duration;
      setTimeMs(elapsed);
      if (playing) {
        const pose = directorAt(keyframes, elapsed);
        if (pose) {
          syncCenter(pose.center);
          setZoom(Math.max(0.65, Math.min(1.8, pose.zoom)));
        }
      }
    }, 100);
    return () => clearInterval(timer);
  }, [playing, replaying, paused, keyframes]);
  useEffect(() => {
    if (tracking && selectedId) {
      const contact = shownRecords.find((r) => r.id === selectedId);
      if (contact) setCenter(contact.point);
    }
  }, [tracking, selectedId, shownRecords]);

  useEffect(() => () => recognition.current?.stop?.(), []);
  useEffect(() => {
    const raw = new URLSearchParams(location.search).get("scene");
    if (!raw) return;
    try {
      const s = decodeScene(raw);
      syncCenter(s.center);
      setZoom(Math.max(0.65, Math.min(1.8, s.zoom)));
      setStyle(s.style === "standard" ? "Standard" : (s.style ?? "Standard"));
      setDetection(!!s.detection);
      setTilt(!!s.tilt);
      setSelectedId(s.selectedId ?? null);
      setAnnotations(s.annotations);
      setKeyframes(s.keyframes);
      setLayers(
        Object.fromEntries(
          LAYER_IDS.map((id) => [
            id,
            s.layers.find((x) => x.layer === id)?.visible ?? true,
          ]),
        ),
      );
    } catch {
      setNotice("SCENE · invalid URL state ignored");
    }
  }, []);
  const runCommand = () => {
    const raw = command.trim(),
      c = raw.toLowerCase();
    if (!raw) return;
    try {
      if (c.startsWith("search ")) {
        const q = raw.slice(7);
        setQuery(q);
        const p = findLocalPlace(q);
        if (p) {
          syncCenter(p);
          setQuery("");
        }
        setNotice(`SEARCH · ${q}`);
      } else if (c === "count" || c.startsWith("count ")) {
        const term = raw.slice(5).trim();
        const matches = queryObservations(
          activeRows.map((x) => x.raw),
          {
            ...(term ? { text: term } : {}),
            origin: center,
            maxDistanceKm: radius,
          },
        );
        setNotice(
          `COUNT · ${matches.length} matching records within ${radius === Infinity ? "global scope" : `${radius} km`}`,
        );
      } else if (c.startsWith("filter ")) {
        const q = raw.slice(7);
        setQuery(q);
        setNotice(
          `FILTER · ${
            queryObservations(
              activeRows.map((x) => x.raw),
              { text: q },
            ).length
          } matches`,
        );
      } else if (c.startsWith("rank")) {
        const ranked = [...filtered].sort(
          (a, b) =>
            (b.raw.confidence ?? 0) - (a.raw.confidence ?? 0) ||
            Date.parse(b.raw.observedAt) - Date.parse(a.raw.observedAt),
        );
        if (ranked[0]) syncSelect(ranked[0].id);
        setNotice("RANK · selected highest-confidence visible record");
      } else if (c.startsWith("annotate ")) {
        const text = raw.slice(9).trim();
        if (!text) throw new Error("annotation text required");
        setAnnotations((x) =>
          [
            ...x,
            {
              id: `annotation-${Date.now()}`,
              point: center,
              text,
              createdAt: new Date().toISOString(),
            },
          ].slice(-50),
        );
        setNotice(`ANNOTATION · ${fmt(center.lat)}, ${fmt(center.lon)}`);
      } else if (c === "reset" || c === "reset globe") {
        syncCenter({ lat: 0, lon: 0 });
        setZoom(1);
        setTilt(false);
        setTracking(false);
        setNotice("GLOBE · reset north up");
      } else if (c === "north up") {
        setTilt(false);
        setNotice("VIEW · north up");
      } else if (c === "weather")
        setNotice(
          "WEATHER · enable network opt-in, then use Refresh NOAA in provider panel",
        );
      else if (c === "pass")
        setNotice("PASS · supply a validated TLE in the orbit panel");
      else
        setNotice(
          "COMMAND · search, count, filter, rank, annotate, weather, pass",
        );
    } catch (e) {
      setNotice(
        `COMMAND · ${e instanceof Error ? e.message : "invalid command"}`,
      );
    }
    setCommand("");
  };

  const scene = (): Scene => ({
    schemaVersion: 1,
    name: "SignalWarden scene",
    center,
    zoom,
    layers: Object.entries(layers).map(([layer, visible]) => ({
      layer,
      visible,
      opacity: 1,
    })) as SceneLayer[],
    annotations,
    keyframes,
    createdAt: new Date().toISOString(),
    style: (style === "Standard" ? "standard" : style) as Scene["style"],
    detection,
    tilt,
    selectedId,
  });
  const exportScene = () => {
    try {
      download(
        "signalwarden-scene.json",
        decodeURIComponent(encodeScene(scene())),
      );
      setNotice("SCENE · exported validated scene");
    } catch (e) {
      setNotice(
        `SCENE · export rejected (${e instanceof Error ? e.message : "invalid"})`,
      );
    }
  };
  const exportPack = () => {
    try {
      download(
        "signalwarden-observations.json",
        exportObservationPack(records),
      );
      setNotice("PACK · exported bounded observations");
    } catch (e) {
      setNotice(
        `PACK · export rejected (${e instanceof Error ? e.message : "invalid"})`,
      );
    }
  };
  const importFile = (kind: "scene" | "pack") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 2_000_000) {
        setNotice("IMPORT · rejected before reading: file exceeds 2 MB");
        return;
      }
      try {
        const text = await f.text();
        if (kind === "pack") {
          const p = importObservationPack(text);
          setHistory([]);
          setRecords(p.observations);
          setNotice(`PACK · imported ${p.observations.length} observations`);
        } else {
          const s = decodeScene(encodeURIComponent(text));
          syncCenter(s.center);
          setZoom(Math.max(0.65, Math.min(1.8, s.zoom)));
          setLayers(
            Object.fromEntries(
              LAYER_IDS.map((id) => [
                id,
                s.layers.find((x) => x.layer === id)?.visible ?? true,
              ]),
            ),
          );
          setAnnotations(s.annotations);
          setKeyframes(s.keyframes);
          setStyle(
            s.style === "standard" ? "Standard" : (s.style ?? "Standard"),
          );
          setDetection(!!s.detection);
          setTilt(!!s.tilt);
          setSelectedId(s.selectedId ?? null);
          setNotice("SCENE · imported validated state");
        }
      } catch (e) {
        setNotice(
          `IMPORT · rejected (${e instanceof Error ? e.message : "invalid file"})`,
        );
      }
    };
    input.click();
  };
  const share = async () => {
    try {
      const params = new URLSearchParams();
      params.set("scene", encodeScene(scene()));
      const url = `${location.origin}${location.pathname}?${params}`;
      if (url.length > 8000)
        throw new Error(
          "Scene too large for a URL; export a scene file instead",
        );
      history.replaceState(null, "", `?${params}`);
      try {
        await navigator.clipboard.writeText(url);
        setNotice("SHARE · validated scene URL copied");
      } catch {
        setNotice("SHARE · copy the scene URL from the address bar");
      }
    } catch (e) {
      setNotice(`SHARE · ${e instanceof Error ? e.message : "invalid scene"}`);
    }
  };

  const refresh = async (kind: "usgs" | "weather" | "adsb") => {
    if (busy) return;
    if (!network) {
      setNotice(
        "PROVIDER · enable network opt-in before requesting external data",
      );
      return;
    }
    setBusy(true);
    const result =
      kind === "usgs"
        ? await refreshUsgsEarthquakes({ network: true })
        : kind === "adsb"
          ? await refreshAdsb(center, { network: true, radiusNm: 100 })
          : await refreshNoaaWeather(center, { network: true });
    setHistory((previous) => {
      const merged = [...previous, ...records, ...result.observations];
      const unique = new Map(
        merged.map((r) => [`${r.id}|${r.source}|${r.observedAt}`, r]),
      );
      return [...unique.values()].slice(-1000);
    });
    setClock(Date.now());
    setProviderResults((x) => ({ ...x, [result.providerId]: result }));
    setBusy(false);
    if (result.error) {
      const source =
        kind === "usgs"
          ? "USGS"
          : kind === "adsb"
            ? "adsb.lol"
            : "NOAA/NWS weather.gov";
      setRecords((x) =>
        x.map((o) =>
          o.source === source ? { ...o, freshness: "stale", stale: true } : o,
        ),
      );
    }
    if (
      result.freshness === "fresh" ||
      (result.observations.length && !result.error)
    ) {
      const source =
        kind === "usgs"
          ? "USGS"
          : kind === "adsb"
            ? "adsb.lol"
            : "NOAA/NWS weather.gov";
      setRecords((x) => [
        ...x.filter((o) => o.source !== source),
        ...result.observations,
      ]);
    }
    setNotice(`PROVIDER · ${providerStatus(result).disclosure}`);
  };
  const toggleVoice = () => {
    if (!voiceOptIn) {
      setNotice("VOICE · check explicit opt-in first");
      return;
    }
    if (listening) {
      recognition.current?.stop?.();
      setListening(false);
      return;
    }
    if (
      !window.confirm(
        "Speech recognition may send audio to your browser speech service. Continue?",
      )
    )
      return;
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      setNotice("VOICE · unavailable in this browser");
      return;
    }
    const r = new SR();
    recognition.current = r;
    r.lang = "en-US";
    r.onresult = (e: any) => {
      const intent = parseAnalystVoice(String(e.results[0][0].transcript));
      if (intent.kind === "navigate") {
        setCommand(`search ${intent.place}`);
        setNotice("VOICE · local camera search staged for review");
      } else if (intent.kind === "layer") {
        setLayers((previous) => ({
          ...previous,
          [intent.layer]: intent.visible,
        }));
        setNotice("VOICE · read-only layer visibility changed");
      } else {
        setNotice(
          intent.kind === "reject"
            ? `VOICE · ${intent.reason}`
            : "VOICE · use Scene analyst speech to review a question or annotation draft; no command executed",
        );
      }
    };
    r.onend = () => setListening(false);
    r.start();
    setListening(true);
    setNotice("VOICE · active; browser speech service may process audio");
  };
  const addKeyframe = () => {
    if (keyframes.length >= 8) {
      setNotice("DIRECTOR · maximum eight local keyframes");
      return;
    }
    setKeyframes((x) =>
      [...x, { atMs: x.length * 15000, center, zoom }].sort(
        (a, b) => a.atMs - b.atMs,
      ),
    );
    setNotice("DIRECTOR · keyframe captured");
  };
  const calculatePasses = () => {
    try {
      const tle = parseTle(tleText);
      const pos = satellitePosition(tle, new Date());
      setRecords((x) => [
        ...x.filter((r) => r.id !== "user-satellite"),
        {
          id: "user-satellite",
          layer: "satellites",
          point: {
            lat: pos.latitude,
            lon: pos.longitude,
            altM: pos.altitudeKm * 1000,
          },
          observedAt: pos.at,
          source: "User TLE · SGP4 estimate",
          label: "Orbital estimate · not observed",
          freshness: "fallback",
          properties: { visibility: "not assessed" },
        },
      ]);
      const next = predictPasses(
        tle,
        { lat: center.lat, lon: center.lon },
        new Date(),
        24,
        10,
      );
      setPassContext({
        lat: center.lat,
        lon: center.lon,
        calculatedAt: new Date().toISOString(),
      });
      setPasses(next);
      setNotice(
        `ORBIT · ${next.length} geometric pass${next.length === 1 ? "" : "es"} calculated`,
      );
    } catch (e) {
      setPasses([]);
      setNotice(
        `ORBIT · rejected (${e instanceof Error ? e.message : "invalid TLE"})`,
      );
    }
  };
  const analystContext = useMemo<AnalystContext>(() => {
    const all = new Map(
      [...observationHistory, ...rows.map((r) => r.raw)].map((r) => [
        `${r.id}|${r.source}|${r.observedAt}`,
        r,
      ]),
    );
    return {
      records: [...all.values()],
      annotations,
      providers: providerResults,
      passes:
        passContext &&
        passContext.lat === center.lat &&
        passContext.lon === center.lon
          ? passes.map((p) => ({
              ...p,
              ...passContext,
              source: "User TLE · local SGP4 estimate",
            }))
          : [],
      platformEvidence: [],
      platformVerified: false,
      center,
      radiusKm: radius,
      visibleLayers: Object.keys(layers).filter((id) => layers[id]),
      sceneName: replaying ? "Synthetic replay scene" : "SignalWarden scene",
      now: clock,
    };
  }, [
    observationHistory,
    rows,
    annotations,
    providerResults,
    passes,
    passContext,
    center,
    radius,
    layers,
    replaying,
    clock,
  ]);
  return (
    <main className={`worldview style-${style.toLowerCase()}`}>
      <header className="wv-header">
        <div>
          <span className="wv-kicker">WORLD / READ-ONLY CONTEXT</span>
          <h1>
            WorldView <span>signal workspace</span>
          </h1>
          <p>Procedural globe · explicit viewport-only imagery opt-in · no identity tracking</p>
        </div>
        <div className="wv-header-actions">
          <span className="wv-badge">
            <i /> READ-ONLY · DEMO + OPT-IN
          </span>
          <button
            onClick={() => {
              if (!globalContext) {
                savedView.current = { center, zoom, tilt, layers };
                syncCenter({ lat: 15, lon: 0 });
                setZoom(0.8);
                setTilt(false);
                setLayers(
                  Object.fromEntries(LAYER_IDS.map((id) => [id, true])),
                );
                setTracking(false);
              } else if (savedView.current) {
                const v = savedView.current;
                syncCenter(v.center);
                setZoom(v.zoom);
                setTilt(v.tilt);
                setLayers(v.layers);
              }
              setGlobalContext(!globalContext);
            }}
          >
            {globalContext ? "Restore local view" : "Global context"}
          </button>
          <button onClick={share}>Share view</button>
          <button onClick={exportScene}>Export scene</button>
          <button onClick={exportPack}>Export pack</button>
          <button onClick={() => importFile("scene")}>Import scene</button>
          <button onClick={() => importFile("pack")}>Import pack</button>
        </div>
      </header>
      <div className="wv-safety">
        <b>BOUNDARY</b> Camera / ALPR locations only. No face or plate
        recognition, covert targeting, or actuation. Every synthetic record is
        labeled <strong>SYNTHETIC</strong>; provider snapshots retain status and
        attribution.
      </div>
      <section className="wv-command">
        <span className="prompt">›</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runCommand()}
          placeholder="search geo:38.9,-77.0 · count · annotate review point"
          aria-label="Command input"
        />
        <label>
          <input
            type="checkbox"
            checked={voiceOptIn}
            onChange={(e) => {
              setVoiceOptIn(e.target.checked);
              if (!e.target.checked) {
                recognition.current?.stop?.();
                setListening(false);
              }
            }}
          />{" "}
          voice opt-in
        </label>
        <button onClick={toggleVoice}>
          {listening ? "Stop mic" : "Voice"}
        </button>
        <button className="run" onClick={runCommand}>
          Run
        </button>
        <span role="status" className="command-status">
          {notice || "LOCAL COMMANDS READY"}
        </span>
      </section>
      <button className="wv-local-toggle" aria-expanded={localLayersOpen} onClick={() => setLocalLayersOpen(!localLayersOpen)}>
        {localLayersOpen ? "Close and clear local offline layers" : "Open local offline layers"}
      </button>
      {localLayersOpen && <Suspense fallback={<p role="status">Loading local offline tools…</p>}><WorldViewLocalLayers /></Suspense>}
      <button className="wv-sar-toggle" aria-expanded={sarOpen} onClick={() => { const open = !sarOpen; setSarOpen(open); if (open) setSarEverOpened(true); }}>
        {sarOpen ? "Hide public imagery controls (globe refresh continues while visible)" : sarEverOpened ? "Show public imagery controls" : "Open public SAR satellite imagery controls"}
      </button>
      {sarEverOpened && <Suspense fallback={<p role="status">Loading SAR panel code (no provider requests)…</p>}><div hidden={!sarOpen}><WorldViewSar autoRefresh={sarAutoRefresh} onAutoRefreshChange={setAutoImageryPermission} bounds={viewportBounds} globeActive={globeActive} resetKey={sarResetKey} onLayer={receiveImageryLayer} onStatus={receiveImageryStatus} /></div></Suspense>}
      <div className="wv-layout">
        <aside className="wv-left">
          <div className="wv-panel search-panel">
            <label className="wv-label">SEARCH CONTEXT</label>
            <div className="search-box">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search local context"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    try {
                      const point = findLocalPlace(query);
                      if (point) {
                        syncCenter(point);
                        setQuery("");
                        setNotice("SEARCH · centered locally");
                      }
                    } catch (err) {
                      setNotice(String(err));
                    }
                  }
                }}
                placeholder="city, coordinates + Enter…"
              />
              <span>⌕</span>
            </div>
            <div className="city-chips">
              {["Washington", "London", "Tokyo", "Singapore", "Sydney"]
                .flatMap((name) => searchCities(name, 1))
                .slice(0, 5)
                .map((c) => (
                  <button
                    key={c.name}
                    onClick={() => {
                      syncCenter(c);
                      setQuery("");
                    }}
                  >
                    {c.name}
                  </button>
                ))}
            </div>
          </div>
          <div className="wv-panel">
            <div className="panel-head">
              <span className="wv-label">LAYERS</span>
              <span className="mono">
                {activeRows.length} / {records.length}
              </span>
            </div>
            {LAYER_IDS.map((key) => (
              <label className="toggle-row" key={key}>
                <span>
                  {key} <small>{counts[key] ?? 0}</small>
                </span>
                <input
                  type="checkbox"
                  checked={layers[key] !== false}
                  onChange={() => setLayers((x) => ({ ...x, [key]: !x[key] }))}
                />
                <i />
              </label>
            ))}
            <label className="toggle-row">
              <span>
                Detection overlay <small>cosmetic</small>
              </span>
              <input
                type="checkbox"
                checked={detection}
                onChange={(e) => {
                  setDetection(e.target.checked);
                  props.onDetectionChange?.(e.target.checked);
                }}
              />
              <i />
            </label>
          </div>
          <div className="wv-panel">
            <div className="panel-head">
              <span className="wv-label">DISPLAY</span>
              <button
                className="reset"
                onClick={() => {
                  syncCenter({ lat: 0, lon: 0 });
                  setZoom(1);
                  setStyle("Standard");
                  setTilt(false);
                  setTracking(false);
                  setQuery("");
                }}
              >
                Reset / north up
              </button>
            </div>
            <div className="style-grid">
              {STYLES.map((s) => (
                <button
                  className={style === s ? "active" : ""}
                  key={s}
                  onClick={() => {
                    setStyle(s);
                    props.onStyleChange?.(s);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="range-row">
              <span>Zoom</span>
              <input
                type="range"
                min=".65"
                max="1.8"
                step=".05"
                value={zoom}
                onChange={(e) => {
                  setZoom(Number(e.target.value));
                  props.onZoomChange?.(Number(e.target.value));
                }}
              />
              <b>{zoom.toFixed(2)}×</b>
            </div>
            <label className="toggle-row">
              <span>Oblique view (WebGL)</span>
              <input
                type="checkbox"
                checked={tilt}
                onChange={(e) => {
                  setTilt(e.target.checked);
                  props.onTiltChange?.(e.target.checked);
                }}
              />
              <i />
            </label>
            <p className="fine-print">
              Styles are cosmetic presentation modes, not real sensors.
            </p>
          </div>
        </aside>
        <section className="wv-stage">
          <div className="globe-slot" ref={globeSlotRef}>
            <WorldGlobe
              records={[
                ...activeRows.map((r) => ({
                  id: r.id,
                  lat: r.c.lat,
                  lon: r.c.lon,
                  layer: r.kind,
                  label: r.name,
                  name: r.name,
                })),
                ...annotations.map((a) => ({
                  id: a.id,
                  lat: a.point.lat,
                  lon: a.point.lon,
                  layer: "annotation",
                  label: a.text,
                })),
              ]}
              center={center}
              selectedId={selectedId}
              onSelect={syncSelect}
              onCenter={syncCenter}
              style={style}
              detection={detection}
              tilt={tilt}
              zoom={zoom}
              imageryLayers={Object.values(globeImagery)}
              imageryStatus={imageryStatus}
              onViewportChange={receiveViewport}
              now={clock}
            />
            <div className="stage-hud">
              <span>
                <i /> OFFLINE SPHERE
              </span>
              <span>
                LAT {fmt(center.lat)}° · LON {fmt(center.lon)}°
              </span>
              <span>ZOOM {zoom.toFixed(2)}X</span>
            </div>
            <div className="stage-controls">
              <button onClick={() => setZoom(Math.min(1.8, zoom + 0.05))}>
                +
              </button>
              <button onClick={() => setZoom(Math.max(0.65, zoom - 0.05))}>
                −
              </button>
              <button onClick={() => syncCenter({ lat: 0, lon: 0 })}>◎</button>
            </div>
            <div className="synthetic-stamp">
              {replaying ? "SYNTHETIC REPLAY · " : ""}
              {paused
                ? "TIMELINE PAUSED"
                : playing
                  ? "DIRECTOR PLAYING"
                  : replaying
                    ? "REPLAY PLAYING"
                    : "PAUSED"}{" "}
              · {keyframes.length} KEYFRAMES
            </div>
          </div>
          <div className="timeline">
            <span className="wv-label">DIRECTOR TIMELINE</span>
            <button
              onClick={() => {
                if (keyframes.length < 2) {
                  setNotice("DIRECTOR · capture two centers before playback");
                  return;
                }
                setPaused(false);
                setPlaying(!playing);
                setReplaying(false);
              }}
            >
              {playing ? "Stop path" : "Play path"}
            </button>
            <button
              disabled={!playing && !replaying}
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume timeline" : "Pause timeline"}
            </button>
            <button
              onClick={() => {
                setPaused(false);
                setReplaying(!replaying);
                setPlaying(false);
              }}
            >
              {replaying ? "Stop replay" : "Synthetic replay"}
            </button>
            <button onClick={addKeyframe}>Capture center</button>
            <input
              type="range"
              min="0"
              max="120000"
              step="1000"
              value={timeMs}
              aria-label="Replay time"
              onChange={(e) => {
                const t = Number(e.target.value);
                setPaused(true);
                setTimeMs(t);
                if (playing) {
                  const pose = directorAt(keyframes, t);
                  if (pose) {
                    syncCenter(pose.center);
                    setZoom(pose.zoom);
                  }
                }
              }}
            />
            <span className="mono">{Math.round(timeMs / 1000)}s</span>
          </div>
        </section>
        <aside className="wv-right">
          <WorldViewSpatial center={center} selected={selected?.raw ?? null} records={shownRecords} />
          <div className="wv-panel roster">
            <div className="panel-head">
              <span className="wv-label">NEARBY CONTACTS</span>
              <select
                aria-label="Nearby radius"
                value={String(radius)}
                onChange={(e) => setRadius(Number(e.target.value))}
              >
                <option value="250">250 km</option>
                <option value="1000">1,000 km</option>
                <option value="Infinity">Global</option>
              </select>
              <span className="mono">
                {filtered.length} / {activeRows.length}
              </span>
            </div>
            {filtered.slice(0, 8).map((r) => (
              <button
                className={`roster-row ${r.id === selectedId ? "selected" : ""}`}
                key={r.id}
                onClick={() => {
                  syncSelect(r.id);
                  syncCenter(r.c);
                }}
              >
                <span className="roster-index">
                  {r.id === selectedId ? "●" : "○"}
                </span>
                <span>
                  <strong>{r.name}</strong>
                  <small>
                    {r.kind} · {r.source}
                  </small>
                </span>
                <b>{km(center, r.c)} km</b>
              </button>
            ))}
          </div>
          <div className="wv-panel detail">
            <span className="wv-label">SELECTED DETAIL</span>
            {selected ? (
              <>
                <h2>{selected.name}</h2>
                <div className="detail-grid">
                  <span>
                    ID<strong>{selected.id}</strong>
                  </span>
                  <span>
                    COORDINATES
                    <strong>
                      {fmt(selected.c.lat)}, {fmt(selected.c.lon)}
                    </strong>
                  </span>
                  <span>
                    PROVENANCE<strong>{selected.source}</strong>
                  </span>
                  <span>
                    STATUS
                    <strong className="teal">
                      {selected.raw.freshness ?? "unknown"}
                    </strong>
                  </span>
                </div>
                <button
                  onClick={() => {
                    if (selected) {
                      syncSelect(selected.id);
                      syncCenter(selected.c);
                      setTracking(!tracking);
                    }
                  }}
                >
                  {tracking ? "Release view follow" : "Follow selected view"}
                </button>
                <dl className="source-note">
                  {Object.entries(selected.raw.properties ?? {})
                    .slice(0, 20)
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                  <div>
                    Reported / modeled:{" "}
                    {new Date(selected.raw.observedAt).toLocaleString()}
                  </div>
                </dl>
                <p className="source-note">
                  Provider status: synthetic demo records are local. Network
                  feeds are manual, opt-in, bounded, and retain failure/stale
                  metadata.
                </p>
              </>
            ) : (
              <p className="muted">
                Select a record to inspect its bounded metadata.
              </p>
            )}
          </div>
          <div className="wv-panel annotations">
            <div className="panel-head">
              <span className="wv-label">ANNOTATIONS</span>
              <span className="mono">GEOGRAPHIC</span>
            </div>
            {annotations.map((a) => (
              <div className="annotation" key={a.id}>
                {a.text}
                <small>
                  {" "}
                  · {fmt(a.point.lat)}, {fmt(a.point.lon)}
                </small>
              </div>
            ))}
            {!annotations.length && (
              <p className="muted">
                Use annotate … to place a geographic note.
              </p>
            )}
          </div>
          <div className="wv-panel">
            <div className="panel-head">
              <span className="wv-label">PROVIDERS</span>
              <label>
                <input
                  aria-label="Allow external provider requests"
                  type="checkbox"
                  checked={network}
                  onChange={(e) => setNetwork(e.target.checked)}
                />{" "}
                allow external requests
              </label>
            </div>
            <p className="fine-print">
              Opt-in sends the selected coordinates or bounded query to the
              named provider. No credentials are collected.
            </p>
            <button disabled={busy || !network} onClick={() => refresh("usgs")}>
              Refresh USGS earthquakes
            </button>
            <button
              disabled={busy || !network}
              onClick={() => refresh("weather")}
            >
              Refresh NOAA forecast
            </button>
            <button disabled={busy || !network} onClick={() => refresh("adsb")}>
              Refresh aircraft · 100 nm
            </button>
            <p className="fine-print">
              Aircraft data © adsb.lol contributors ·{" "}
              <a
                href="https://opendatacommons.org/licenses/odbl/1.0/"
                target="_blank"
                rel="noreferrer"
              >
                ODbL 1.0
              </a>{" "}
              ·{" "}
              <a
                href="https://www.adsb.lol/docs/privacy-license"
                target="_blank"
                rel="noreferrer"
              >
                provider terms
              </a>
              . No callsign, registration, owner or person lookup. One request
              per minute; ≤100 nm.
            </p>
            <p className="fine-print">
              Fires: demo or authorized imported event metadata only. EONET live
              reads are disabled pending source-license review; FIRMS needs a
              separately reviewed MAP_KEY adapter. No wildfire assets are
              bundled.
            </p>
            {Object.values(providerResults).map((r) => (
              <p className="source-note" key={r.providerId}>
                {providerStatus(r, Math.max(clock, Date.now())).disclosure}
              </p>
            ))}
            {PROVIDER_MATRIX.slice(0, 3).map((p) => (
              <p className="fine-print" key={p.id}>
                <b>{p.name}</b> · {p.attribution} · {p.terms} · {p.limits} ·{" "}
                <a href={p.endpoint} target="_blank" rel="noreferrer">
                  terms/provider
                </a>
              </p>
            ))}
          </div>
          <div className="wv-panel orbit-panel">
            <span className="wv-label">ORBIT GEOMETRY</span>
            <a
              href="/worldview-software-notices.txt"
              target="_blank"
              rel="noreferrer"
            >
              Software notices
            </a>
            <textarea
              maxLength={1000}
              aria-label="Satellite TLE"
              value={tleText}
              onChange={(e) => setTleText(e.target.value)}
              placeholder="Paste a validated two-line TLE (optional)"
            />
            <button onClick={calculatePasses}>Calculate 24h passes</button>
            <p className="fine-print">
              Local SGP4 propagation only; geometry is not a live sighting and
              visibility is not assessed. Observer: {fmt(center.lat)},{" "}
              {fmt(center.lon)}.
            </p>
            {passes.length ? (
              <div>
                {passes.map((pass, i) => (
                  <div className="provider-row" key={`${pass.rise}-${i}`}>
                    <b>Pass {i + 1}</b>
                    <small>
                      rise {new Date(pass.rise).toLocaleString()} · peak{" "}
                      {new Date(pass.peak).toLocaleString()} · set{" "}
                      {new Date(pass.set).toLocaleString()} · max{" "}
                      {pass.maxElevationDeg.toFixed(1)}° · {pass.visibility}
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                No calculated passes yet. A valid checksum-checked TLE is
                required.
              </p>
            )}
          </div>
        </aside>
      </div>
      <WorldViewAnalyst
        context={analystContext}
        selectedId={selectedId}
        onLayer={(layer, visible) =>
          setLayers((previous) => ({ ...previous, [layer]: visible }))
        }
        onNavigate={(place) => {
          const point = findLocalPlace(place);
          if (!point) return false;
          syncCenter(point);
          return true;
        }}
        onDraftAnnotation={(text) =>
          setAnnotations((previous) =>
            [
              ...previous,
              {
                id: `analyst-note-${Date.now()}`,
                text,
                point: center,
                createdAt: new Date().toISOString(),
              },
            ].slice(-50),
          )
        }
      />
    </main>
  );
}
export default WorldView;
