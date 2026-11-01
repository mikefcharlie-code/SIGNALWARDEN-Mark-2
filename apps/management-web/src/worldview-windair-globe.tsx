import * as THREE from "three";
import { globeVector } from "./worldview-globe-math";
import { tilePatchGeometry } from "./worldview-basemap-globe";
import type { GlobeBasemapTile } from "./worldview-basemap";
import {
  PARTICLE_TRAIL, SPEED_STOPS, createParticles, insideSpan, sampleField, speedColor, stepParticles, windArrows, windSampler,
  type GridField, type Particle, type WindLevel,
} from "./worldview-windfield";
import { AIR_VARIABLES, scaleColor, type AirVariable } from "./worldview-airgrid";

/** Everything the globe needs to draw the wind & air map layers; built by WorldViewWindAir. */
export type WindAirGlobeState = Readonly<{
  wind?: Readonly<{ field: GridField; level: WindLevel; hour: number; animate: boolean; validTime: string }>;
  heat?: Readonly<{ field: GridField; variable: AirVariable; hour: number; opacity: number; validTime: string }>;
  satellite?: Readonly<{ sourceId: string; label: string; date: string; tiles: ReadonlyArray<GlobeBasemapTile>; opacity: number; legendUrl: string }>;
  credits: ReadonlyArray<Readonly<{ text: string; termsUrl: string }>>;
  note?: string;
}>;

export const MAX_PARTICLES = 900;
export const MAX_SAT_TILES = 48;
const SAT_RADIUS = 1.0045;
const HEAT_RADIUS = 1.0062;
const WIND_RADIUS = 1.0085;
const HEAT_SUBDIV = 3;

