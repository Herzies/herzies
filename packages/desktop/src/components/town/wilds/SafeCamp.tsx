import { WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { merge, paint } from "../airship/AirshipModel";
import { ambient, inSeason } from "../ambient";
import {
  cellAt,
  elevation,
  groundBlend,
  groundHeight,
  groundY,
  islandRadius,
  objectAt,
  type TownMap,
  terrainAt,
} from "../map";

/**
 * Where the Wilds' safe camp ends (WILDS_SAFE_CAMP, round the Sky Dock):
 * a line of warm light lying on the ground where the fighting starts,
 * bleeding a little way inward so the inside reads as the camp's, and a
 * low lantern post every few strides along it. Only over the island:
 * where the circle runs off the rim (round the dock) it fades out short of
 * the edge, and over open water it breaks.
 *
 * Two draw calls, built once: the light — the line and the lanterns'
 * panes, one unlit shader, brighter at night and never under the snow —
 * and the posts (Lambert, in season: snow on their caps).
 */

/** Points round the circle (~0.37 units apart at its radius). */
const SEGMENTS = 256;
/** How far the light bleeds in from the line, and out past it. */
const INNER = 1.6;
const OUTER = 0.2;
/** Above the ground, so it doesn't fight it for depth. */
const LIFT = 0.05;
/** The line stops this far in from the island's edge… */
const RIM_IN = 1;
/** …fading out over this far where it breaks off. */
const FADE = 1.5;
/** The swells of light running round the line at once. */
const SWELLS = 5;
/** Lantern posts round the whole circle (those off the island left out). */
const POSTS = 14;
/** Nudged along the line (in points) off a tree or a rock, at most. */
const NUDGE = 8;
/** Objects a post may stand in: nothing, tall grass, flowers. */
const POST_ROOM: Record<string, true> = { ".": true, v: true, "*": true };

const WOOD = "#8a5a32";
const WOOD_DARK = "#5a3a22";
const IRON = "#2b2d33";
/** A lantern post's light: its pane's size and middle's height. */
const PANE = { w: 0.16, h: 0.2, y: 0.98 };

/** Where the ground mesh lies (Ground.tsx: the land, dipping at banks). */
function surface(map: TownMap, x: number, z: number): number {
  return elevation(map, x, z) + groundHeight(groundBlend(map, x, z).wet);
}

/** Whether the line is drawn over this point: on the island, short of its
 * edge, and not over open water. */
function over(map: TownMap, x: number, z: number): boolean {
  if (Math.hypot(x, z) > islandRadius(map) - RIM_IN) return false;
  const [col, row] = cellAt(map, x, z);
  return terrainAt(map, col, row) !== "~";
}

const box = (
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  hex: string,
) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);

/** A lantern post, standing at the origin: all but its pane. */
function postParts(): THREE.BufferGeometry[] {
  const top = PANE.y + PANE.h / 2;
  return [
    box(0.2, 0.08, 0.2, 0, 0.04, 0, WOOD_DARK),
    box(0.1, 0.84, 0.1, 0, 0.42, 0, WOOD),
    box(0.24, 0.04, 0.24, 0, 0.86, 0, IRON),
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) =>
        box(0.03, PANE.h, 0.03, sx * 0.095, PANE.y, sz * 0.095, IRON),
      ),
    ),
    box(0.28, 0.05, 0.28, 0, top + 0.025, 0, IRON),
    box(0.07, 0.05, 0.07, 0, top + 0.075, 0, IRON),
  ];
}

type Camp = { light: THREE.BufferGeometry; posts: THREE.BufferGeometry };

