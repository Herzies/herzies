import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { seeThrough } from "../ambient";
import { lanternMaterial, windowMaterial } from "../Buildings";
import { lanternGlassGeometry } from "../Lamps";
import { type BellPose, CLAPPER_HIT, poseBell } from "./bell";
import {
  DECK_OBSTACLES,
  DECK_OUTLINE,
  GANGWAY,
  PLANK_HINGE,
  PLANK_WIDTH,
  RAIL_HEIGHT,
  RAIL_THICKNESS,
  railRuns,
} from "./deck";

/**
 * A sky ship, drawn: a wooden hull with a deck you walk on, low rails with
 * lanterns, a helm at the stern and a bell at the bow, stubby wings with a
 * propeller each, and a big striped balloon riding on rigging high
 * overhead — out of the camera's way (it orbits 12 behind and at most ~9
 * up), and dithered where it comes between the camera and the player.
 *
 * Everything is in the deck's own frame (deck.ts): the deck's surface is
 * the plane y = 0 and nothing stands on it but the helm and the bell
 * post (DECK_OBSTACLES), so the rails you see are the rails you bump and
 * the deck you see is the deck you walk on. The ship's flight (heave,
 * bank, the route) moves `root`; this only animates what moves on board,
 * from the time and the ship's motion, so every client sees the same.
 * (The propellers' angle is the one thing summed frame by frame: a spin
 * worked out from `rps × t` would race whenever the rpm changes.)
 *
 * Ten draw calls at most (fewer in flight, when the gangplank is away):
 * the hull and all that's fixed to it, the portholes, the lanterns, the
 * balloon, the wings, the propellers, the flags, the wheel, the bell,
 * the gangplank.
 */

/** What the ship is doing, as its model shows it. */
export type ShipMotion = {
  /** Forward airspeed, u/s (0–10). */
  speed: number;
  /** How hard the engines are working, 0–1: the propellers' spin. */
  throttle: number;
  /** Forward acceleration, u/s²: the balloon lags behind it. */
  accel: number;
  /** How fast it's turning, rad/s; + is turning left (toward +x). */
  turnRate: number;
  /** 0 flying – 1 tied up at a dock: the wings folded. */
  moored: number;
  /** 0 stowed – 1 run out to `gangplankTo`. */
  gangplank: number;
  /** Where the run-out gangplank's end rests, deck-local, at z = 0: x past
   * the gangway (≈ 4.5 + 4..9), y below the deck (≈ −1.3). */
  gangplankTo: { x: number; y: number };
  /** A gust of wind, −1..1: flags stream, the balloon ripples. */
  gust: number;
  /** Seconds since the ship's bell began ringing (as its sound started;
   * Infinity: not lately), and how many strikes it rang (bell.ts). */
  bell: number;
  bellStrikes: number;
};

/** A ship sitting still with its engines off, everything stowed. */
export const SHIP_AT_REST: ShipMotion = {
  speed: 0,
  throttle: 0,
  accel: 0,
  turnRate: 0,
  moored: 0,
  gangplank: 0,
  gangplankTo: { x: 9, y: -1.3 },
  gust: 0,
  bell: Number.POSITIVE_INFINITY,
  bellStrikes: 0,
};

// --- Building blocks, shared with the dock (DockModel) -------------------------

/** A part painted one colour, ready to merge into a vertex-coloured mesh:
 * flat, uv-less, with the `surface` it's planked as (see `planked`). */
export function paint(
  g: THREE.BufferGeometry,
  hex: string,
  surface: Surface = Surface.Plain,
): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  if (!out.attributes.normal) out.computeVertexNormals();
  const n = out.attributes.position.count;
  const c = new THREE.Color(hex);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  out.setAttribute(
    "surface",
    new THREE.BufferAttribute(new Float32Array(n).fill(surface), 1),
  );
  return out;
}

/** Merge parts that all have the same attributes (a mismatch is a bug). */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts);
  if (!out) throw new Error("airship: parts don't merge");
  for (const p of parts) p.dispose();
  return out;
}

/** What a face is made of, as `planked` draws it. */
export enum Surface {
  Plain = 0,
  /** Deck boards, running along z, side by side across x. */
  Deck = 1,
  /** Hull strakes: running along z, stacked up y. */
  Strakes = 2,
  /** Boards running across x, side by side along z (a pier). */
  Across = 3,
}

/**
 * Draw planks onto a vertex-coloured material, from each vertex's own
 * (object-space) position and its `surface`: every board its own tone,
 * dark seams between them and staggered butt joints — chunky enough to
 * read at the Town's big pixels, and fading to their average far off so
 * they never alias into swimming stripes. Chains onto whatever the
 * material already patches.
 */
export function planked<M extends THREE.Material>(material: M): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute float surface;
varying float vPlankSurface;
varying vec3 vPlankPos;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
vPlankSurface = surface;
vPlankPos = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying float vPlankSurface;
varying vec3 vPlankPos;
float plankHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
if ( vPlankSurface > 0.5 ) {
  // Across the boards (u) and along them (v), and how wide one is.
  float u = vPlankPos.x;
  float v = vPlankPos.z;
  float W = 0.42;
  float L = 2.6;
  if ( vPlankSurface > 2.5 ) {
    u = vPlankPos.z;
    v = vPlankPos.x;
    W = 0.38;
    L = 9.0;
  } else if ( vPlankSurface > 1.5 ) {
    u = vPlankPos.y;
    v = vPlankPos.z + vPlankPos.x * 0.3;
    W = 0.34;
    L = 3.4;
  }
  float px = max( fwidth( u ), fwidth( v ) );
  float row = floor( u / W );
  float f = fract( u / W );
  float along = v / L + plankHash( vec2( row, 7.0 ) );
  float joint = floor( along );
  float tone = 0.86 + 0.24 * plankHash( vec2( row, joint ) );
  float seam = 1.0 - smoothstep( 0.0, px * 1.5 / W, min( f, 1.0 - f ) );
  float butt = 1.0 - smoothstep( 0.0, px * 1.5, fract( along ) * L );
  float shade = tone * ( 1.0 - 0.42 * max( seam, butt ) );
  diffuseColor.rgb *= mix( shade, 0.9, smoothstep( 0.3 * W, 0.7 * W, px ) );
}`,
      );
  };
  material.customProgramCacheKey = () => `${key()}:planked`;
  return material;
}

/** Live values for `fluttering` (one set per material). */
export type Flutter = {
  /** The time, wrapped (see `wrapTime`). */
  uFlapT: { value: number };
  /** 0 hanging limp – 1 streaming straight out. */
  uStream: { value: number };
  /** How far it ripples, world units at its free end. */
  uFlutter: { value: number };
};

export const flutterUniforms = (): Flutter => ({
  uFlapT: { value: 0 },
  uStream: { value: 0 },
  uFlutter: { value: 0 },
});

/**
 * Make cloth flap: a flag, a pennant, a windsock. Each is modelled
 * streaming straight out along its local −z from an `anchor` (where it's
 * tied on), each vertex knowing how far `along` it is; the shader lets it
 * droop toward hanging as the wind drops (turned about x at its anchor)
 * and ripples it side to side, more toward the free end — two waves at
 * fixed frequencies whose strength rises with the wind, so it looks
 * quicker in a stronger wind without ever jumping.
 */
export function fluttering<M extends THREE.Material>(
  material: M,
  u: Flutter,
): M {
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute vec3 anchor;
attribute float along;
uniform float uFlapT;
uniform float uStream;
uniform float uFlutter;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
{
  vec3 rel = transformed - anchor;
  // Droop: turn the cloth down about its anchor as the wind drops.
  float droop = ( 1.0 - uStream ) * 1.3;
  float c = cos( droop );
  float s = sin( droop );
  rel = vec3( rel.x, rel.y * c + rel.z * s, -rel.y * s + rel.z * c );
  // Ripples running down it, pinned where it's tied.
  float w = clamp( along / 1.4, 0.0, 1.6 );
  w *= w;
  float big = sin( along * 3.2 - uFlapT * ${(2 * Math.PI * 1.5).toFixed(5)} );
  float quick = sin( along * 5.3 - uFlapT * ${(2 * Math.PI * 2.6).toFixed(5)} + 1.3 );
  rel.x += uFlutter * w * ( big + uStream * 0.6 * quick );
  rel.y += uFlutter * 0.3 * w * sin( along * 2.3 - uFlapT * ${(2 * Math.PI * 1.5).toFixed(5)} + 0.7 );
  transformed = anchor + rel;
}`,
      );
  };
  material.customProgramCacheKey = () => `${key()}:flutter`;
  return material;
}

