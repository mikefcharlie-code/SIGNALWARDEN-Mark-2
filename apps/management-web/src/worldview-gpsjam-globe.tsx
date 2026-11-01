import * as THREE from "three";
import { globeVector } from "./worldview-globe-math";
// Type-only: the globe chunk must not pull in h3-js; all H3 work happens in the lazily loaded panel.
import type { GpsJamGlobeState, GpsJamLevel, GpsJamTooltip } from "./worldview-gpsjam";

/** Above basemap/ocean/live tiles (≤1.0042) and AQ heat (1.0062 is only regional); below wind particles. */
export const GPSJAM_RADIUS = 1.0052;
export const MAX_GLOBE_CELLS = 5000;
/** GPSJAM's own map colours (fill opacity 0.5 on gpsjam.org). */
export const GPSJAM_COLORS: Readonly<Record<GpsJamLevel, readonly [number, number, number]>> = {
  good: [0x33, 0xff, 0x33], medium: [0xff, 0xff, 0x33], bad: [0xff, 0x33, 0x33],
};
const LEGEND: ReadonlyArray<readonly [GpsJamLevel, string, string]> = [["good", "Low", "0–2 %"], ["medium", "Medium", "2–<10 %"], ["bad", "High", "≥ 10 %"]];

/** One merged mesh of fan-triangulated hexagons (pentagons included) in 3D, so antimeridian cells need no splitting. */
export function hexGeometry(cells: GpsJamGlobeState["cells"], radius = GPSJAM_RADIUS): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  let count = 0;
  for (const cell of cells.slice(0, MAX_GLOBE_CELLS)) {
    const b = cell.boundary;
    const n = Math.floor(b.length / 2);
    if (n < 3) continue;
    const verts: Array<[number, number, number]> = [];
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const v = globeVector(b[i * 2], b[i * 2 + 1], radius);
      if (!v.every(Number.isFinite)) { verts.length = 0; break; }
      verts.push(v);
      cx += v[0]; cy += v[1]; cz += v[2];
    }
    if (verts.length < 3) continue;
    const len = Math.hypot(cx, cy, cz) || 1;
    const center: [number, number, number] = [(cx / len) * radius, (cy / len) * radius, (cz / len) * radius];
    const c = GPSJAM_COLORS[cell.level] ?? GPSJAM_COLORS.good;
    count++;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], d = verts[(i + 1) % verts.length];
      positions.push(...center, ...a, ...d);
      for (let k = 0; k < 3; k++) colors.push(c[0] / 255, c[1] / 255, c[2] / 255);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.userData.cellCount = count;
  return g;
}

/** Inverse of globeVector for a point on (or near) the unit sphere in globe-local coordinates. */
export function latLonOf(p: Readonly<{ x: number; y: number; z: number }>): { lat: number; lon: number } {
  const r = Math.hypot(p.x, p.y, p.z) || 1;
  return { lat: (Math.asin(Math.max(-1, Math.min(1, p.y / r))) * 180) / Math.PI, lon: (Math.atan2(p.x, p.z) * 180) / Math.PI };
}

/** Pick the globe surface under a normalized device coordinate; null when the ray misses the Earth. */
export function surfaceAt(ndcX: number, ndcY: number, camera: THREE.Camera, globe: THREE.Object3D): { lat: number; lon: number } | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const ray = raycaster.ray.clone().applyMatrix4(new THREE.Matrix4().copy(globe.matrixWorld).invert());
  const hit = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1), new THREE.Vector3());
  return hit ? latLonOf(hit) : null;
}

const tooltipLines = (t: GpsJamTooltip) => [
  `${({ good: "Low", medium: "Medium", bad: "High" } as const)[t.level]} · ${t.pct.toFixed(1)} % of aircraft reported low accuracy`,
  `${t.bad} low-accuracy · ${t.good} good · ${t.total} aircraft`,
  `H3 ${t.hex} · ${t.date} UTC day`,
  "Inferred from aircraft reports; not a jammer detection",
];

/**
 * Globe hook for the GPSJAM layer: a bounded merged hex mesh plus a hover tooltip (bad/good/total
 * aircraft). The tooltip is a text-only DOM node next to the canvas; nothing here makes a request.
 */
