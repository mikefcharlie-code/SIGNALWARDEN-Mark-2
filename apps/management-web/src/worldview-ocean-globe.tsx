import * as THREE from "three";
import { tilePatchGeometry } from "./worldview-basemap-globe";
import type { TileCoord } from "./worldview-basemap";

/** One draped ocean overlay (map layer and/or marine grid paint), above any basemap. */
export type OceanGlobeOverlay = Readonly<{
  /** Changes whenever layer/date/grid changes, so the globe drops old textures. */
  sourceId: string;
  tiles: ReadonlyArray<Readonly<{ key: string; tile: TileCoord; image?: unknown }>>;
  opacity: number;
  credits: ReadonlyArray<Readonly<{ provider: string; text: string; termsUrl: string }>>;
  note?: string;
}>;

export const MAX_OCEAN_MESHES = 48;
const OVERLAY_RADIUS = 1.006;

/** Bounded set of transparent textured tile meshes draped above the basemap. */
export function createOceanGlobeLayer(parent: THREE.Object3D) {
  const root = new THREE.Group();
  root.name = "ocean-overlay-tiles";
  root.renderOrder = 2;
  parent.add(root);
  const meshes = new Map<string, THREE.Mesh>();
  let lastSignature = "";
  let lastSource = "";
  const drop = (key: string) => {
    const mesh = meshes.get(key);
    if (!mesh) return;
    mesh.geometry.dispose();
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
    root.remove(mesh);
    meshes.delete(key);
  };
  const sync = (overlay: OceanGlobeOverlay | null | undefined) => {
    const tiles = (overlay?.tiles ?? []).filter((t) => t.image).slice(0, MAX_OCEAN_MESHES);
    const signature = `${overlay?.sourceId ?? ""}|${overlay?.opacity ?? 0}|${tiles.map((t) => t.key).join(",")}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    if ((overlay?.sourceId ?? "") !== lastSource) { [...meshes.keys()].forEach(drop); lastSource = overlay?.sourceId ?? ""; }
    const wanted = new Set(tiles.map((t) => t.key));
    [...meshes.keys()].filter((k) => !wanted.has(k)).forEach(drop);
    for (const tile of tiles) {
      if (meshes.has(tile.key)) { (meshes.get(tile.key)!.material as THREE.MeshBasicMaterial).opacity = overlay!.opacity; continue; }
      const texture = new THREE.Texture(tile.image as TexImageSource as any);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      const mesh = new THREE.Mesh(tilePatchGeometry({ key: tile.key, tile: tile.tile }, 0, OVERLAY_RADIUS), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: overlay!.opacity, depthWrite: false }));
      mesh.renderOrder = 2;
      root.add(mesh);
      meshes.set(tile.key, mesh);
    }
  };
  const dispose = () => { [...meshes.keys()].forEach(drop); parent.remove(root); };
  return { sync, dispose, get size() { return meshes.size; } };
}

/** On-globe credit and not-for-navigation notice; visible whenever an ocean overlay is enabled. */
export function OceanGlobeCredits({ overlay, fallback = false }: { overlay?: OceanGlobeOverlay | null; fallback?: boolean }) {
  if (!overlay || !overlay.credits.length) return null;
  return (
    <div className="globe-ocean-credit" role="note" aria-label="Ocean layer credits" style={{ position: "absolute", left: 8, bottom: 8, zIndex: 6, maxWidth: "min(420px, 60%)", display: "flex", flexWrap: "wrap", gap: "2px 8px", padding: "3px 7px", borderRadius: 3, background: "rgba(3,16,30,.85)", color: "#e3f1fb", font: "10px/1.35 system-ui, sans-serif", overflowWrap: "anywhere" }}>
      {overlay.credits.map((c) => <span key={c.provider}><a href={c.termsUrl} target="_blank" rel="noreferrer noopener">{c.text}</a></span>)}
      <span><strong>NOT FOR NAVIGATION</strong></span>
      {overlay.note ? <span>{overlay.note}</span> : null}
      {fallback ? <span><strong>2D fallback: ocean raster not rendered.</strong></span> : null}
    </div>
  );
}