/** Give cloth its `anchor` and `along` (see `fluttering`): streaming
 * along −z from `anchor`. */
export function cloth(
  g: THREE.BufferGeometry,
  anchor: THREE.Vector3,
): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const anchors = new Float32Array(pos.count * 3);
  const along = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    anchor.toArray(anchors, i * 3);
    along[i] = Math.max(0, anchor.z - pos.getZ(i));
  }
  g.setAttribute("anchor", new THREE.BufferAttribute(anchors, 3));
  g.setAttribute("along", new THREE.BufferAttribute(along, 1));
  return g;
}

/** Shader time, wrapped every 10 minutes so a float32 never loses its
 * precision; every frequency the shaders use repeats in exactly that. */
export function wrapTime(t: number): number {
  return ((t % 600) + 600) % 600;
}

/** A blocky pixel font, five pixels high: what the ship's name board and
 * the dock's signs are lettered in, built of little boxes so it's as
 * crisp as the rest of the Town and costs no texture or draw call. A
 * glyph with more than five rows has the extra ones above the line (an
 * accent: Å's ring, sitting on the A's point). */
const GLYPHS: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  Å: [".#.", "#.#", ".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "#.#", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  ">": ["#..", ".#.", "..#", ".#.", "#.."],
  "-": ["...", "...", "###", "...", "..."],
  "!": ["#", "#", "#", ".", "#"],
  " ": ["..", "..", "..", "..", ".."],
};

/** How many rows over the line `text`'s tallest accent reaches. */
function accentRows(text: string): number {
  let rows = 0;
  for (const ch of text.toUpperCase())
    rows = Math.max(rows, (GLYPHS[ch] ?? GLYPHS[" "]).length - 5);
  return rows;
}

/** How wide `text` comes out in pixelText, at `px` a pixel. */
function pixelTextWidth(text: string, px: number): number {
  let w = 0;
  for (const ch of text.toUpperCase())
    w += ((GLYPHS[ch] ?? GLYPHS[" "])[0].length + 1) * px;
  return Math.max(0, w - px);
}

/** `text` in the pixel font, `px` a pixel and `depth` deep: centred on
 * the origin (accents and all), reading along +x, its face toward +z (its
 * back at z = 0). */
export function pixelText(
  text: string,
  px: number,
  depth: number,
  hex: string,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let x = -pixelTextWidth(text, px) / 2;
  const drop = accentRows(text) / 2;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    // Row r's height over the line's middle, in pixels.
    const top = 2 + glyph.length - 5 - drop;
    glyph.forEach((row, r) => {
      // Each run of lit pixels in a row as one box.
      for (let c = 0; c < row.length; ) {
        if (row[c] !== "#") {
          c++;
          continue;
        }
        let e = c;
        while (e < row.length && row[e] === "#") e++;
        parts.push(
          paint(
            new THREE.BoxGeometry((e - c) * px, px, depth).translate(
              x + ((c + e) / 2) * px,
              (top - r) * px,
              depth / 2,
            ),
            hex,
          ),
        );
        c = e;
      }
    });
    x += (glyph[0].length + 1) * px;
  }
  return merge(parts);
}

/** A ship's bell, `r` across at the mouth, hanging from the origin: a
 * flared bronze lathe with a clapper — a rod and ball hung from the crown,
 * its ball peeping out under the mouth. The clapper swings on two morph
 * targets, out to the rim either side (±CLAPPER_HIT about x, the yoke's
 * axis; `swingClapper`), so a ringing bell is still one draw call; the
 * blend between rest and rim is a chord, a hair short of the arc. */
export function bellGeometry(r: number): THREE.BufferGeometry {
  const profile = [
    [0, 0],
    [0.45, 0],
    [0.55, -0.25],
    [0.62, -0.7],
    [0.85, -1.05],
    [1, -1.15],
    [0.9, -1.18],
  ].map(([x, y]) => new THREE.Vector2(x * r, y * r));
  const clapper = [
    paint(
      new THREE.BoxGeometry(r * 0.07, r * 0.88, r * 0.07).translate(
        0,
        -r * 0.52,
        0,
      ),
      "#8a6a2a",
    ),
    paint(
      new THREE.SphereGeometry(r * 0.2, 6, 4).translate(0, -r * 1.06, 0),
      "#8a6a2a",
    ),
  ];
  const swung = clapper.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = merge([
    paint(new THREE.LatheGeometry(profile, 8), "#c9a24a"),
    paint(
      new THREE.TorusGeometry(r * 0.25, r * 0.07, 4, 8).translate(
        0,
        r * 0.08,
        0,
      ),
      "#8a6a2a",
    ),
    ...clapper,
  ]);
  // The clapper's vertices are the last `swung`: turned out to the rim.
  const rest = out.attributes.position.array as Float32Array;
  const from = out.attributes.position.count - swung;
  out.morphAttributes.position = [CLAPPER_HIT, -CLAPPER_HIT].map((a) => {
    const p = rest.slice();
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let i = from * 3; i < p.length; i += 3) {
      const y = p[i + 1];
      const z = p[i + 2];
      p[i + 1] = y * c - z * s;
      p[i + 2] = y * s + z * c;
    }
    return new THREE.BufferAttribute(p, 3);
  });
  return out;
}

/** Swing a bellGeometry mesh's clapper to `angle` rad about the yoke
 * (±CLAPPER_HIT: at the rim). */
export function swingClapper(bell: THREE.Mesh, angle: number): void {
  const w = bell.morphTargetInfluences;
  if (!w) return;
  w[0] = Math.max(0, angle) / CLAPPER_HIT;
  w[1] = Math.max(0, -angle) / CLAPPER_HIT;
}

/** A ship's (or the dock's) lantern, standing at y: an iron base, four
 * corner bars and a pyramid cap round its glass — big enough to read as a
 * light from across the sky. The glass is instanced apart (`lanternGlass`). */
const LANTERN = 1.25;
export function lanternFrame(
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry[] {
  const iron = "#2b2d33";
  const s = LANTERN;
  return [
    paint(
      new THREE.BoxGeometry(0.3 * s, 0.05 * s, 0.3 * s).translate(
        x,
        y + 0.025 * s,
        z,
      ),
      iron,
    ),
    ...[
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].map(([sx, sz]) =>
      paint(
        new THREE.BoxGeometry(0.035 * s, 0.36 * s, 0.035 * s).translate(
          x + sx * 0.13 * s,
          y + 0.23 * s,
          z + sz * 0.13 * s,
        ),
        iron,
      ),
    ),
    paint(
      new THREE.ConeGeometry(0.25 * s, 0.2 * s, 4)
        .rotateY(Math.PI / 4)
        .translate(x, y + 0.51 * s, z),
      iron,
    ),
    paint(
      new THREE.SphereGeometry(0.04 * s, 5, 3).translate(x, y + 0.64 * s, z),
      iron,
    ),
  ];
}
/** Where the glass goes in a lantern standing at y. */
export const lanternGlassAt = (
  x: number,
  y: number,
  z: number,
): THREE.Matrix4 =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y + 0.23 * LANTERN, z),
    new THREE.Quaternion(),
    new THREE.Vector3().setScalar(0.72 * LANTERN),
  );

/** The lantern glass, instanced: lit at dusk and flickering, each its own
 * way (lanternMaterial works that out from where each one is). */
export function lanternGlass(at: THREE.Matrix4[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    lanternGlassGeometry,
    lanternMaterial,
    at.length,
  );
  at.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
  });
  mesh.computeBoundingSphere();
  return mesh;
}

