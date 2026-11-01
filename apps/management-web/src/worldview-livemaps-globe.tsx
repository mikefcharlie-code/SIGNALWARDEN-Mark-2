import * as THREE from "three";
import { tilePatchGeometry } from "./worldview-basemap-globe";
import type { LiveOverlay, LiveOverlayChannel } from "./worldview-livemaps";

/** Satellite drapes just above the basemap (1.0025); radar above satellite. */
export const LIVE_OVERLAY_RADIUS: Readonly<Record<LiveOverlayChannel["channel"], number>> = { satellite: 1.0034, radar: 1.0042 };
export const MAX_LIVE_TILE_MESHES = 32;
export const MAX_LIVE_TEXTURES = 224;

type ChannelState = {
  layerId: string;
  group: THREE.Group;
  meshes: Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>;
  /** frameKey|tileKey -> texture; bounded LRU so playback never re-uploads loaded frames. */
  textures: Map<string, THREE.Texture>;
  signature: string;
};

function makeTexture(image: unknown): THREE.Texture {
  const texture = new THREE.Texture(image as any);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Animated, transparent tile overlays (radar / geostationary satellite) on the
 * globe. One mesh per visible tile per channel; switching frames swaps the
 * texture only. Everything is bounded and disposed on clear/dispose.
 */
export function createLiveOverlayGlobeLayer(parent: THREE.Object3D) {
  const root = new THREE.Group();
  root.name = "live-map-overlays";
  parent.add(root);
  const channels = new Map<string, ChannelState>();
  let lastSignature = "";

  const clearChannel = (name: string) => {
    const s = channels.get(name);
    if (!s) return;
    s.meshes.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
    s.textures.forEach((t) => t.dispose());
    root.remove(s.group);
    channels.delete(name);
  };
  const textureFor = (s: ChannelState, key: string, image: unknown) => {
    let tex = s.textures.get(key);
    if (tex) { s.textures.delete(key); s.textures.set(key, tex); return tex; }
    tex = makeTexture(image);
    s.textures.set(key, tex);
    if (s.textures.size > MAX_LIVE_TEXTURES) {
      const inUse = new Set<THREE.Texture | null>([tex]);
      s.meshes.forEach((m) => inUse.add(m.material.map));
      for (const [oldKey, old] of s.textures) {
        if (s.textures.size <= MAX_LIVE_TEXTURES) break;
        if (inUse.has(old)) continue;
        s.textures.delete(oldKey);
        old.dispose();
      }
    }
    return tex;
  };

  const syncChannel = (c: LiveOverlayChannel) => {
    let s = channels.get(c.channel);
    if (s && s.layerId !== c.layerId) { clearChannel(c.channel); s = undefined; }
    if (!s) {
      const group = new THREE.Group();
      group.name = `live-${c.channel}`;
      root.add(group);
      s = { layerId: c.layerId, group, meshes: new Map(), textures: new Map(), signature: "" };
      channels.set(c.channel, s);
    }
    const tiles = c.tiles.filter((t) => !!t.image).slice(0, MAX_LIVE_TILE_MESHES);
    const opacity = Math.max(0, Math.min(1, Number.isFinite(c.opacity) ? c.opacity : 0.75));
    const signature = `${c.frameKey}|${opacity}|${tiles.map((t) => t.key).join(",")}`;
    if (signature === s.signature) return;
    s.signature = signature;
    const wanted = new Set(tiles.map((t) => t.key));
    for (const [key, mesh] of s.meshes) {
      if (!wanted.has(key)) { mesh.visible = false; }
    }
    // Drop meshes for tiles that left the viewport entirely (keeps the mesh count bounded).
    if (s.meshes.size > MAX_LIVE_TILE_MESHES) {
      for (const [key, mesh] of [...s.meshes]) if (!wanted.has(key)) { mesh.geometry.dispose(); mesh.material.dispose(); s.group.remove(mesh); s.meshes.delete(key); }
    }
    for (const t of tiles) {
      let mesh = s.meshes.get(t.key);
      if (!mesh) {
        const geometry = tilePatchGeometry({ key: t.key, tile: t.tile }, 0, LIVE_OVERLAY_RADIUS[c.channel]);
        mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide }));
        mesh.renderOrder = c.channel === "radar" ? 3 : 2;
        s.group.add(mesh);
        s.meshes.set(t.key, mesh);
      }
      mesh.material.map = textureFor(s, `${c.frameKey}|${t.key}`, t.image);
      mesh.material.opacity = opacity;
      mesh.material.needsUpdate = true;
      mesh.visible = true;
    }
  };

  const sync = (overlay: LiveOverlay | null | undefined) => {
    const list = (overlay?.channels ?? []).slice(0, 2);
    const signature = list.map((c) => `${c.channel}:${c.layerId}:${c.frameKey}:${c.opacity}:${c.tiles.length}`).join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;
    const active = new Set(list.map((c) => c.channel));
    [...channels.keys()].filter((k) => !active.has(k as LiveOverlayChannel["channel"])).forEach(clearChannel);
    list.forEach(syncChannel);
  };
  const dispose = () => { [...channels.keys()].forEach(clearChannel); parent.remove(root); };
  return {
    sync,
    dispose,
    get meshCount() { let n = 0; channels.forEach((s) => (n += s.meshes.size)); return n; },
    get textureCount() { let n = 0; channels.forEach((s) => (n += s.textures.size)); return n; },
  };
}

/** Always-visible credit + frame time while a live map layer is draped on the globe. */
export function WorldGlobeLiveCredits({ overlay, fallback }: { overlay?: LiveOverlay | null; fallback: boolean }) {
  if (!overlay || !overlay.channels.length) return null;
  return (
    <div className="globe-live-credit" role="note" aria-label="Live map layer credits and frame times" style={{ position: "absolute", left: 8, top: 8, zIndex: 6, maxWidth: "min(420px, 60%)", display: "flex", flexDirection: "column", gap: 2, padding: "3px 7px", borderRadius: 3, background: "rgba(3,16,22,.82)", color: "#e6f3ed", font: "10px/1.35 system-ui, sans-serif", overflowWrap: "anywhere" }}>
      {overlay.channels.map((c) => (
        <span key={c.channel}>
          <b>{c.channel === "radar" ? "RADAR" : "SATELLITE"} · FEED {c.freshness.toUpperCase()}</b> · displayed frame {c.frameTime.slice(0, 16).replace("T", " ")} UTC ·{" "}
          <a href={c.credit.termsUrl} target="_blank" rel="noreferrer noopener">{c.credit.text}</a>
        </span>
      ))}
      {fallback ? <span><strong>WebGL unavailable: live map tiles are not drawn on the 2D schematic fallback.</strong></span> : null}
    </div>
  );
}