export function createGpsJamGlobeLayer(parent: THREE.Object3D, dom?: HTMLElement | null) {
  const root = new THREE.Group();
  root.name = "gpsjam-hexes";
  root.renderOrder = 3;
  parent.add(root);
  let mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  let lastState: GpsJamGlobeState | null | undefined;
  let lastKey = "";
  let camera: THREE.Camera | null = null;
  let tip: HTMLDivElement | null = null;
  let frame = 0;
  let pending: { x: number; y: number } | null = null;

  const clear = () => {
    if (!mesh) return;
    mesh.geometry.dispose();
    mesh.material.dispose();
    root.remove(mesh);
    mesh = null;
  };
  const hide = () => { if (tip) tip.style.display = "none"; };
  const show = (x: number, y: number, info: GpsJamTooltip) => {
    const host = dom?.parentElement;
    if (!host || typeof document === "undefined") return;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "globe-gpsjam-tooltip";
      tip.setAttribute("role", "tooltip");
      Object.assign(tip.style, { position: "absolute", zIndex: "7", pointerEvents: "none", whiteSpace: "pre-line", maxWidth: "280px", padding: "4px 7px", borderRadius: "3px", background: "rgba(3,16,22,.92)", color: "#e6f3ed", font: "10px/1.35 system-ui, sans-serif", border: "1px solid rgba(255,255,255,.25)" });
      host.appendChild(tip);
    }
    tip.textContent = tooltipLines(info).join("\n");
    tip.style.borderColor = `rgb(${GPSJAM_COLORS[info.level].join(",")})`;
    tip.style.left = `${Math.round(x + 12)}px`;
    tip.style.top = `${Math.round(y + 12)}px`;
    tip.style.display = "block";
  };
  const evaluate = () => {
    frame = 0;
    const p = pending;
    pending = null;
    if (!p || !dom || !camera || !lastState?.pick || !mesh) return hide();
    const rect = dom.getBoundingClientRect();
    if (!rect.width || !rect.height) return hide();
    const surface = surfaceAt(((p.x - rect.left) / rect.width) * 2 - 1, -((p.y - rect.top) / rect.height) * 2 + 1, camera, parent);
    const info = surface ? lastState.pick(surface.lat, surface.lon) : null;
    if (!info) return hide();
    const hostRect = dom.parentElement?.getBoundingClientRect() ?? rect;
    show(p.x - hostRect.left, p.y - hostRect.top, info);
  };
  const onMove = (e: PointerEvent) => {
    if (!lastState) return;
    pending = { x: e.clientX, y: e.clientY };
    if (!frame) frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(evaluate) : (setTimeout(evaluate, 16) as unknown as number);
  };
  dom?.addEventListener("pointermove", onMove);
  dom?.addEventListener("pointerleave", hide);

  const sync = (state: GpsJamGlobeState | null | undefined, cam?: THREE.Camera | null) => {
    if (cam) camera = cam;
    if (state === lastState) return;
    lastState = state;
    if (!state || !state.cells.length) { lastKey = ""; clear(); hide(); return; }
    if (state.key === lastKey && mesh) { mesh.material.opacity = state.opacity; return; }
    lastKey = state.key;
    clear();
    mesh = new THREE.Mesh(hexGeometry(state.cells), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: state.opacity, depthWrite: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 3;
    root.add(mesh);
  };
  const dispose = () => {
    clear();
    dom?.removeEventListener("pointermove", onMove);
    dom?.removeEventListener("pointerleave", hide);
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    tip?.remove();
    tip = null;
    parent.remove(root);
  };
  return {
    sync, dispose, root,
    get cellCount() { return mesh ? (mesh.geometry.userData.cellCount as number) : 0; },
    get triangleCount() { return mesh ? mesh.geometry.getAttribute("position").count / 3 : 0; },
    /** Test hook: resolve the tooltip for a lat/lon without DOM events. */
    tooltipAt(lat: number, lon: number) { return lastState?.pick?.(lat, lon) ?? null; },
  };
}

const BADGE: Record<string, string> = { latest: "#1d5a3a", stale: "#5a4a1d", historical: "#33444b", unknown: "#33444b" };

/** On-globe legend, freshness badge and attribution; visible whenever the GPSJAM layer is drawn. */
export function GpsJamGlobeCredits({ state, fallback }: { state?: GpsJamGlobeState | null; fallback: boolean }) {
  if (!state) return null;
  const f = state.freshness;
  return (
    <div className="globe-gpsjam-credit" role="note" aria-label="GPS interference layer legend, freshness and credits" style={{ position: "absolute", right: 8, bottom: 36, zIndex: 6, maxWidth: "min(340px, 60%)", padding: "4px 7px", borderRadius: 3, background: "rgba(3,16,22,.86)", color: "#e6f3ed", font: "10px/1.35 system-ui, sans-serif", overflowWrap: "anywhere" }}>
      <div><b>GNSS interference · INFERRED · DAILY</b> {state.date} (UTC day){" "}
        <span className="gpsjam-badge" style={{ padding: "0 4px", borderRadius: 2, background: BADGE[f.status] ?? BADGE.unknown }}>{f.label}</span>
        {f.incomplete ? <span style={{ marginLeft: 4, color: "#ffd27a" }}>INCOMPLETE DAY</span> : null}
      </div>
      <div aria-label="Share of aircraft reporting low navigation accuracy" style={{ display: "flex", gap: 8, margin: "2px 0" }}>
        {LEGEND.map(([level, label, range]) => <span key={level}><span aria-hidden="true" style={{ display: "inline-block", width: 9, height: 9, marginRight: 3, verticalAlign: "-1px", background: `rgb(${GPSJAM_COLORS[level].join(",")})`, opacity: 0.8 }} />{label} {range}</span>)}
      </div>
      <div>{state.drawnCount} cells drawn{state.truncated ? ` (capped; ${state.inViewCount} in view, interference cells kept first)` : ""} · not real time, not a jammer detection, no source attribution</div>
      <div><a href={state.credit.siteUrl} target="_blank" rel="noreferrer noopener">{state.credit.text}</a> · <a href={state.credit.termsUrl} target="_blank" rel="noreferrer noopener">FAQ / method</a></div>
      {fallback ? <div><strong>WebGL unavailable: GPS interference hexes are not drawn on the 2D fallback.</strong></div> : null}
    </div>
  );
}