// --- The ship ------------------------------------------------------------------

/** Blåmann's colours and name. */
const LOOK = {
  name: "BLÅMANN",
  stripe: "#5b86c9",
  cream: "#eef0e4",
  accent: "#3d5f9e",
  plate: "#f4ead3",
} as const;

const DECK_WOOD = "#c19a62";
const WOOD = "#a8743f";
const WOOD_LIGHT = "#b98450";
const WOOD_MID = "#8a5a34";
const WOOD_DARK = "#6b4528";
const KEEL = "#4a3020";
const POST = "#6e4a2a";
const IRON = "#2b2d33";
const BRASS = "#c9a24a";
const RIGGING = "#5a4632";
const ROPE = "#cdb48a";

/** The balloon: its middle, and its half-length and radii. */
const ENVELOPE = { y: 15.6, z: -0.5, rx: 4.6, ry: 4.2, rz: 12.5 };
/** How high the balloon's underside rides over the deck: well over the
 * camera, which orbits at most ~9 over the player. */
export const ENVELOPE_BOTTOM = ENVELOPE.y - ENVELOPE.ry;
/** It's slimmer toward the tail: the radius there, times this. */
const TAIL_TAPER = 0.12;

/** The balloon's radius scale at z (along it), 0 past its ends. */
function envelopeGirth(z: number): number {
  const s = (z - ENVELOPE.z) / ENVELOPE.rz;
  if (Math.abs(s) >= 1) return 0;
  return Math.sqrt(1 - s * s) * (s < 0 ? 1 + TAIL_TAPER * s : 1);
}

/** The balloon's underside at (x, z): where the rigging ties on. */
function envelopeUnder(x: number, z: number): number {
  const g = envelopeGirth(z);
  const rx = ENVELOPE.rx * g;
  const k = Math.max(0, 1 - (x / rx) ** 2);
  return ENVELOPE.y - ENVELOPE.ry * g * Math.sqrt(k);
}

/** The outline pushed out `d` along each corner's mitre (the rail's
 * outside face, the hull's top). */
function offsetOutline(d: number): [number, number][] {
  const pts = DECK_OUTLINE;
  const n = pts.length;
  return pts.map(([x, z], i) => {
    const [px, pz] = pts[(i - 1 + n) % n];
    const [nx, nz] = pts[(i + 1) % n];
    const a = outward(px, pz, x, z);
    const b = outward(x, z, nx, nz);
    const mx = a[0] + b[0];
    const mz = a[1] + b[1];
    const ml = Math.hypot(mx, mz);
    const scale = d / ((mx / ml) * a[0] + (mz / ml) * a[1]);
    return [x + (mx / ml) * scale, z + (mz / ml) * scale];
  });
}

/** The outward normal of the outline's edge from (x0, z0) to (x1, z1)
 * (the outline runs so that it's on the right). */
function outward(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): [number, number] {
  const l = Math.hypot(x1 - x0, z1 - z0);
  return [(z1 - z0) / l, -(x1 - x0) / l];
}

/** The port rail's line (x) at z, from the outline (stern to bow). */
function portRailX(z: number): number {
  const port = DECK_OUTLINE.slice(
    0,
    DECK_OUTLINE.findIndex(([x]) => x === 0) + 1,
  );
  for (let i = 0; i < port.length - 1; i++) {
    const [x0, z0] = port[i];
    const [x1, z1] = port[i + 1];
    if (z >= z0 && z <= z1) return x0 + ((x1 - x0) * (z - z0)) / (z1 - z0);
  }
  return z < port[0][1] ? port[0][0] : 0;
}

/** How far under the hinge the gangplank slides in and out: its cleats
 * stand 0.035 over its top, which at the hinge (a hair under the deck)
 * would poke up through the deck's boards while it's indoors. It rises
 * to the hinge as it tips, so where it lands doesn't change. */
const PLANK_STOW_DROP = 0.07;

/**
 * The gangplank's pose at `g` (0 stowed – 1 run out) to `to`: it slides
 * out level from inside the hull, through a slot under the gangway, a
 * little under the deck (PLANK_STOW_DROP), then tips down onto the pier
 * as it rises to the hinge and its handrails stand up. `x`, `y` are its
 * inner end's top (deck-local, at z = 0), `pitch` its slope (radians, −
 * down), `length` hinge to `to`, `rise` how far its handrails are up.
 */
export function gangplankPose(
  g: number,
  to: { x: number; y: number },
): { x: number; y: number; pitch: number; length: number; rise: number } {
  const dx = to.x - PLANK_HINGE.x;
  const dy = to.y - PLANK_HINGE.y;
  const length = Math.hypot(dx, dy);
  const slide = THREE.MathUtils.smoothstep(g, 0, 0.6);
  const tip = THREE.MathUtils.smoothstep(g, 0.6, 1);
  return {
    x: PLANK_HINGE.x - length * (1 - slide),
    y: PLANK_HINGE.y - PLANK_STOW_DROP * (1 - tip),
    pitch: Math.atan2(dy, dx) * tip,
    length,
    rise: THREE.MathUtils.smoothstep(g, 0.62, 0.9),
  };
}

/** Rail posts (outline corners) that carry a lantern, and the bow's
 * pennant poles. */
const LANTERN_POSTS: [number, number][] = [
  [4.5, -4],
  [4.5, 3.5],
  [3.4, -11],
  [3.0, 9.0],
];
const PENNANT_POSTS: [number, number][] = [[1.6, 10.9]];

/** The wings: where along the hull, the hinge's height, the span and the
 * folds (flying: a little dihedral; moored: folded up out of the way of
 * the island's rim). */
const WING = { z: -6.5, y: -0.3, span: 2.6, flying: 0.12, folded: 1.15 };
const PROP_RADIUS = 1;
/** Fastest propeller spin, rev/s; past ~4 the blades blur into a disc. */
const MAX_RPS = 7;

const HELM = DECK_OBSTACLES[0];
const BELL = DECK_OBSTACLES[1];
const WHEEL_AT = new THREE.Vector3(HELM.x, 1.12, HELM.z - 0.34);
const BELL_AT = new THREE.Vector3(BELL.x, 2.14, BELL.z);

const clamp = THREE.MathUtils.clamp;
const smooth = (x: number) => THREE.MathUtils.smoothstep(x, 0, 1);

/** A thin box from a to b (a rope, a strut). */
function strut(
  a: THREE.Vector3,
  b: THREE.Vector3,
  w: number,
): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.BoxGeometry(w, w, d.length());
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      d.normalize(),
    ),
  );
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** A box along the outline's run (x0, z0)–(x1, z1), from `o0` to `o1`
 * outside it, y0 to y1 high. */
function runBox(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  o0: number,
  o1: number,
  y0: number,
  y1: number,
): THREE.BufferGeometry {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const [nx, nz] = outward(x0, z0, x1, z1);
  const o = (o0 + o1) / 2;
  return new THREE.BoxGeometry(len, y1 - y0, o1 - o0)
    .rotateY(Math.atan2(-(z1 - z0), x1 - x0))
    .translate((x0 + x1) / 2 + nx * o, (y0 + y1) / 2, (z0 + z1) / 2 + nz * o);
}

