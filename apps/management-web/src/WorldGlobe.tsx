import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  globeVector,
  normalizedCenter,
  orthographic,
} from "./worldview-globe-math";
import { visibleGlobeBounds, visibleOrthographicBounds, type GlobeBounds } from "./worldview-globe-viewport";
import type { GlobeImageryLayer, GlobeImageryStatus } from "./worldview-globe-imagery";

type Contact = {
  id: string;
  lat: number;
  lon: number;
  layer: string;
  label?: string;
  name?: string;
  altitude?: number;
};
type Props = {
  records: Contact[];
  center: { lat: number; lon: number };
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCenter: (c: { lat: number; lon: number }) => void;
  style: string;
  detection: boolean;
  tilt: boolean;
  zoom: number;
  imageryLayers?: GlobeImageryLayer[];
  imageryStatus?: GlobeImageryStatus | null;
  onViewportChange?: (bounds: GlobeBounds[]) => void;
  now?: number;
};
const colors: Record<string, number> = {
  aircraft: 0x70e4d1,
  vessels: 0x62aeff,
  satellites: 0xc6a2ff,
  earthquakes: 0xffb35b,
  fires: 0xff775a,
  weather: 0x8cd9f4,
  traffic: 0xf2dc85,
  cameras: 0xc0d6e4,
  alpr: 0xd5b3de,
};
const footprintCenter = (ring: ReadonlyArray<readonly [number, number]>) => {
  if (!ring.length) return { lat: 0, lon: 0 };
  const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const x = ring.reduce((sum, point) => sum + Math.sin((point[0] * Math.PI) / 180), 0);
  const y = ring.reduce((sum, point) => sum + Math.cos((point[0] * Math.PI) / 180), 0);
  return { lat, lon: (Math.atan2(x, y) * 180) / Math.PI };
};
// Original schematic outlines: intentionally coarse, not a navigational basemap.
const outlines = [
  [
    [-168, 66],
    [-140, 60],
    [-128, 49],
    [-124, 40],
    [-112, 30],
    [-100, 21],
    [-84, 23],
    [-81, 31],
    [-65, 46],
    [-55, 52],
    [-80, 61],
    [-100, 72],
    [-140, 70],
    [-168, 66],
  ],
  [
    [-81, 10],
    [-65, 11],
    [-47, -2],
    [-35, -9],
    [-42, -23],
    [-54, -34],
    [-70, -55],
    [-76, -35],
    [-81, 10],
  ],
  [
    [-10, 36],
    [4, 43],
    [22, 40],
    [35, 55],
    [58, 59],
    [90, 75],
    [145, 61],
    [180, 64],
    [160, 45],
    [140, 36],
    [120, 20],
    [109, 5],
    [95, 5],
    [77, 8],
    [65, 25],
    [45, 30],
    [35, 12],
    [19, -34],
    [9, -28],
    [-6, 5],
    [-17, 15],
    [-10, 36],
  ],
  [
    [113, -22],
    [130, -12],
    [145, -16],
    [153, -28],
    [144, -39],
    [120, -34],
    [113, -22],
  ],
  [
    [-52, 60],
    [-22, 65],
    [-20, 80],
    [-48, 84],
    [-62, 76],
    [-52, 60],
  ],
  [
    [46, -13],
    [50, -16],
    [48, -26],
    [43, -24],
    [46, -13],
  ],
  [
    [130, 31],
    [142, 42],
    [145, 45],
  ],
  [
    [166, -35],
    [178, -40],
    [168, -47],
  ],
];

