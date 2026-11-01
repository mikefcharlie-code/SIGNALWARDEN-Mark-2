import * as THREE from "three";
import { globeVector } from "./worldview-globe-math";
import { sampleGrid, tileYToLat, type GlobeBasemap, type GlobeBasemapTile } from "./worldview-basemap";

const SEGMENTS = 16;
const BASE_RADIUS = 1.0025;
const EARTH_RADIUS_M = 6_371_000;
export const MAX_GLOBE_TILE_MESHES = 64;

/**
 * Builds one spherical patch per Web Mercator tile. Vertices are spaced
 * linearly in Mercator Y, so the texture maps without reprojection; with relief
 * enabled each vertex is pushed outward by exaggerated DEM height.
 */
export function tilePatchGeometry(tile: GlobeBasemapTile, exaggeration: number, radius = BASE_RADIUS): THREE.BufferGeometry {
  const { z, x, y } = tile.tile;
  const n = 2 ** z;
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  const heights = tile.heights;
  const relief = heights && exaggeration > 0 ? exaggeration : 0;
  for (let j = 0; j <= SEGMENTS; j++) {
    const v = j / SEGMENTS;
    const lat = tileYToLat(y + v, z);
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      const lon = ((x + u) / n) * 360 - 180;
      let r = radius;
      if (relief && heights) {
        const h = sampleGrid(heights.heights, heights.width, heights.height, u * (heights.width - 1), v * (heights.height - 1));
        r += (Math.max(0, h) / EARTH_RADIUS_M) * relief;
      }
      positions.push(...globeVector(lat, lon, r));
      // flipY=false textures: v=0 is the first (northernmost) image row.
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < SEGMENTS; j++)
    for (let i = 0; i < SEGMENTS; i++) {
      const a = j * (SEGMENTS + 1) + i, b = a + 1, c = a + SEGMENTS + 1, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function textureFor(image: unknown): THREE.Texture | null {
  if (!image) return null;
  const texture = new THREE.Texture(image as TexImageSource as any);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function shadeTexture(shade: Uint8ClampedArray): THREE.DataTexture {
  const side = Math.round(Math.sqrt(shade.length / 4));
  const texture = new THREE.DataTexture(new Uint8Array(shade.buffer, shade.byteOffset, shade.byteLength), side, side, THREE.RGBAFormat);
  texture.flipY = false;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

type Entry = { signature: string; group: THREE.Group };

/** Bounded set of textured tile meshes attached to the globe group. */
export function createBasemapGlobeLayer(parent: THREE.Object3D) {
  const root = new THREE.Group();
  root.name = "basemap-tiles";
  parent.add(root);
  const entries = new Map<string, Entry>();
  let lastSource = "";
  let lastSignature = "";
  const drop = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entry.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      material?.map?.dispose();
      material?.dispose();
    });
    root.remove(entry.group);
    entries.delete(key);
  };
  const sync = (basemap: GlobeBasemap | null | undefined) => {
    const tiles = (basemap?.tiles ?? []).slice(0, MAX_GLOBE_TILE_MESHES);
    const exaggeration = basemap?.reliefExaggeration ?? 0;
    const signature = `${basemap?.sourceId ?? ""}|${exaggeration}|${tiles.map((t) => `${t.key}:${t.image ? 1 : 0}${t.shade ? 1 : 0}${t.heights ? 1 : 0}`).join(",")}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    if ((basemap?.sourceId ?? "") !== lastSource) {
      [...entries.keys()].forEach(drop);
      lastSource = basemap?.sourceId ?? "";
    }
    const wanted = new Set(tiles.map((t) => t.key));
    [...entries.keys()].filter((k) => !wanted.has(k)).forEach(drop);
    for (const tile of tiles) {
      const tileSig = `${tile.image ? 1 : 0}${tile.shade ? 1 : 0}${tile.heights ? 1 : 0}|${exaggeration}`;
      if (entries.get(tile.key)?.signature === tileSig) continue;
      drop(tile.key);
      const group = new THREE.Group();
      const geometry = tilePatchGeometry(tile, exaggeration);
      const map = textureFor(tile.image);
      if (map) group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, side: THREE.FrontSide })));
      else if (tile.shade || tile.heights) group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x5c7f7a, side: THREE.FrontSide })));
      if (tile.shade) {
        const overlay = new THREE.Mesh(geometry.clone(), new THREE.MeshBasicMaterial({ map: shadeTexture(tile.shade), transparent: true, depthWrite: false, opacity: 0.85 }));
        overlay.scale.setScalar(1.0004);
        overlay.renderOrder = 1;
        group.add(overlay);
      }
      if (!group.children.length) { geometry.dispose(); continue; }
      root.add(group);
      entries.set(tile.key, { signature: tileSig, group });
    }
  };
  const dispose = () => { [...entries.keys()].forEach(drop); parent.remove(root); };
  return { sync, dispose, get size() { return entries.size; } };
}

/** On-screen provider credit; always visible while any basemap layer is enabled. */
export function WorldGlobeBasemapCredits({ basemap, fallback }: { basemap?: GlobeBasemap | null; fallback: boolean }) {
  if (!basemap || !basemap.credits.length) return null;
  return (
    <div className="globe-basemap-credit" role="note" aria-label="Imagery and terrain provider credits" style={{ position: "absolute", right: 8, bottom: 8, zIndex: 6, maxWidth: "min(460px, 70%)", display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "2px 8px", padding: "3px 7px", borderRadius: 3, background: "rgba(3,16,22,.82)", color: "#e6f3ed", font: "10px/1.35 system-ui, sans-serif", overflowWrap: "anywhere" }}>
      {basemap.credits.map((c) => (
        <span key={c.provider}>
          {c.provider === "google-2d-satellite" ? <img src="/google-maps-logo-with-dark-outline.svg" alt="Google Maps" style={{ height: 16, width: "auto", verticalAlign: "middle", marginRight: 4 }} /> : null}
          <a href={c.termsUrl} target="_blank" rel="noreferrer noopener">{c.text}</a>
        </span>
      ))}
      {fallback ? <span><strong>WebGL unavailable: provider tiles are not drawn on the 2D schematic fallback.</strong></span> : null}
      {basemap.note ? <span>{basemap.note}</span> : null}
    </div>
  );
}