/** Hull, deck, rails and everything else that never moves on board. */
function bodyGeometry(look: typeof LOOK): {
  body: THREE.BufferGeometry;
  portholes: THREE.BufferGeometry;
  lanterns: THREE.Matrix4[];
} {
  const parts: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const lanterns: THREE.Matrix4[] = [];
  const T = RAIL_THICKNESS;
  const outer = offsetOutline(T);

  // The deck: one flat polygon to the rail's outside face, at y = 0.
  const shape = new THREE.Shape(
    outer.map(([x, z]) => new THREE.Vector2(x, -z)),
  );
  parts.push(
    paint(
      new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
      DECK_WOOD,
      Surface.Deck,
    ),
  );

  // The hull: rings down from the deck's edge, lofted, each band its own
  // wood (the top one painted), closed under the keel.
  const rings: [y: number, sx: number, sz: number][] = [
    [0, 1, 1],
    [-0.55, 1.045, 1.0],
    [-1.35, 1.0, 0.97],
    [-2.15, 0.8, 0.91],
    [-2.8, 0.5, 0.83],
    [-3.15, 0.16, 0.74],
  ];
  const bands = [look.accent, WOOD_LIGHT, WOOD, WOOD_MID, WOOD_DARK];
  const ring = (i: number, j: number) => {
    const [y, sx, sz] = rings[i];
    const [x, z] = outer[j % outer.length];
    return new THREE.Vector3(x * sx, y, z * sz);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const tris: number[] = [];
    for (let j = 0; j < outer.length; j++) {
      const a = ring(i, j);
      const b = ring(i, j + 1);
      const c = ring(i + 1, j + 1);
      const d = ring(i + 1, j);
      tris.push(...a.toArray(), ...b.toArray(), ...c.toArray());
      tris.push(...a.toArray(), ...c.toArray(), ...d.toArray());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(tris, 3));
    parts.push(paint(g, bands[i], Surface.Strakes));
  }
  {
    const tris: number[] = [];
    const last = rings.length - 1;
    const keel = new THREE.Vector3(0, -3.3, -0.6);
    for (let j = 0; j < outer.length; j++)
      tris.push(
        ...ring(last, j).toArray(),
        ...keel.toArray(),
        ...ring(last, j + 1).toArray(),
      );
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(tris, 3));
    parts.push(paint(g, KEEL, Surface.Strakes));
  }
  // A keel strip, the rudder and a gilded rubbing strake at the deck edge.
  parts.push(
    paint(
      strut(
        new THREE.Vector3(0, -3.28, -8.4),
        new THREE.Vector3(0, -3.0, 8.8),
        0.22,
      ),
      KEEL,
    ),
    paint(
      new THREE.BoxGeometry(0.14, 1.9, 1.3).translate(0, -2.1, -10.9),
      WOOD_DARK,
    ),
  );
  for (let j = 0; j < outer.length; j++) {
    const [x0, z0] = outer[j];
    const [x1, z1] = outer[(j + 1) % outer.length];
    parts.push(paint(runBox(x0, z0, x1, z1, 0, 0.07, -0.16, -0.06), BRASS));
  }

  // The rails: a solid bulwark, balusters, a cap rail, flush inside with
  // the outline; a post at every corner and either side of the gangway.
  for (const [x0, z0, x1, z1] of railRuns()) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const [dx, dz] = [(x1 - x0) / len, (z1 - z0) / len];
    parts.push(
      paint(runBox(x0, z0, x1, z1, 0, T, 0, 0.45), WOOD_MID),
      paint(runBox(x0, z0, x1, z1, 0, T + 0.06, 0.93, RAIL_HEIGHT), WOOD),
      paint(runBox(x0, z0, x1, z1, 0.02, T - 0.02, 0.45, 0.5), WOOD_DARK),
    );
    const n = Math.max(1, Math.round(len / 0.5));
    const [nx, nz] = outward(x0, z0, x1, z1);
    for (let k = 1; k < n; k++) {
      const s = (k / n) * len;
      parts.push(
        paint(
          new THREE.BoxGeometry(0.07, 0.44, 0.07).translate(
            x0 + dx * s + nx * T * 0.5,
            0.71,
            z0 + dz * s + nz * T * 0.5,
          ),
          WOOD,
        ),
      );
    }
  }
  const post = (x: number, z: number, nx: number, nz: number, h: number) => {
    const px = x + nx * T * 0.5;
    const pz = z + nz * T * 0.5;
    const yaw = Math.atan2(-nz, nx);
    parts.push(
      paint(
        new THREE.BoxGeometry(0.26, h, 0.26)
          .rotateY(yaw)
          .translate(px, h / 2, pz),
        POST,
      ),
      paint(
        new THREE.BoxGeometry(0.32, 0.06, 0.32)
          .rotateY(yaw)
          .translate(px, h + 0.03, pz),
        WOOD_DARK,
      ),
    );
    return [px, pz] as const;
  };
  DECK_OUTLINE.forEach(([x, z], i) => {
    const [ox, oz] = outer[i];
    const [nx, nz] = [(ox - x) / T, (oz - z) / T];
    const lantern = LANTERN_POSTS.some(
      ([lx, lz]) => Math.abs(lx) === Math.abs(x) && lz === z,
    );
    const pennant = PENNANT_POSTS.some(
      ([lx, lz]) => lx === Math.abs(x) && lz === z,
    );
    const h = lantern ? 1.22 : 1.14;
    const [px, pz] = post(x, z, nx, nz, h);
    if (lantern) {
      parts.push(...lanternFrame(px, h + 0.06, pz));
      lanterns.push(lanternGlassAt(px, h + 0.06, pz));
    }
    if (pennant)
      parts.push(
        paint(
          new THREE.CylinderGeometry(0.04, 0.05, 2, 5).translate(px, h + 1, pz),
          WOOD_DARK,
        ),
        paint(
          new THREE.SphereGeometry(0.07, 5, 3).translate(px, h + 2.02, pz),
          BRASS,
        ),
      );
  });
  // The gangway's two posts, with a lantern each to light the way aboard.
  for (const s of [-1, 1]) {
    const z = GANGWAY.z + s * (GANGWAY.halfWidth + 0.13);
    const [px, pz] = post(GANGWAY.x, z, 1, 0, 1.22);
    parts.push(...lanternFrame(px, 1.28, pz));
    lanterns.push(lanternGlassAt(px, 1.28, pz));
  }
  // The slot the gangplank slides out of.
  parts.push(
    paint(
      new THREE.BoxGeometry(0.06, 0.24, PLANK_WIDTH + 0.2).translate(
        GANGWAY.x + T + 0.01,
        -0.13,
        GANGWAY.z,
      ),
      "#241a14",
    ),
  );

  // Portholes along both sides, brass-rimmed; their glass lights at dusk.
  const holes: [side: number, z: number][] = [
    [1, -4.6],
    [1, -2.4],
    [1, 2.4],
    [1, 4.6],
    [-1, -4.6],
    [-1, -2.4],
    [-1, 0],
    [-1, 2.4],
    [-1, 4.6],
  ];
  holes.forEach(([side, z], i) => {
    const y = -0.95;
    // On the hull's side there, a little proud of it: the outline, pushed
    // out to the hull and flared as the hull is at that depth.
    const x = side * (portRailX(z) + T) * 1.022;
    const [px, pz] = outward(
      portRailX(z - 0.5),
      z - 0.5,
      portRailX(z + 0.5),
      z + 0.5,
    );
    const yaw = Math.atan2(-pz, side * px);
    const disc = (r: number, d: number, out: number) =>
      new THREE.CylinderGeometry(r, r, d, 8)
        .rotateZ(-Math.PI / 2)
        .translate(out, 0, 0)
        .rotateY(yaw)
        .translate(x, y, z);
    parts.push(paint(disc(0.25, 0.08, 0.02), BRASS));
    const g = disc(0.17, 0.08, 0.05).toNonIndexed();
    g.deleteAttribute("uv");
    g.setAttribute(
      "phase",
      new THREE.BufferAttribute(
        new Float32Array(g.attributes.position.count).fill(
          0.05 + ((i * 0.37) % 0.3),
        ),
        1,
      ),
    );
    glass.push(g);
  });

  // Name boards on the bow, both sides, in the ship's own colours.
  for (const side of [1, -1]) {
    const i0 = DECK_OUTLINE.findIndex(([x, z]) => x === 4.0 && z === 6.6);
    const i1 = i0 + 1;
    const [ax, az] = outer[i0];
    const [bx, bz] = outer[i1];
    const a = new THREE.Vector3(side * ax * 1.02, -0.3, az);
    const b = new THREE.Vector3(side * bx * 1.02, -0.3, bz);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const along = b.clone().sub(a).normalize();
    const n = new THREE.Vector3(along.z, 0, -along.x).multiplyScalar(side);
    const right = new THREE.Vector3(n.z, 0, -n.x);
    const basis = new THREE.Matrix4().makeBasis(
      right,
      new THREE.Vector3(0, 1, 0),
      n,
    );
    const width = pixelTextWidth(look.name, 0.062) + 0.24;
    const board = paint(
      new THREE.BoxGeometry(width, 0.44 + accentRows(look.name) * 0.062, 0.05),
      "#2a1d14",
    )
      .applyMatrix4(basis)
      .translate(mid.x + n.x * 0.03, mid.y, mid.z + n.z * 0.03);
    const text = pixelText(look.name, 0.062, 0.025, look.plate)
      .applyMatrix4(basis)
      .translate(mid.x + n.x * 0.055, mid.y, mid.z + n.z * 0.055);
    parts.push(board, text);
  }

  // The bow: a bowsprit with a pennant, and a heart for a figurehead.
  const tip = DECK_OUTLINE.find(([x]) => x === 0) ?? [0, 11.8];
  parts.push(
    paint(
      strut(
        new THREE.Vector3(0, 0.95, tip[1] - 0.1),
        new THREE.Vector3(0, 1.75, tip[1] + 3.0),
        0.16,
      ),
      WOOD_DARK,
    ),
    paint(
      new THREE.SphereGeometry(0.1, 6, 4).translate(0, 1.78, tip[1] + 3.05),
      BRASS,
    ),
  );
  const heart = merge([
    paint(
      new THREE.SphereGeometry(0.27, 8, 6).translate(-0.17, 0.1, 0),
      look.accent,
    ),
    paint(
      new THREE.SphereGeometry(0.27, 8, 6).translate(0.17, 0.1, 0),
      look.accent,
    ),
    paint(
      new THREE.ConeGeometry(0.4, 0.55, 8)
        .rotateZ(Math.PI)
        .translate(0, -0.25, 0),
      look.accent,
    ),
  ]);
  heart
    .scale(1, 1, 0.55)
    .rotateX(-0.3)
    .translate(0, -0.75, tip[1] + 0.32);
  parts.push(heart);

  // The stern: a little gallery outside the rail with cargo, and the
  // ensign's staff.
  const stern = outer.find(([x, z]) => x > 0 && z < -10.5)?.[1] ?? -11.2;
  parts.push(
    paint(
      new THREE.BoxGeometry(5.2, 0.12, 0.95).translate(0, -0.42, stern - 0.47),
      WOOD_MID,
      Surface.Deck,
    ),
    paint(
      new THREE.BoxGeometry(0.5, 0.45, 0.5)
        .rotateY(0.2)
        .translate(-1.7, -0.13, stern - 0.45),
      WOOD_LIGHT,
    ),
    paint(
      new THREE.BoxGeometry(0.4, 0.36, 0.4)
        .rotateY(-0.3)
        .translate(-1.15, -0.18, stern - 0.5),
      WOOD,
    ),
    paint(
      new THREE.CylinderGeometry(0.2, 0.2, 0.5, 8).translate(
        1.6,
        -0.11,
        stern - 0.47,
      ),
      WOOD_MID,
    ),
    paint(
      new THREE.TorusGeometry(0.2, 0.07, 4, 8)
        .rotateX(Math.PI / 2)
        .translate(1.05, -0.31, stern - 0.47),
      ROPE,
    ),
    paint(
      new THREE.CylinderGeometry(0.05, 0.065, 3.1, 6).translate(
        0,
        1.55,
        stern - 0.12,
      ),
      WOOD_DARK,
    ),
    paint(
      new THREE.SphereGeometry(0.09, 6, 4).translate(0, 3.12, stern - 0.12),
      BRASS,
    ),
  );
  for (const s of [-1, 1])
    parts.push(
      paint(
        strut(
          new THREE.Vector3(s * 2.5, -0.36, stern - 0.9),
          new THREE.Vector3(s * 2.2, -1.3, stern + 0.35),
          0.09,
        ),
        WOOD_DARK,
      ),
    );

  // The helm: a pedestal with a brass binnacle (the wheel turns, apart).
  parts.push(
    paint(
      new THREE.CylinderGeometry(0.2, 0.28, 0.95, 8).translate(
        HELM.x,
        0.475,
        HELM.z,
      ),
      WOOD_DARK,
    ),
    paint(
      new THREE.BoxGeometry(0.42, 0.3, 0.4).translate(HELM.x, 1.1, HELM.z),
      WOOD,
    ),
    paint(
      new THREE.CylinderGeometry(0.13, 0.13, 0.12, 8).translate(
        HELM.x,
        1.31,
        HELM.z,
      ),
      BRASS,
    ),
    paint(
      new THREE.CylinderGeometry(0.045, 0.045, 0.3, 6)
        .rotateX(Math.PI / 2)
        .translate(WHEEL_AT.x, WHEEL_AT.y, WHEEL_AT.z + 0.15),
      BRASS,
    ),
  );
  // The bell post: a post with a little yoke the bell hangs in.
  parts.push(
    paint(
      new THREE.CylinderGeometry(0.09, 0.12, 1.6, 6).translate(
        BELL.x,
        0.8,
        BELL.z,
      ),
      WOOD_DARK,
    ),
    paint(
      new THREE.BoxGeometry(0.52, 0.08, 0.14).translate(BELL.x, 1.6, BELL.z),
      WOOD,
    ),
    paint(
      new THREE.BoxGeometry(0.07, 0.68, 0.1).translate(
        BELL.x - 0.22,
        1.94,
        BELL.z,
      ),
      WOOD,
    ),
    paint(
      new THREE.BoxGeometry(0.07, 0.68, 0.1).translate(
        BELL.x + 0.22,
        1.94,
        BELL.z,
      ),
      WOOD,
    ),
    paint(
      new THREE.BoxGeometry(0.56, 0.08, 0.14).translate(BELL.x, 2.28, BELL.z),
      WOOD,
    ),
    paint(
      new THREE.ConeGeometry(0.38, 0.22, 4)
        .rotateY(Math.PI / 4)
        .translate(BELL.x, 2.43, BELL.z),
      look.accent,
    ),
  );
  // Coils of rope by the stern posts, low and tucked into the corners.
  for (const s of [-1, 1])
    parts.push(
      paint(
        new THREE.TorusGeometry(0.2, 0.06, 4, 8)
          .rotateX(Math.PI / 2)
          .translate(s * 2.7, 0.06, -10.5),
        ROPE,
      ),
    );

  const portholes = merge(glass);
  return { body: merge(parts), portholes, lanterns };
}