/** Heatmap mesh: subdivided grid patch with per-vertex RGBA (alpha 0 where the model has no value). */
export function heatGeometry(field: GridField, variable: AirVariable, hour: number, radius = HEAT_RADIUS): THREE.BufferGeometry {
  const values = field.values[variable]?.[hour];
  const { span } = field;
  const ny = field.rows * HEAT_SUBDIV, nx = field.cols * HEAT_SUBDIV;
  const positions: number[] = [], colors: number[] = [], index: number[] = [];
  const stops = AIR_VARIABLES[variable].stops;
  for (let j = 0; j <= ny; j++) {
    const lat = span.south + ((span.north - span.south) * j) / ny;
    for (let i = 0; i <= nx; i++) {
      const lon = span.west + ((span.east - span.west) * i) / nx;
      positions.push(...globeVector(lat, lon, radius));
      const v = sampleField(field, values, lat, lon);
      const c = v === null ? [0, 0, 0] : scaleColor(stops, v);
      colors.push(c[0] / 255, c[1] / 255, c[2] / 255, v === null ? 0 : 1);
    }
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  g.setIndex(index);
  return g;
}

/** Static arrows (wind blowing TOWARD the head), coloured by speed; reduced-motion / fallback view. */
export function arrowGeometry(field: GridField, level: WindLevel, hour: number, radius = WIND_RADIUS): THREE.BufferGeometry {
  const arrows = windArrows(field, level, hour);
  const cell = Math.min((field.span.north - field.span.south) / field.rows, (field.span.east - field.span.west) / field.cols);
  const positions: number[] = [], colors: number[] = [];
  const toXYZ = (lat: number, lon: number) => globeVector(lat, lon, radius);
  for (const a of arrows) {
    const len = cell * (0.35 + 0.5 * Math.min(1, a.speed / 25));
    const to = ((a.directionFrom + 180) * Math.PI) / 180;
    const cosLat = Math.max(0.15, Math.cos((a.lat * Math.PI) / 180));
    const dLat = Math.cos(to) * len, dLon = (Math.sin(to) * len) / cosLat;
    const tail: [number, number] = [a.lat - dLat / 2, a.lon - dLon / 2];
    const head: [number, number] = [a.lat + dLat / 2, a.lon + dLon / 2];
    const barbs = [to + 2.6, to - 2.6].map((t) => [head[0] + Math.cos(t) * len * 0.35, head[1] + (Math.sin(t) * len * 0.35) / cosLat] as [number, number]);
    const segs: Array<[[number, number], [number, number]]> = [[tail, head], [head, barbs[0]], [head, barbs[1]]];
    for (const [p, q] of segs) {
      positions.push(...toXYZ(p[0], p[1]), ...toXYZ(q[0], q[1]));
      for (let k = 0; k < 2; k++) colors.push(a.color[0] / 255, a.color[1] / 255, a.color[2] / 255);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

function texture(image: unknown): THREE.Texture | null {
  if (!image) return null;
  const t = new THREE.Texture(image as TexImageSource as any);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const disposeTree = (obj: THREE.Object3D) => obj.traverse((child) => {
  const mesh = child as THREE.Mesh;
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
  for (const m of mats) { (m as THREE.MeshBasicMaterial).map?.dispose(); m.dispose(); }
});

/** Globe hook: bounded wind particles / arrows, AQ heatmap and GIBS air tiles under one group. */
export function createWindAirGlobeLayer(parent: THREE.Object3D, rand: () => number = Math.random) {
  const root = new THREE.Group();
  root.name = "windair-layers";
  parent.add(root);
  const sat = new THREE.Group(), heat = new THREE.Group(), wind = new THREE.Group();
  sat.renderOrder = 2; heat.renderOrder = 3; wind.renderOrder = 4;
  root.add(sat, heat, wind);
  const satTiles = new Map<string, THREE.Mesh>();
  let satSource = "", satOpacity = 1;
  let lastState: WindAirGlobeState | null | undefined;
  let particles: Particle[] = [];
  let particleLines: THREE.LineSegments | null = null;
  let sampler: ReturnType<typeof windSampler> | null = null;
  let lastFrame = 0;

  const clear = (g: THREE.Group) => { g.children.forEach(disposeTree); g.clear(); };
  const syncSatellite = (s: WindAirGlobeState["satellite"]) => {
    if (!s || s.sourceId !== satSource) { sat.children.forEach(disposeTree); sat.clear(); satTiles.clear(); satSource = s?.sourceId ?? ""; }
    if (!s) return;
    const wanted = new Set(s.tiles.slice(0, MAX_SAT_TILES).map((t) => t.key));
    for (const [key, mesh] of satTiles) if (!wanted.has(key)) { disposeTree(mesh); sat.remove(mesh); satTiles.delete(key); }
    for (const tile of s.tiles.slice(0, MAX_SAT_TILES)) {
      if (satTiles.has(tile.key) || !tile.image) continue;
      const map = texture(tile.image);
      if (!map) continue;
      const mesh = new THREE.Mesh(tilePatchGeometry(tile, 0, SAT_RADIUS), new THREE.MeshBasicMaterial({ map, transparent: true, opacity: s.opacity, depthWrite: false }));
      sat.add(mesh);
      satTiles.set(tile.key, mesh);
    }
    if (s.opacity !== satOpacity) {
      satOpacity = s.opacity;
      for (const mesh of satTiles.values()) (mesh.material as THREE.MeshBasicMaterial).opacity = s.opacity;
    }
  };

  const rebuild = (state: WindAirGlobeState | null | undefined) => {
    clear(heat);
    clear(wind);
    particleLines = null; sampler = null;
    syncSatellite(state?.satellite);
    if (state?.heat) {
      const { field, variable, hour, opacity } = state.heat;
      heat.add(new THREE.Mesh(heatGeometry(field, variable, hour), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })));
    }
    if (state?.wind) {
      const { field, level, hour, animate } = state.wind;
      if (animate) {
        sampler = windSampler(field, level, hour);
        if (!particles.length || !particles.every((p) => insideSpan(field.span, p.lat, p.lon))) particles = createParticles(MAX_PARTICLES, field.span, rand);
        const segs = MAX_PARTICLES * (PARTICLE_TRAIL - 1) * 2;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs * 3), 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(segs * 4), 4).setUsage(THREE.DynamicDrawUsage));
        particleLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
        particleLines.frustumCulled = false;
        wind.add(particleLines);
      } else {
        wind.add(new THREE.LineSegments(arrowGeometry(field, level, hour), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false })));
      }
    }
  };

  const animate = (nowMs: number, span: GridField["span"]) => {
    if (!particleLines || !sampler) return;
    const dt = lastFrame ? (nowMs - lastFrame) / 1000 : 0.016;
    lastFrame = nowMs;
    stepParticles(particles, sampler, span, dt, rand);
    const pos = particleLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = particleLines.geometry.getAttribute("color") as THREE.BufferAttribute;
    const P = pos.array as Float32Array, C = col.array as Float32Array;
    let v = 0;
    for (const p of particles) {
      const w = sampler(p.lat, p.lon);
      const c = speedColor(w?.speed ?? 0);
      for (let k = 0; k < PARTICLE_TRAIL - 1; k++) {
        const a = p.trail[k], b = p.trail[k + 1];
        for (const [pt, alpha] of [[a, 1 - k / (PARTICLE_TRAIL - 1)], [b, 1 - (k + 1) / (PARTICLE_TRAIL - 1)]] as const) {
          const ok = !!a && !!b && Math.abs(a[1] - b[1]) < 30;
          const xyz = ok && pt ? globeVector(pt[0], pt[1], WIND_RADIUS) : [0, 0, 0];
          P[v * 3] = xyz[0]; P[v * 3 + 1] = xyz[1]; P[v * 3 + 2] = xyz[2];
          C[v * 4] = c[0] / 255; C[v * 4 + 1] = c[1] / 255; C[v * 4 + 2] = c[2] / 255; C[v * 4 + 3] = ok ? Math.max(0, alpha) * 0.9 : 0;
          v++;
        }
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  };

  const sync = (state: WindAirGlobeState | null | undefined, nowMs: number) => {
    if (state !== lastState) { lastState = state; rebuild(state); }
    if (state?.wind?.animate) animate(nowMs, state.wind.field.span);
  };
  const dispose = () => { clear(heat); clear(wind); sat.children.forEach(disposeTree); sat.clear(); satTiles.clear(); parent.remove(root); };
  return { sync, dispose, get particleCount() { return particleLines ? particles.length : 0; }, get satTileCount() { return satTiles.size; }, root };
}

const css = (c: readonly [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const speedGradient = () => `linear-gradient(90deg, ${SPEED_STOPS.map(([s, c]) => `${css(c)} ${Math.round((s / 60) * 100)}%`).join(", ")})`;
export const airGradient = (variable: AirVariable) => {
  const stops = AIR_VARIABLES[variable].stops;
  const max = stops[stops.length - 1][0] || 1;
  return `linear-gradient(90deg, ${stops.map(([v, c]) => `${css(c)} ${Math.round((v / max) * 100)}%`).join(", ")})`;
};

/** On-globe legend + provider credits for the wind & air layers; always visible while any is on. */
export function WindAirGlobeCredits({ state, fallback }: { state?: WindAirGlobeState | null; fallback: boolean }) {
  if (!state || (!state.wind && !state.heat && !state.satellite)) return null;
  return (
    <div className="globe-windair-credit" role="note" aria-label="Wind and air map layer legend and credits" style={{ position: "absolute", left: 8, top: 8, zIndex: 6, maxWidth: "min(360px, 60%)", padding: "4px 7px", borderRadius: 3, background: "rgba(3,16,22,.84)", color: "#e6f3ed", font: "10px/1.35 system-ui, sans-serif", overflowWrap: "anywhere" }}>
      {state.wind && <div>
        <b>Wind · MODEL FORECAST</b> valid {state.wind.validTime.slice(0, 13).replace("T", " ")}Z
        <div aria-hidden="true" style={{ height: 6, margin: "2px 0", background: speedGradient(), borderRadius: 2 }} />
        <span>0 · 10 · 20 · 30 · 45 · 60+ m/s (×1.94 = kt){state.wind.animate ? " · particles are a visual aid" : " · arrows point downwind"}</span>
      </div>}
      {state.heat && <div>
        <b>{AIR_VARIABLES[state.heat.variable].label} · MODELLED (CAMS)</b> valid {state.heat.validTime.slice(0, 13).replace("T", " ")}Z
        <div aria-hidden="true" style={{ height: 6, margin: "2px 0", background: airGradient(state.heat.variable), borderRadius: 2 }} />
        <span>0 – {AIR_VARIABLES[state.heat.variable].stops.at(-1)?.[0]} {AIR_VARIABLES[state.heat.variable].units}</span>
      </div>}
      {state.satellite && <div><b>Satellite · {state.satellite.label}</b> · {state.satellite.date} (UTC day)</div>}
      {state.credits.map((c) => <div key={c.text}><a href={c.termsUrl} target="_blank" rel="noreferrer noopener">{c.text}</a></div>)}
      {fallback ? <div><strong>WebGL unavailable: wind/air layers are not drawn on the 2D fallback.</strong></div> : null}
      {state.note ? <div>{state.note}</div> : null}
    </div>
  );
}