/** The line and the posts along it, on `map`'s ground. */
function campParts(map: TownMap): Camp {
  const { x: cx, z: cz, r } = WILDS_SAFE_CAMP;
  const step = (2 * Math.PI * r) / SEGMENTS;
  const at = (i: number): [number, number] => {
    const a = (i / SEGMENTS) * 2 * Math.PI;
    return [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
  };
  const keep: boolean[] = [];
  for (let i = 0; i < SEGMENTS; i++) keep.push(over(map, ...at(i)));
  // How far along the line to the nearest break, each way round (twice
  // round, so one just past the seam reaches back across it).
  const gap = new Float32Array(SEGMENTS).fill(Number.POSITIVE_INFINITY);
  let last = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 2 * SEGMENTS; k++) {
    const i = k % SEGMENTS;
    if (!keep[i]) last = k;
    else gap[i] = Math.min(gap[i], (k - last) * step);
  }
  last = Number.POSITIVE_INFINITY;
  for (let k = 2 * SEGMENTS - 1; k >= 0; k--) {
    const i = k % SEGMENTS;
    if (!keep[i]) last = k;
    else gap[i] = Math.min(gap[i], (last - k) * step);
  }
  const fade = (i: number) => {
    if (!keep[i]) return 0;
    const t = Math.min(1, gap[i] / FADE);
    return t * t * (3 - 2 * t);
  };

  // The line: three rows of points round it (the inner edge of the bleed,
  // the line, the outer edge), each carrying (across, fade, along, kind).
  // Its first points again at the end, a whole way round along, so the
  // swell runs on across the seam (it fits round a whole number of times).
  const pos: number[] = [];
  const glow: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * 2 * Math.PI;
    const f = fade(i % SEGMENTS);
    for (const across of [-INNER, 0, OUTER]) {
      const x = cx + Math.cos(a) * (r + across);
      const z = cz + Math.sin(a) * (r + across);
      pos.push(x, surface(map, x, z) + LIFT, z);
      glow.push(across, f, i * step, 0);
    }
  }
  for (let i = 0; i < SEGMENTS; i++) {
    if (!keep[i] || !keep[(i + 1) % SEGMENTS]) continue;
    for (let row = 0; row < 2; row++) {
      const a = i * 3 + row;
      const b = a + 3;
      // Wound to face up: round (x towards z) then out.
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  // The posts, at even steps round the circle (half a step off the line's
  // east point, so two flank the way in), each nudged off whatever stands
  // there, and left out near a break or off the island.
  const posts: THREE.BufferGeometry[] = [];
  const pane = new THREE.BoxGeometry(PANE.w, PANE.h, PANE.w);
  const paneAt = pane.attributes.position;
  for (let p = 0; p < POSTS; p++) {
    const mid = Math.round(((p + 0.5) * SEGMENTS) / POSTS);
    let spot: [number, number] | null = null;
    for (let n = 0; n <= NUDGE && !spot; n++) {
      for (const s of n ? [n, -n] : [0]) {
        const i = (mid + s + SEGMENTS) % SEGMENTS;
        if (fade(i) < 1) continue;
        const [x, z] = at(i);
        const [col, row] = cellAt(map, x, z);
        if (!POST_ROOM[objectAt(map, col, row)]) continue;
        spot = [x, z];
        break;
      }
    }
    if (!spot) continue;
    const [x, z] = spot;
    const y = groundY(map, x, z);
    for (const g of postParts()) posts.push(g.translate(x, y, z));
    const base = pos.length / 3;
    for (let v = 0; v < paneAt.count; v++) {
      pos.push(
        paneAt.getX(v) + x,
        paneAt.getY(v) + y + PANE.y,
        paneAt.getZ(v) + z,
      );
      glow.push(0, 1, 0, 1);
    }
    for (const v of pane.index?.array ?? []) index.push(base + v);
  }
  pane.dispose();

  const light = new THREE.BufferGeometry();
  light.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  light.setAttribute("aGlow", new THREE.Float32BufferAttribute(glow, 4));
  light.setIndex(index);
  return { light, posts: merge(posts) };
}

/** The light: the line (a crisp core, a soft bleed inward, a slow swell
 * running round it) and the lanterns' panes, unlit, through the haze. */
function lightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: ambient.uTime,
      uNight: ambient.uNight,
      uSnow: ambient.uSnow,
      uLine: { value: new THREE.Color("#f2a533") },
      uLineSnow: { value: new THREE.Color("#e07514") },
      uLineNight: { value: new THREE.Color("#ffbb55") },
      uPane: { value: new THREE.Color("#e9b866") },
      uPaneNight: { value: new THREE.Color("#fff0c4") },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec4 aGlow;
      varying vec4 vGlow;
      void main() {
        vGlow = aGlow;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform float uNight;
      uniform float uSnow;
      uniform vec3 uLine;
      uniform vec3 uLineSnow;
      uniform vec3 uLineNight;
      uniform vec3 uPane;
      uniform vec3 uPaneNight;
      varying vec4 vGlow;
      void main() {
        float night = smoothstep(0.2, 0.8, uNight);
        if (vGlow.w > 0.5) {
          gl_FragColor = vec4(mix(uPane, uPaneNight, night), 1.0);
        } else {
          float d = vGlow.x;
          float line = 1.0 - smoothstep(0.08, 0.17, abs(d));
          float bleed = d < 0.0
            ? 1.0 - smoothstep(0.0, ${INNER.toFixed(2)}, -d)
            : 1.0 - smoothstep(0.0, ${OUTER.toFixed(2)}, d);
          bleed *= bleed;
          float swell = 0.82 + 0.18 * sin(
            vGlow.z * ${(SWELLS / WILDS_SAFE_CAMP.r).toFixed(5)} - uTime * 1.1
          );
          // Bolder, and a deeper amber, over the snow (or it'd wash out).
          float strong = max(night, uSnow);
          float a = line * mix(0.8, 1.0, strong) + bleed * mix(0.14, 0.32, strong);
          vec3 day = mix(uLine, uLineSnow, uSnow);
          gl_FragColor = vec4(mix(day, uLineNight, night), a * swell * vGlow.y);
        }
        #include <fog_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
}

/** The safe camp's edge on the Wilds (see above). */
export function SafeCamp({ map }: { map: TownMap }) {
  const parts = useMemo(() => {
    const camp = campParts(map);
    return {
      ...camp,
      lightMaterial: lightMaterial(),
      postMaterial: inSeason(
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
        }),
      ),
    };
  }, [map]);
  useEffect(
    () => () => {
      parts.light.dispose();
      parts.posts.dispose();
      parts.lightMaterial.dispose();
      parts.postMaterial.dispose();
    },
    [parts],
  );
  return (
    <>
      <mesh geometry={parts.light} material={parts.lightMaterial} />
      <mesh
        geometry={parts.posts}
        material={parts.postMaterial}
        castShadow
        receiveShadow
      />
    </>
  );
}