/** The balloon, its tail fins, the girders under it and the rigging down
 * to the rails: one mesh, so the rigging stays tied on as it sways. */
function envelopeGeometry(look: typeof LOOK): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const GORES = 16;
  const sphere = new THREE.SphereGeometry(1, GORES, 12)
    .rotateX(Math.PI / 2)
    .toNonIndexed();
  sphere.deleteAttribute("uv");
  const pos = sphere.attributes.position;
  const unit: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    unit.push(v.clone());
    const taper = v.z < 0 ? 1 + TAIL_TAPER * v.z : 1;
    pos.setXYZ(
      i,
      v.x * ENVELOPE.rx * taper,
      ENVELOPE.y + v.y * ENVELOPE.ry * taper,
      ENVELOPE.z + v.z * ENVELOPE.rz,
    );
  }
  // Gores in two colours, nose to tail; the caps in the ship's accent.
  const colors = new Float32Array(pos.count * 3);
  const stripe = new THREE.Color(look.stripe);
  const cream = new THREE.Color(look.cream);
  const accent = new THREE.Color(look.accent);
  for (let f = 0; f < pos.count; f += 3) {
    const c = unit[f]
      .clone()
      .add(unit[f + 1])
      .add(unit[f + 2])
      .divideScalar(3);
    const angle = (Math.atan2(c.y, c.x) + Math.PI * 2) % (Math.PI * 2);
    const gore = Math.floor(angle / ((Math.PI * 2) / GORES));
    const col = Math.abs(c.z) > 0.86 ? accent : gore % 2 ? stripe : cream;
    for (let k = 0; k < 3; k++) col.toArray(colors, (f + k) * 3);
  }
  sphere.computeVertexNormals();
  sphere.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  sphere.setAttribute(
    "surface",
    new THREE.BufferAttribute(new Float32Array(pos.count), 1),
  );
  parts.push(sphere);

  // Tail fins: top, bottom and either side, rooted inside the balloon.
  const fin = new THREE.Shape(
    [
      [0, 2.0],
      [2.4, 3.7],
      [4.0, 3.7],
      [4.3, 0.4],
    ].map(([u, v]) => new THREE.Vector2(u, v)),
  );
  const root = ENVELOPE.z - ENVELOPE.rz * 0.62;
  for (let k = 0; k < 4; k++) {
    const g = new THREE.ExtrudeGeometry(fin, {
      depth: 0.14,
      bevelEnabled: false,
    })
      .translate(0, 0, -0.07)
      .rotateY(Math.PI / 2)
      .rotateZ((k * Math.PI) / 2)
      .translate(0, ENVELOPE.y, root);
    parts.push(paint(g, k % 2 ? look.accent : look.stripe));
  }

  // Two girders hugging the belly, and the rigging from the rails up to
  // them.
  const girder = (side: number, z: number) =>
    new THREE.Vector3(side * 1.5, envelopeUnder(1.5, z) - 0.1, z);
  for (const side of [-1, 1]) {
    for (let z = -9; z < 9; z += 1.5)
      parts.push(
        paint(strut(girder(side, z), girder(side, z + 1.5), 0.16), WOOD_DARK),
      );
  }
  const ties: [number, number][] = [
    [3.4, -11],
    [4.2, -8],
    [4.5, -4],
    [4.5, 3.5],
    [4.0, 6.6],
    [1.6, 10.9],
  ];
  for (const side of [-1, 1])
    for (const [x, z] of ties) {
      const foot = new THREE.Vector3(
        side * (x + RAIL_THICKNESS * 0.5),
        RAIL_HEIGHT,
        z,
      );
      const top = girder(side, clamp(z * 0.88, -9, 9));
      parts.push(paint(strut(foot, top, 0.06), RIGGING));
    }
  return merge(parts);
}