export function WorldGlobe(props: Props) {
  // Imported packs may contain thousands of rows; keep GPU/DOM work bounded.
  const boundedRecords = [
    ...new Map(
      props.records
        .filter(
          (r) =>
            Number.isFinite(r.lat) &&
            Number.isFinite(r.lon) &&
            Math.abs(r.lat) <= 90 &&
            Math.abs(r.lon) <= 180,
        )
        .map((r) => [r.id, r]),
    ).values(),
  ]
    .sort(
      (a, b) =>
        Number(b.id === props.selectedId) - Number(a.id === props.selectedId),
    )
    .slice(0, 500);
  props = { ...props, records: boundedRecords };
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const imageryCardRefs = useRef(new Map<string, HTMLDivElement>());
  const [fallback, setFallback] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFallback(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x06141d, 1);
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive schematic 3D Earth; drag to rotate",
    );
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    const globe = new THREE.Group();
    scene.add(globe);
    const ocean = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 48),
      new THREE.MeshPhongMaterial({
        color: 0x0c3444,
        shininess: 18,
        specular: 0x286779,
      }),
    );
    globe.add(ocean);
    scene.add(new THREE.AmbientLight(0xa9e0ed, 1.3));
    const light = new THREE.DirectionalLight(0xa4efe3, 2);
    light.position.set(-3, 4, 5);
    scene.add(light);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x296679,
      transparent: true,
      opacity: 0.48,
    });
    const line = (
      coords: number[][],
      material = lineMaterial,
      radius = 1.004,
    ) => {
      const points = coords.map(
        ([lon, lat]) => new THREE.Vector3(...globeVector(lat, lon, radius)),
      );
      globe.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          material,
        ),
      );
    };
    for (let lat = -75; lat <= 75; lat += 15)
      line(Array.from({ length: 145 }, (_, i) => [i * 2.5 - 180, lat]));
    for (let lon = -180; lon < 180; lon += 15)
      line(Array.from({ length: 73 }, (_, i) => [lon, i * 2.5 - 90]));
    const land = new THREE.LineBasicMaterial({
      color: 0x77b6aa,
      transparent: true,
      opacity: 0.8,
    });
    outlines.forEach((coords) => line(coords, land, 1.006));
    const contacts = new THREE.Group();
    scene.add(contacts);
    const imageryFootprints = new THREE.Group();
    scene.add(imageryFootprints);
    let signature = "",
      imagerySignature = "",
      viewportSignature = "",
      frame = 0;
    const markers = new Map<string, THREE.Object3D>();
    const dispose = (obj: THREE.Object3D) =>
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material))
          mesh.material.forEach((m) => m.dispose());
        else mesh.material?.dispose();
      });
    const resize = () => {
      const w = el.clientWidth,
        h = Math.max(el.clientHeight, 360);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    const render = () => {
      const p = current.current;
      const next = JSON.stringify(
        p.records.map((r) => [r.id, r.lat, r.lon, r.layer]),
      );
      if (next !== signature) {
        contacts.children.forEach(dispose);
        contacts.clear();
        markers.clear();
        signature = next;
        p.records.forEach((r) => {
          const group = new THREE.Group();
          const mat = new THREE.MeshBasicMaterial({
            color: colors[r.layer] ?? 0x99d2d8,
          });
          const radius = r.layer === "satellites" ? 1.12 : 1.018;
          group.position.set(...globeVector(r.lat, r.lon, radius));
          group.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            group.position.clone().normalize(),
          );
          if (r.layer === "aircraft") {
            group.add(
              new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.055, 5), mat),
            );
            const wing = new THREE.Mesh(
              new THREE.BoxGeometry(0.065, 0.009, 0.018),
              mat,
            );
            group.add(wing);
          } else if (r.layer === "satellites") {
            group.add(
              new THREE.Mesh(new THREE.BoxGeometry(0.023, 0.023, 0.023), mat),
            );
            group.add(
              new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.009, 0.025), mat),
            );
          } else if (r.layer === "vessels")
            group.add(
              new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.015, 0.05), mat),
            );
          else
            group.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.014), mat));
          markers.set(r.id, group);
          contacts.add(group);
        });
      }
      const layers = (p.imageryLayers ?? []).slice(0, 4);
      const nextImagery = JSON.stringify(layers.map((layer) => [layer.key, layer.footprint, layer.provider]));
      if (nextImagery !== imagerySignature) {
        imageryFootprints.children.forEach(dispose);
        imageryFootprints.clear();
        imagerySignature = nextImagery;
        layers.forEach((layer) => {
          const ring = layer.footprint;
          if (ring.length < 3) return;
          const coords = [...ring];
          if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) coords.push(coords[0]);
          const color = layer.provider === "ASF Sentinel-1" ? 0x62dfca : 0xf0bd69;
          const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
          const points = coords.map(([lon, lat]) => new THREE.Vector3(...globeVector(lat, lon, 1.012)));
          imageryFootprints.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
        });
      }
      const distance = 3.4 / Math.max(0.65, Math.min(1.8, p.zoom));
      camera.position.set(...globeVector(p.center.lat, p.center.lon, distance));
      if (p.tilt) {
        const north = new THREE.Vector3(
          ...globeVector(p.center.lat + 1, p.center.lon),
        )
          .sub(new THREE.Vector3(...globeVector(p.center.lat, p.center.lon)))
          .normalize();
        camera.position.addScaledVector(north, 0.5);
        camera.lookAt(
          new THREE.Vector3(...globeVector(p.center.lat, p.center.lon, 0.65)),
        );
      } else camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      const viewKey = JSON.stringify([p.center.lat, p.center.lon, p.zoom, p.tilt, el.clientWidth, el.clientHeight]);
      if (viewKey !== viewportSignature) {
        viewportSignature = viewKey;
        const e = camera.matrixWorld.elements;
        p.onViewportChange?.(visibleGlobeBounds({
          position: camera.position.toArray() as [number, number, number],
          right: [e[0], e[1], e[2]],
          up: [e[4], e[5], e[6]],
          forward: [-e[8], -e[9], -e[10]],
          aspect: camera.aspect,
          fovDegrees: camera.fov,
        }));
      }
      p.records.forEach((r) => {
        const marker = markers.get(r.id)!,
          button = labelRefs.current.get(r.id);
        const position = marker.position.clone(),
          facing =
            position
              .clone()
              .normalize()
              .dot(camera.position.clone().sub(position).normalize()) > 0;
        const projected = position.project(camera);
        const visible =
          facing && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 0.95;
        marker.visible = facing;
        marker.scale.setScalar(p.selectedId === r.id ? 1.8 : 1);
        if (button) {
          button.style.display = visible ? "block" : "none";
          button.style.left = `${((projected.x + 1) * el.clientWidth) / 2}px`;
          button.style.top = `${((-projected.y + 1) * el.clientHeight) / 2}px`;
        }
      });
      layers.forEach((layer) => {
        const card = imageryCardRefs.current.get(layer.key);
        if (!card || layer.footprint.length < 3) return;
        const { lat, lon } = footprintCenter(layer.footprint);
        const position = new THREE.Vector3(...globeVector(lat, lon, 1.04));
        const facing = position.clone().normalize().dot(camera.position.clone().sub(position).normalize()) > 0;
        const projected = position.project(camera);
        const visible = facing && Math.abs(projected.x) < 0.98 && Math.abs(projected.y) < 0.96;
        card.style.display = visible ? "block" : "none";
        card.style.left = `${((projected.x + 1) * el.clientWidth) / 2}px`;
        card.style.top = `${((-projected.y + 1) * el.clientHeight) / 2}px`;
      });
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    const lose = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(frame);
      renderer.domElement.style.display = "none";
      setContextLost(true);
    };
    renderer.domElement.addEventListener("webglcontextlost", lose);
    render();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", lose);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  const dragging = useRef<{
    x: number;
    y: number;
    lat: number;
    lon: number;
  } | null>(null);
  const useFallback = fallback || contextLost;
  useEffect(() => {
    if (useFallback) props.onViewportChange?.(visibleOrthographicBounds(props.center, props.zoom));
  }, [useFallback, props.center.lat, props.center.lon, props.zoom, props.onViewportChange]);
  return (
    <div
      ref={host}
      className={`world-globe world-globe-${props.style.toLowerCase()}`}
      style={{
        position: "relative",
        minHeight: 480,
        overflow: "hidden",
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        dragging.current = { x: e.clientX, y: e.clientY, ...props.center };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragging.current;
        if (d)
          props.onCenter(
            normalizedCenter(
              d.lat + (e.clientY - d.y) * 0.22,
              d.lon - (e.clientX - d.x) * 0.22,
            ),
          );
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    >
      {useFallback && (
        <svg
          viewBox={`${-1.15 / props.zoom} ${-1.15 / props.zoom} ${2.3 / props.zoom} ${2.3 / props.zoom}`}
          width="100%"
          height="480"
          aria-label="Orthographic globe fallback"
        >
          <circle r="1" fill="#0c3444" stroke="#77b6aa" strokeWidth=".005" />
          {outlines.map((coords, i) => (
            <path
              key={i}
              fill="none"
              stroke="#77b6aa"
              strokeWidth=".006"
              d={coords
                .map(([lon, lat]) => {
                  const p = orthographic(lat, lon, props.center);
                  return `${p.visible ? "L" : "M"} ${p.x} ${-p.y}`;
                })
                .join(" ")
                .replace(/^L/, "M")}
            />
          ))}
          {(props.imageryLayers ?? []).slice(0, 4).map((layer) => {
            const points = layer.footprint.map(([lon, lat]) => ({ ...orthographic(lat, lon, props.center), lat, lon }));
            return <path key={`footprint-${layer.key}`} d={points.map((p) => `${p.visible ? "L" : "M"} ${p.x} ${-p.y}`).join(" ").replace(/^L/, "M")} fill="none" stroke={layer.provider === "ASF Sentinel-1" ? "#62dfca" : "#f0bd69"} strokeWidth=".012" />;
          })}
          {props.records.map((r) => {
            const p = orthographic(r.lat, r.lon, props.center);
            return (
              p.visible && (
                <g
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  aria-label={r.label ?? r.name ?? r.id}
                  onClick={() => props.onSelect(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      props.onSelect(r.id);
                  }}
                >
                  <circle
                    cx={p.x}
                    cy={-p.y}
                    r={props.selectedId === r.id ? 0.03 : 0.018}
                    fill={props.selectedId === r.id ? "#f0ab5c" : "#7ce3cf"}
                  />
                  {props.detection && (
                    <rect
                      x={p.x - 0.03}
                      y={-p.y - 0.03}
                      width=".06"
                      height=".06"
                      fill="none"
                      stroke="#7ce3cf"
                      strokeWidth=".003"
                    />
                  )}
                  {(props.selectedId===r.id||props.detection)&&<text x={p.x + 0.025} y={-p.y} fontSize=".035" fill="white">
                    {r.label ?? r.name ?? r.id}
                  </text>}
                </g>
              )
            );
          })}
        </svg>
      )}
      {!useFallback &&
        props.records.map((r) => (
          <button
            type="button"
            key={r.id}
            ref={(el) => {
              if (el) labelRefs.current.set(r.id, el);
              else labelRefs.current.delete(r.id);
            }}
            aria-label={r.label??r.name??r.id}
            title={r.label??r.name??r.id}
            className={`world-contact ${props.selectedId === r.id ? "selected" : ""} ${props.detection ? "detected" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => props.onSelect(r.id)}
            style={{
              display: "none",
              position: "absolute",
              transform: "translate(10px,-50%)",
              fontSize: 10,
              color: "#ccfff3",
              background: "#06141dcc",
              border: props.detection
                ? "1px solid #69d6be"
                : "1px solid transparent",
              padding: "4px 7px",
              borderRadius: 3,
              cursor: "pointer",
              maxWidth: 160,
            }}
          >
            {props.selectedId===r.id||props.detection?(r.label??r.name??r.id):"●"}
          </button>
        ))}
      {(props.imageryLayers ?? []).slice(0, 4).map((layer) => {
        const { lat, lon } = footprintCenter(layer.footprint);
        const projected = useFallback ? orthographic(lat, lon, props.center) : null;
        const boxSize = 2.3 / props.zoom;
        const ageMs = layer.acquisitionStart ? (props.now ?? Date.now()) - Date.parse(layer.acquisitionStart) : NaN;
        const age = !Number.isFinite(ageMs) || ageMs < 0 ? "age unknown" : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m old` : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h old` : `${Math.floor(ageMs / 86_400_000)}d old`;
        return <div key={layer.key} ref={(el) => { if (el) imageryCardRefs.current.set(layer.key, el); else imageryCardRefs.current.delete(layer.key); }} className="globe-imagery-card" style={{ display: useFallback ? (projected?.visible ? "block" : "none") : "none", left: useFallback && projected?.visible ? `${((projected.x + boxSize / 2) / boxSize) * 100}%` : undefined, top: useFallback && projected?.visible ? `${((-projected.y + boxSize / 2) / boxSize) * 100}%` : undefined }}>
          {layer.imageUrl ? <img src={layer.imageUrl} alt={`${layer.provider} preview for ${layer.productId}; preview is not georeferenced`} /> : null}
          <div><b>{layer.provider}</b><br />{layer.productId}<br />Acquired {layer.acquisitionStart ?? "time unknown"} · {age}<br />Coverage: {layer.coverageNote}<br />Retrieved {layer.retrievedAt}<br />{layer.attribution}<br /><strong>{layer.registrationNote}</strong>{layer.refreshState === "retained-failed" ? <><br /><strong>RETAINED AFTER REFRESH FAILURE</strong></> : null}{layer.freshness === "stale" ? <><br /><strong>HISTORICAL / STALE ACQUISITION</strong></> : layer.freshness === "unknown" ? <><br /><strong>ACQUISITION AGE UNKNOWN</strong></> : null}</div>
        </div>;
      })}
      {props.imageryStatus && <div role="status" className={`globe-imagery-status tone-${props.imageryStatus.tone}`}><b>{props.imageryStatus.provider} · {props.imageryStatus.title}</b><br />{props.imageryStatus.detail}</div>}
      <span
        style={{
          position: "absolute",
          left: 14,
          bottom: 12,
          fontSize: 10,
          color: "#9ebdc7",
          pointerEvents: "none",
        }}
      >
        Original schematic Earth · not a navigation map ·{" "}
        {useFallback ? "2D fallback" : "3D / drag to rotate"} · cosmetic styles
        only
      </span>
    </div>
  );
}