/** The balloon's sway, as its shader's uniforms. */
type EnvelopeUniforms = {
  uShipT: { value: number };
  uBreath: { value: number };
  uLag: { value: THREE.Vector2 };
  uRipple: { value: number };
};

/**
 * The balloon's material: it breathes (a slow swell), lags behind the
 * hull as it speeds up and swings out on turns (sheared, more the higher
 * up, so the rigging's feet stay put on the rails), ripples in gusts —
 * and is dithered away where it comes between the camera and the player,
 * or right in front of the camera.
 */
function envelopeMaterial(u: EnvelopeUniforms): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  });
  const from = (ENVELOPE_BOTTOM - 2).toFixed(2);
  const to = ENVELOPE_BOTTOM.toFixed(2);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uShipT;
uniform float uBreath;
uniform vec2 uLag;
uniform float uRipple;
varying float vShipDepth;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
{
  float lift = max( 0.0, transformed.y - ${RAIL_HEIGHT.toFixed(2)} );
  float body = smoothstep( ${from}, ${to}, transformed.y );
  vec2 breathed = vec2( transformed.x * uBreath, ${ENVELOPE.y.toFixed(2)} + ( transformed.y - ${ENVELOPE.y.toFixed(2)} ) * uBreath );
  transformed.xy = mix( transformed.xy, breathed, body );
  transformed.x += uLag.x * lift + uRipple * body * sin( transformed.z * 0.4 - uShipT * ${(2 * Math.PI * 0.4).toFixed(5)} );
  transformed.z += uLag.y * lift;
}`,
      )
      .replace(
        "#include <fog_vertex>",
        /* glsl */ `#include <fog_vertex>
vShipDepth = -mvPosition.z;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying float vShipDepth;`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        /* glsl */ `#include <clipping_planes_fragment>
if ( vShipDepth < 1.5 ) discard;`,
      );
  };
  m.customProgramCacheKey = () => "shipEnvelope";
  return seeThrough(m);
}

/** A wing, its hinge at the origin and its tip out along +x, with an
 * engine nacelle at the tip; the same fore and aft, so one shape serves
 * both sides (the starboard one turned half round). */
function wingGeometry(look: typeof LOOK): THREE.BufferGeometry {
  const slab = new THREE.BoxGeometry(WING.span, 0.12, 1.5, 3, 1, 1).translate(
    WING.span / 2,
    0,
    0,
  );
  // Tapering toward the tip.
  const p = slab.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 1 - 0.35 * (p.getX(i) / WING.span);
    p.setZ(i, p.getZ(i) * k);
  }
  return merge([
    paint(slab, WOOD_LIGHT),
    paint(
      new THREE.BoxGeometry(WING.span * 0.9, 0.14, 0.14).translate(
        WING.span * 0.5,
        0.01,
        0,
      ),
      look.accent,
    ),
    paint(
      new THREE.CylinderGeometry(0.3, 0.3, 1.5, 8)
        .rotateX(Math.PI / 2)
        .translate(WING.span, 0, 0),
      WOOD_DARK,
    ),
    paint(
      new THREE.CylinderGeometry(0.32, 0.32, 0.12, 8)
        .rotateX(Math.PI / 2)
        .translate(WING.span, 0, 0.55),
      BRASS,
    ),
    paint(
      new THREE.CylinderGeometry(0.32, 0.32, 0.12, 8)
        .rotateX(Math.PI / 2)
        .translate(WING.span, 0, -0.55),
      BRASS,
    ),
    paint(
      new THREE.CylinderGeometry(0.08, 0.08, 0.3, 6)
        .rotateX(Math.PI / 2)
        .translate(WING.span, 0, 0.85),
      IRON,
    ),
  ]);
}

/** A propeller facing +z: a hub, three blades and (`disc` = 1) the blur
 * of them spinning, which the propeller material dithers in as they speed
 * up (`disc` = 2: the hub, always drawn). */
function propellerGeometry(look: typeof LOOK): THREE.BufferGeometry {
  const tag = (g: THREE.BufferGeometry, disc: number) => {
    g.setAttribute(
      "disc",
      new THREE.BufferAttribute(
        new Float32Array(g.attributes.position.count).fill(disc),
        1,
      ),
    );
    return g;
  };
  const blades = [0, 1, 2].map((k) =>
    tag(
      paint(
        new THREE.BoxGeometry(0.2, PROP_RADIUS - 0.1, 0.05)
          .rotateY(0.35)
          .translate(0, (PROP_RADIUS - 0.1) / 2 + 0.1, 0)
          .rotateZ((k * Math.PI * 2) / 3),
        WOOD,
      ),
      0,
    ),
  );
  const tips = [0, 1, 2].map((k) =>
    tag(
      paint(
        new THREE.BoxGeometry(0.21, 0.14, 0.06)
          .rotateY(0.35)
          .translate(0, PROP_RADIUS - 0.08, 0)
          .rotateZ((k * Math.PI * 2) / 3),
        look.accent,
      ),
      0,
    ),
  );
  return merge([
    ...blades,
    ...tips,
    tag(paint(new THREE.RingGeometry(0.16, PROP_RADIUS, 14), "#d9c9a8"), 1),
    tag(
      paint(
        new THREE.ConeGeometry(0.15, 0.32, 8)
          .rotateX(Math.PI / 2)
          .translate(0, 0, 0.12),
        BRASS,
      ),
      2,
    ),
  ]);
}

/** Blades fade out and their blur in, by a 4×4 ordered dither (as crisp
 * as the Town's other see-through things, and nothing to sort). */
function propellerMaterial(uBlur: {
  value: number;
}): THREE.MeshLambertMaterial {
  const m = planked(
    new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.DoubleSide,
    }),
  );
  const before = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.uBlur = uBlur;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute float disc;
varying float vDisc;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
vDisc = disc;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uBlur;
varying float vDisc;`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        /* glsl */ `#include <clipping_planes_fragment>
{
  float keep = vDisc > 1.5 ? 1.0 : vDisc > 0.5 ? uBlur * 0.5 : 1.0 - uBlur;
  ivec2 cell = ivec2( mod( gl_FragCoord.xy, 4.0 ) );
  int i = cell.x + cell.y * 4;
  float bayer[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  if ( ( bayer[i] + 0.5 ) / 16.0 >= keep ) discard;
}`,
      );
  };
  m.customProgramCacheKey = () => "shipPropeller";
  return m;
}

/** The wheel: a rim, eight spokes with handles, a brass hub; facing aft,
 * turning about z. */
function wheelGeometry(): THREE.BufferGeometry {
  const parts = [
    paint(new THREE.TorusGeometry(0.37, 0.045, 4, 12), WOOD),
    paint(
      new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8).rotateX(Math.PI / 2),
      BRASS,
    ),
  ];
  for (let k = 0; k < 8; k++)
    parts.push(
      paint(
        new THREE.BoxGeometry(0.04, 0.5, 0.04)
          .translate(0, 0.25, 0)
          .rotateZ((k * Math.PI) / 4),
        WOOD_DARK,
      ),
    );
  return merge(parts);
}

/** The gangplank, `length` long: boards with cleats to grip, stringers
 * along its sides, and (`lift` = 1) handrails that fold flat while it's
 * stowed. Its inner end's top at the origin, running out along +x. */
function gangplankGeometry(length: number): THREE.BufferGeometry {
  const lifted = (g: THREE.BufferGeometry, lift: number) => {
    g.setAttribute(
      "lift",
      new THREE.BufferAttribute(
        new Float32Array(g.attributes.position.count).fill(lift),
        1,
      ),
    );
    return g;
  };
  const w = PLANK_WIDTH;
  const parts = [
    lifted(
      paint(
        new THREE.BoxGeometry(length, 0.1, w).translate(length / 2, -0.05, 0),
        WOOD_LIGHT,
        Surface.Deck,
      ),
      0,
    ),
    ...[-1, 1].map((s) =>
      lifted(
        paint(
          new THREE.BoxGeometry(length, 0.2, 0.1).translate(
            length / 2,
            -0.08,
            (s * (w + 0.1)) / 2,
          ),
          WOOD_DARK,
        ),
        0,
      ),
    ),
  ];
  const cleats = Math.floor(length / 0.55);
  for (let k = 1; k < cleats; k++)
    parts.push(
      lifted(
        paint(
          new THREE.BoxGeometry(0.07, 0.035, w - 0.3).translate(
            k * 0.55,
            0.017,
            0,
          ),
          WOOD_DARK,
        ),
        0,
      ),
    );
  const posts = Math.max(2, Math.round(length / 1.4) + 1);
  for (const s of [-1, 1]) {
    const z = (s * (w - 0.1)) / 2;
    for (let k = 0; k < posts; k++) {
      const x = 0.15 + ((length - 0.3) * k) / (posts - 1);
      parts.push(
        lifted(
          paint(
            new THREE.BoxGeometry(0.07, 0.85, 0.07).translate(x, 0.425, z),
            WOOD,
          ),
          1,
        ),
      );
    }
    parts.push(
      lifted(
        paint(
          new THREE.BoxGeometry(length - 0.2, 0.07, 0.09).translate(
            length / 2,
            0.86,
            z,
          ),
          WOOD_DARK,
        ),
        1,
      ),
      lifted(
        paint(
          new THREE.BoxGeometry(length - 0.3, 0.035, 0.035).translate(
            length / 2,
            0.45,
            z,
          ),
          ROPE,
        ),
        1,
      ),
    );
  }
  return merge(parts);
}

/** Fold the gangplank's handrails on `m`: flattened into the boards at
 * `uRise` 0, standing at 1 (by each vertex's `lift`). */
function foldingRails<M extends THREE.Material>(
  m: M,
  uRise: { value: number },
  key: string,
): M {
  const before = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.uRise = uRise;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute float lift;
uniform float uRise;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
transformed.y = mix( transformed.y, -0.04 + ( transformed.y + 0.04 ) * uRise, lift );`,
      );
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** The gangplank's boards, handrails folding (foldingRails). */
function gangplankMaterial(uRise: {
  value: number;
}): THREE.MeshLambertMaterial {
  return foldingRails(
    planked(
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    ),
    uRise,
    "shipGangplank",
  );
}

/** The gangplank's shadow, its handrails folded as they're drawn: else,
 * stowed under the deck, their shadow stands up through it. */
function gangplankShadow(uRise: { value: number }): THREE.MeshDepthMaterial {
  return foldingRails(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
    uRise,
    "shipGangplankShadow",
  );
}

/** The flags: an ensign at the stern, a long pennant off the bowsprit and
 * one on each bow pole, all streaming aft. */
function flagsGeometry(look: typeof LOOK): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  /** A flag `l` long and `h` high from `anchor`, in rows of colour; a
   * pennant narrows to a point. */
  const flag = (
    anchor: THREE.Vector3,
    l: number,
    h: number,
    rows: string[],
    pennant: boolean,
  ) => {
    const g = new THREE.PlaneGeometry(l, h, 8, rows.length).toNonIndexed();
    g.deleteAttribute("uv");
    const p = g.attributes.position;
    const colors = new Float32Array(p.count * 3);
    for (let f = 0; f < p.count; f += 3) {
      const cy = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
      const row = Math.min(
        rows.length - 1,
        Math.floor((h / 2 - cy) / (h / rows.length)),
      );
      const c = new THREE.Color(rows[row]);
      for (let k = 0; k < 3; k++) c.toArray(colors, (f + k) * 3);
    }
    for (let i = 0; i < p.count; i++) {
      // Plane x (0..l from its leading edge) → back along −z; plane y →
      // down from the anchor (0..h); a pennant narrows to its tip, about
      // its middle.
      const u = p.getX(i) + l / 2;
      const down = h / 2 - p.getY(i);
      const k = pennant ? 1 - (u / l) * 0.92 : 1;
      p.setXYZ(
        i,
        anchor.x,
        anchor.y - h / 2 + (h / 2 - down) * k,
        anchor.z - u,
      );
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    g.setAttribute(
      "surface",
      new THREE.BufferAttribute(new Float32Array(p.count), 1),
    );
    parts.push(cloth(g, anchor));
  };
  const stern =
    offsetOutline(RAIL_THICKNESS).find(([x, z]) => x > 0 && z < -10.5)?.[1] ??
    -11.2;
  flag(
    new THREE.Vector3(0, 3.05, stern - 0.16),
    1.35,
    0.84,
    [look.accent, look.cream, look.accent],
    false,
  );
  const tip = DECK_OUTLINE.find(([x]) => x === 0)?.[1] ?? 11.8;
  flag(
    new THREE.Vector3(0, 1.76, tip + 2.95),
    2.2,
    0.36,
    [look.stripe, look.accent],
    true,
  );
  const outer = offsetOutline(RAIL_THICKNESS);
  DECK_OUTLINE.forEach(([x, z], i) => {
    if (!PENNANT_POSTS.some(([px, pz]) => px === Math.abs(x) && pz === z))
      return;
    const [ox, oz] = outer[i];
    const px = x + (ox - x) * 0.5;
    const pz = z + (oz - z) * 0.5;
    // Short, and up high: drooping in a calm, they still clear heads.
    flag(
      new THREE.Vector3(px, 3.1, pz - 0.05),
      0.85,
      0.26,
      [look.cream, look.stripe],
      true,
    );
  });
  return merge(parts);
}

/** The sky ship's model: Blåmann. */
export class AirshipModel {
  /** In the deck's frame (deck.ts): place and turn it to fly it. */
  readonly root = new THREE.Group();

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly instanced: THREE.InstancedMesh[] = [];

  private readonly envelope: EnvelopeUniforms = {
    uShipT: { value: 0 },
    uBreath: { value: 1 },
    uLag: { value: new THREE.Vector2() },
    uRipple: { value: 0 },
  };
  private readonly flutter = flutterUniforms();
  private readonly blur = { value: 0 };
  private readonly rise = { value: 0 };

  private readonly wings: THREE.InstancedMesh;
  private readonly props: THREE.InstancedMesh;
  private readonly wheel: THREE.Mesh;
  private readonly bell: THREE.Mesh;
  private readonly plank: THREE.Mesh;
  private plankLength = 0;

  /** The propellers' angle (summed frame by frame, see the class note),
   * and the wings' fold as last drawn. */
  private propAngle = 0;
  private fold = Number.NaN;
  private readonly propAt = [new THREE.Vector3(), new THREE.Vector3()];
  /** The bell's pose as rung, this frame. */
  private readonly rung: BellPose = { swing: 0, clapper: 0 };

  // Scratch.
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  private readonly euler = new THREE.Euler();

  constructor() {
    const keep = <G extends THREE.BufferGeometry>(g: G) => {
      this.geometries.push(g);
      return g;
    };
    const own = <M extends THREE.Material>(m: M) => {
      this.materials.push(m);
      return m;
    };

    const wood = own(
      planked(
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          side: THREE.DoubleSide,
        }),
      ),
    );
    const built = bodyGeometry(LOOK);
    const body = new THREE.Mesh(keep(built.body), wood);
    body.castShadow = true;
    body.receiveShadow = true;
    const portholes = new THREE.Mesh(keep(built.portholes), windowMaterial);
    const lanterns = lanternGlass(built.lanterns);
    this.instanced.push(lanterns);

    const envelope = new THREE.Mesh(
      keep(envelopeGeometry(LOOK)),
      own(envelopeMaterial(this.envelope)),
    );

    this.wings = new THREE.InstancedMesh(keep(wingGeometry(LOOK)), wood, 2);
    this.wings.castShadow = true;
    this.wings.frustumCulled = false;
    this.props = new THREE.InstancedMesh(
      keep(propellerGeometry(LOOK)),
      own(propellerMaterial(this.blur)),
      2,
    );
    this.props.frustumCulled = false;
    this.instanced.push(this.wings, this.props);

    const flags = new THREE.Mesh(
      keep(flagsGeometry(LOOK)),
      own(
        fluttering(
          new THREE.MeshLambertMaterial({
            vertexColors: true,
            flatShading: true,
            side: THREE.DoubleSide,
          }),
          this.flutter,
        ),
      ),
    );
    flags.frustumCulled = false;

    this.wheel = new THREE.Mesh(keep(wheelGeometry()), wood);
    this.wheel.position.copy(WHEEL_AT);
    this.wheel.castShadow = true;
    this.bell = new THREE.Mesh(keep(bellGeometry(0.17)), wood);
    this.bell.position.copy(BELL_AT);
    this.bell.castShadow = true;

    this.plank = new THREE.Mesh(
      new THREE.BufferGeometry(),
      own(gangplankMaterial(this.rise)),
    );
    this.plank.customDepthMaterial = own(gangplankShadow(this.rise));
    this.plank.castShadow = true;
    this.plank.receiveShadow = true;
    this.plank.visible = false;

    this.root.add(
      body,
      portholes,
      lanterns,
      envelope,
      this.wings,
      this.props,
      flags,
      this.wheel,
      this.bell,
      this.plank,
    );
    this.update(0, 0, SHIP_AT_REST);
  }

  update(dt: number, t: number, m: ShipMotion): void {
    const T = wrapTime(t);
    const gust = clamp(m.gust, -1, 1);
    const speed = Math.max(0, m.speed);

    // The balloon: breathing, lagging, rippling.
    const e = this.envelope;
    e.uShipT.value = T;
    e.uBreath.value = 1 + 0.008 * Math.sin(2 * Math.PI * 0.15 * T);
    e.uLag.value.set(
      clamp(-0.022 * m.turnRate * speed + 0.004 * gust, -0.04, 0.04),
      clamp(-0.022 * m.accel, -0.04, 0.04),
    );
    e.uRipple.value = 0.12 * Math.abs(gust);

    // The flags.
    const stream = clamp(0.15 + speed / 7 + 0.45 * Math.abs(gust), 0, 1);
    this.flutter.uFlapT.value = T;
    this.flutter.uStream.value = stream;
    this.flutter.uFlutter.value = 0.05 + 0.12 * stream;

    // The wings fold up when moored; the propellers spin with the engines.
    const fold = THREE.MathUtils.lerp(
      WING.flying,
      WING.folded,
      smooth(clamp(m.moored, 0, 1)),
    );
    if (fold !== this.fold) this.placeWings(fold);
    const rps = MAX_RPS * clamp(m.throttle, 0, 1);
    this.propAngle =
      (this.propAngle + 2 * Math.PI * rps * Math.max(0, dt)) % (Math.PI * 2);
    this.blur.value = THREE.MathUtils.smoothstep(rps, 3.5, 5.5);
    for (let i = 0; i < 2; i++) {
      // Counter-rotating, so the pair doesn't twist the ship.
      this.q.setFromAxisAngle(
        this.zAxis,
        i === 0 ? this.propAngle : -this.propAngle,
      );
      this.m4.compose(this.propAt[i], this.q, this.one);
      this.props.setMatrixAt(i, this.m4);
    }
    this.props.instanceMatrix.needsUpdate = true;

    // The wheel follows the turn; the bell swings with the ship, and when
    // it's rung, swings to its blows, its clapper meeting the rim on each
    // chime of the sound.
    this.wheel.rotation.z =
      clamp(m.turnRate * 6, -1.4, 1.4) +
      0.04 * Math.sin(T * 2 * Math.PI * 0.15);
    const sway = 0.3 + Math.abs(gust) + speed / 10;
    const rung = poseBell(m.bell, m.bellStrikes, this.rung);
    this.bell.rotation.x =
      clamp(-m.accel * 0.12, -0.3, 0.3) +
      0.05 * sway * Math.sin(T * 2 * Math.PI * 0.7) +
      rung.swing;
    this.bell.rotation.z =
      clamp(-m.turnRate * speed * 0.05, -0.25, 0.25) +
      0.035 * sway * Math.sin(T * 2 * Math.PI * 0.55 + 1);
    swingClapper(this.bell, rung.clapper);

    this.placeGangplank(m);
  }

  /** Fold both wings to `fold` (radians up from level), and put the
   * propellers on the front of their nacelles. */
  private placeWings(fold: number): void {
    this.fold = fold;
    const hingeX = portRailX(WING.z) + RAIL_THICKNESS;
    for (let i = 0; i < 2; i++) {
      // Port: tip out along +x, folding up about z. Starboard: the same
      // wing turned half round first, so it folds up the other way.
      const side = i === 0 ? 1 : -1;
      this.euler.set(0, side > 0 ? 0 : Math.PI, fold, "YXZ");
      this.q.setFromEuler(this.euler);
      this.m4.compose(
        this.v.set(side * hingeX, WING.y, WING.z),
        this.q,
        this.one,
      );
      this.wings.setMatrixAt(i, this.m4);
      // The propeller on the nacelle's nose, ahead of the wing.
      this.propAt[i].set(WING.span, 0, 0).applyMatrix4(this.m4);
      this.propAt[i].z = WING.z + 0.95;
    }
    this.wings.instanceMatrix.needsUpdate = true;
  }

  private placeGangplank(m: ShipMotion): void {
    const g = clamp(m.gangplank, 0, 1);
    this.plank.visible = g > 0.001;
    if (!this.plank.visible) return;
    const pose = gangplankPose(g, m.gangplankTo);
    if (Math.abs(pose.length - this.plankLength) > 0.01) {
      this.plank.geometry.dispose();
      this.plank.geometry = gangplankGeometry(pose.length);
      this.plankLength = pose.length;
    }
    this.plank.position.set(pose.x, pose.y, GANGWAY.z);
    this.plank.rotation.set(0, 0, pose.pitch);
    this.rise.value = pose.rise;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.plank.geometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const i of this.instanced) i.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}
