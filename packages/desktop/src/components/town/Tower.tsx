import { mulberry32 } from "@herzies/shared";
import { clump } from "@herzies/shared/gl";
import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient, BAYER_GLSL, inSeason, seeThrough } from "./ambient";
import {
  DOOR_RADIUS,
  glassLighting,
  LIT_WINDOW,
  windowGlow,
} from "./Buildings";
import { CLOUD } from "./Clouds";
import { SKY_GRADIENT_GLSL, skyUniforms } from "./Islands";
import { buildingsOf, type TownMap } from "./map";
import {
  GROUND_BANNERS,
  GROUND_WINDOW_Y,
  GROUND_WINDOWS,
  hasBalcony,
  hasCornice,
  TOWER_DOOR_FACE,
  TOWER_FADE,
  TOWER_FADE_LATE,
  TOWER_GLASS_OUT,
  TOWER_GROUND_STOREY,
  TOWER_PLINTH,
  TOWER_PLINTH_HEIGHT,
  towerFloors,
  towerPlace,
  towerRadiusAt,
} from "./towerPlan";

/**
 * The Tower, drawn: pale ashlar on a dark footing, a porch with a grand
 * round door, then floor after floor of arched windows between ribs, a
 * balcony every second floor and a cornice hung with banners every fourth,
 * each floor a little shorter and narrower than the last. It rises into
 * rings of turning cloud and melts into the sky as it goes (see
 * `towerFade`), so its top is never seen: there isn't one.
 *
 * One tower's geometry, built once and shared by every tower on a map,
 * each placed at its floor, turned to its door and scaled to its cells.
 * Four draws: the stone, the lit glass, the cloud collar, and a stump
 * that only casts the shadow. Nothing moves on the CPU; the clouds turn
 * in their shader on the shared clock.
 */

// The Tower's stone and trim, shared with its hall inside (TowerHall).
export const STONE = "#e4dccd";
const STONE_ALT = "#dad1c0";
const STONE_LOW = "#cdc3b3";
export const FOOTING = "#8a8278";
export const TRIM = "#f5f0e4";
export const RIB = "#cfc4b2";
const SLATE = "#565b6e";
export const IRON = "#3f4252";
export const GOLD = "#d9b04a";
export const INDIGO = "#3d3a7c";
export const DOOR = "#4e2d6a";
export const DOOR_DARK = "#33204a";
export const RECESS = "#3b3648";
export const STEP = "#a29c92";

/** What a face is made of, for the stone shader (see `ashlar`). */
export const PLAIN = 0;
export const ASHLAR = 1;

/** The drum's sides. Faces are centred on every 30° from the door, so
 * windows, ribs and the porch sit flat on them. */
const SIDES = 12;
const START = -Math.PI / SIDES;
/** A face's distance from the axis, per unit of radius. */
const FACE = Math.cos(Math.PI / SIDES);

/** The door: grander than a house's, still sized for a herzie. Its
 * bottom sinks a little into the plinth, as a house's does into its step. */
const DOOR_R = DOOR_RADIUS * 1.08;
const DOOR_MID = TOWER_PLINTH_HEIGHT - 0.1 + DOOR_R;
/** The porch round the door: how wide and tall. */
const PORCH_W = 3.8;
const PORCH_H = 4.4;
/** Above this the haze has the detail: no sills, half the railings. */
const HIGH = 36;
/** The stump that casts the tower's shadow: a shadow from all of it would
 * fall across the whole town, and end where the shadow map ends. */
const SHADOW_TOP = 20;

/** One colour on a geometry, in the shape mergeGeometries wants: no
 * index, no uvs, normals, colours and what it's made of. */
export function paint(
  g: THREE.BufferGeometry,
  color: string,
  stone = PLAIN,
): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  if (!out.attributes.normal) out.computeVertexNormals();
  const n = out.attributes.position.count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  out.setAttribute(
    "stone",
    new THREE.BufferAttribute(new Float32Array(n).fill(stone), 1),
  );
  return out;
}

/** Glass, lighting up at dusk (see glassLighting). Every pane, and every
 * balcony lantern, has phase 0 (the zeros the attribute starts as): the
 * town's first turn, so the whole tower comes alight at once, before
 * anything else, with never a pane left dark among lit ones nor over the
 * pool of light a ground window throws (NightLights gives those their own
 * turns, none earlier). */
function glass(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  out.setAttribute(
    "phase",
    new THREE.BufferAttribute(
      new Float32Array(out.attributes.position.count),
      1,
    ),
  );
  return out;
}

export const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) =>
  new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** A round, flat thing facing out (+z): a door, its frame, a knob. */
export const disc = (r: number, depth: number) =>
  new THREE.CylinderGeometry(r, r, depth, 18).rotateX(Math.PI / 2);

/** A stretch of the drum, from radius `rb` at `y0` to `rt` at `y1`. */
const drum = (rb: number, rt: number, y0: number, y1: number, open = true) =>
  new THREE.CylinderGeometry(rt, rb, y1 - y0, SIDES, 1, open, START).translate(
    0,
    (y0 + y1) / 2,
    0,
  );

/** Something made facing +z, set on the face at angle `a` round the axis:
 * `out` beyond a face `ap` from the axis, at height `y`. */
function onFace(
  g: THREE.BufferGeometry,
  a: number,
  ap: number,
  y: number,
  out: number,
): THREE.BufferGeometry {
  return g
    .rotateY(a)
    .translate(Math.sin(a) * (ap + out), y, Math.cos(a) * (ap + out));
}

/** Triangles from points, as one geometry. */
export function tris(...pts: number[][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
  g.computeVertexNormals();
  return g;
}

/** An arched window on the face at `a`: a dark reveal, the glass (a
 * rectangle under a round head), and low down a sill and a keystone. */
function archWindow(
  body: THREE.BufferGeometry[],
  lit: THREE.BufferGeometry[],
  a: number,
  ap: number,
  y: number,
  w: number,
  h: number,
) {
  const bottom = y - h / 2;
  const head = y + h / 2 - w / 2;
  const at = (g: THREE.BufferGeometry, gy: number, out: number) =>
    onFace(g, a, ap, gy, out);
  body.push(
    paint(
      at(box(w + 0.24, head - bottom + 0.12, 0.06), (head + bottom) / 2, 0.02),
      RECESS,
    ),
    paint(at(disc(w / 2 + 0.12, 0.06), head, 0.02), RECESS),
  );
  lit.push(
    glass(
      at(box(w, head - bottom, 0.04), (head + bottom) / 2, TOWER_GLASS_OUT),
    ),
    glass(at(disc(w / 2, 0.04), head, TOWER_GLASS_OUT)),
  );
  if (y > HIGH) return;
  body.push(
    paint(at(box(w + 0.36, 0.1, 0.24), bottom - 0.05, 0.1), TRIM),
    paint(at(box(0.18, 0.26, 0.1), head + w / 2 + 0.14, 0.05), TRIM),
  );
}

/** A banner on the face at `a`, `out` from it: hung from a gilt rod at
 * `top`, `len` long and `w` wide, gold-edged with a gold lozenge, and a
 * swallowtail. */
function banner(
  body: THREE.BufferGeometry[],
  a: number,
  ap: number,
  out: number,
  top: number,
  len: number,
  w: number,
) {
  const at = (g: THREE.BufferGeometry, y: number, o: number, color: string) =>
    body.push(paint(onFace(g, a, ap, y, out + o), color));
  at(box(w + 0.24, 0.08, 0.08), top, 0.02, GOLD);
  at(box(w, len, 0.04), top - len / 2, 0, INDIGO);
  for (const s of [-1, 1]) {
    at(box(0.07, len, 0.05, s * (w / 2 - 0.06)), top - len / 2, 0.01, GOLD);
  }
  const d = w * 0.45;
  at(
    tris(
      [-w / 2, 0, 0],
      [0, 0, 0],
      [-w / 2, -d, 0],
      [0, 0, 0],
      [w / 2, 0, 0],
      [w / 2, -d, 0],
    ),
    top - len,
    0,
    INDIGO,
  );
  at(
    box(w * 0.34, w * 0.34, 0.05).rotateZ(Math.PI / 4),
    top - len * 0.32,
    0.02,
    GOLD,
  );
}

/** The footing, the ground storey, the porch and its door, and the steps. */
function groundStorey(
  body: THREE.BufferGeometry[],
  lit: THREE.BufferGeometry[],
) {
  const P = TOWER_PLINTH_HEIGHT;
  const G = TOWER_GROUND_STOREY;
  const F = TOWER_DOOR_FACE;
  // The footing: from well under the ground (where it slopes away, or the
  // cliff's edge drops off) up to the plinth's top, with a pale lip.
  body.push(
    paint(
      new THREE.CylinderGeometry(
        TOWER_PLINTH,
        TOWER_PLINTH - 0.4,
        P + 3,
        SIDES,
        1,
        false,
        START,
      ).translate(0, (P - 3) / 2, 0),
      FOOTING,
      ASHLAR,
    ),
    paint(
      drum(TOWER_PLINTH + 0.06, TOWER_PLINTH + 0.06, P - 0.08, P + 0.02, false),
      TRIM,
    ),
    paint(drum(towerRadiusAt(P), towerRadiusAt(G), P, G), STONE_LOW, ASHLAR),
    // The ground storey's cornice, slate-capped.
    paint(
      drum(
        towerRadiusAt(G) + 0.2,
        towerRadiusAt(G) + 0.3,
        G - 0.12,
        G + 0.24,
        false,
      ),
      TRIM,
    ),
    paint(
      drum(
        towerRadiusAt(G) + 0.14,
        towerRadiusAt(G) + 0.14,
        G + 0.24,
        G + 0.36,
        false,
      ),
      SLATE,
    ),
  );

  // The porch: a block of stone out to the edge of the cells, a cornice,
  // and a low pediment with a gilt boss.
  const back = towerRadiusAt(P) * FACE - 0.3;
  body.push(
    paint(
      box(PORCH_W, PORCH_H, F - back, 0, P + PORCH_H / 2, (F + back) / 2),
      STONE,
      ASHLAR,
    ),
    paint(
      box(
        PORCH_W + 0.3,
        0.22,
        F - back + 0.3,
        0,
        P + PORCH_H + 0.11,
        (F + back) / 2 + 0.15,
      ),
      TRIM,
    ),
  );
  const pedR = 2.25;
  const pedSquash = 0.36;
  const pedBase = P + PORCH_H + 0.22;
  body.push(
    paint(
      new THREE.CylinderGeometry(pedR, pedR, 0.5, 3)
        .rotateX(-Math.PI / 2)
        .scale(1, pedSquash, 1)
        .translate(0, pedBase + (pedR / 2) * pedSquash, F - 0.05),
      TRIM,
    ),
    paint(disc(0.26, 0.06).translate(0, pedBase + 0.38, F + 0.22), GOLD),
  );

  // The door: round, double-leaved, strapped in iron, in a frame of
  // voussoirs light and dark round its head, with a gilt keystone.
  const door = (g: THREE.BufferGeometry, color: string) =>
    body.push(paint(g, color));
  door(disc(DOOR_R + 0.16, 0.08).translate(0, DOOR_MID, F + 0.03), TRIM);
  door(disc(DOOR_R, 0.08).translate(0, DOOR_MID, F + 0.07), DOOR);
  door(box(0.06, DOOR_R * 1.9, 0.04, 0, DOOR_MID, F + 0.12), DOOR_DARK);
  for (const dy of [-0.45, 0.45]) {
    door(box(DOOR_R * 1.7, 0.08, 0.04, 0, DOOR_MID + dy, F + 0.12), IRON);
  }
  for (const s of [-1, 1]) {
    door(disc(0.09, 0.08).translate(s * 0.2, DOOR_MID, F + 0.15), GOLD);
  }
  const arch = DOOR_R + 0.3;
  const stones = 13;
  for (let i = 0; i < stones; i++) {
    const phi = ((i / (stones - 1)) * 2 - 1) * ((100 * Math.PI) / 180);
    const key = i === (stones - 1) / 2;
    door(
      box(key ? 0.44 : 0.36, key ? 0.56 : 0.42, 0.12)
        .rotateZ(-phi)
        .translate(
          Math.sin(phi) * arch,
          DOOR_MID + Math.cos(phi) * arch,
          F + 0.1,
        ),
      key ? GOLD : i % 2 ? TRIM : STONE_LOW,
    );
  }
  // Two steps up to it.
  body.push(
    paint(box(3.0, P, 0.45, 0, P / 2, F + 0.225), STEP),
    paint(box(3.5, P / 2, 0.4, 0, P / 4, F + 0.65), STEP),
  );

  // Windows round the rest, and banners either side of the porch.
  const ap = towerRadiusAt(GROUND_WINDOW_Y) * FACE;
  for (const a of GROUND_WINDOWS) {
    archWindow(body, lit, a, ap, GROUND_WINDOW_Y, 0.7, 1.35);
  }
  // Hung just under the cornice, most of the way down to the windows.
  const top = TOWER_GROUND_STOREY - 0.2;
  const bannerAp = towerRadiusAt(top) * FACE;
  for (const a of GROUND_BANNERS) {
    banner(body, a, bannerAp, 0.1, top, 3, 0.95);
  }
}

/** Every floor above the ground storey, up into the haze. */
function floors(body: THREE.BufferGeometry[], lit: THREE.BufferGeometry[]) {
  for (const f of towerFloors()) {
    const y1 = f.y + f.h;
    const rb = towerRadiusAt(f.y);
    const rt = towerRadiusAt(y1);
    const mid = f.y + f.h / 2;
    const ap = towerRadiusAt(mid) * FACE;
    body.push(
      paint(drum(rb, rt, f.y, y1), f.n % 2 ? STONE_ALT : STONE, ASHLAR),
    );
    // A band where each floor starts (the first's is the cornice below).
    if (f.n > 0) {
      body.push(
        paint(drum(rb + 0.12, rb + 0.12, f.y - 0.1, f.y + 0.1, false), TRIM),
      );
    }
    // Six windows, the same on every floor, so they shrink as it rises.
    for (let k = 0; k < 6; k++) {
      archWindow(
        body,
        lit,
        (k * Math.PI) / 3,
        ap,
        f.y + f.h * 0.46,
        0.16 * f.h + 0.05,
        0.42 * f.h,
      );
    }
    // Ribs between them.
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      body.push(paint(onFace(box(0.34, f.h, 0.2), a, ap, mid, 0.08), RIB));
    }
    if (hasCornice(f.n)) cornice(body, f.n, y1, rt, f.h);
    if (hasBalcony(f.n)) balcony(body, lit, y1, rt);
  }
}

/** A balcony round the top of a floor: a slate slab on corbels, an iron
 * railing, and three lanterns that light with the windows. */
function balcony(
  body: THREE.BufferGeometry[],
  lit: THREE.BufferGeometry[],
  y: number,
  r: number,
) {
  const R = r + 0.7;
  body.push(paint(drum(R - 0.14, R, y - 0.22, y, false), SLATE));
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    body.push(
      paint(onFace(box(0.26, 0.45, 0.6), a, r * FACE, y - 0.42, 0.28), RIB),
    );
  }
  const rail = R - 0.1;
  const edge = 2 * rail * Math.sin(Math.PI / SIDES);
  for (let i = 0; i < SIDES; i++) {
    const v = START + (i * 2 * Math.PI) / SIDES;
    if (y < HIGH || i % 2 === 0) {
      body.push(
        paint(
          box(
            0.07,
            0.54,
            0.07,
            Math.sin(v) * rail,
            y + 0.27,
            Math.cos(v) * rail,
          ),
          IRON,
        ),
      );
    }
    body.push(
      paint(
        onFace(
          box(edge + 0.06, 0.07, 0.07),
          (i * 2 * Math.PI) / SIDES,
          rail * FACE,
          y + 0.55,
          0,
        ),
        IRON,
      ),
    );
    if (i % 4 === 0) {
      lit.push(
        glass(
          box(
            0.18,
            0.22,
            0.18,
            Math.sin(v) * rail,
            y + 0.7,
            Math.cos(v) * rail,
          ),
        ),
      );
    }
  }
}

/** A cornice under a balcony, gilt-banded, hung with three banners. */
function cornice(
  body: THREE.BufferGeometry[],
  n: number,
  y: number,
  r: number,
  h: number,
) {
  body.push(
    paint(drum(r + 0.32, r + 0.42, y - 0.6, y - 0.22, false), TRIM),
    paint(drum(r + 0.44, r + 0.44, y - 0.5, y - 0.42, false), GOLD),
  );
  for (let k = 0; k < 3; k++) {
    const a =
      Math.PI / 6 + (k * 2 * Math.PI) / 3 + (n % 8 === 3 ? 0 : Math.PI / 3);
    banner(
      body,
      a,
      towerRadiusAt(y - h * 0.3) * FACE,
      0.32,
      y - 0.62,
      h * 0.55,
      0.75,
    );
  }
}

/** The cloud collar: rings of puffs round the tower where it fades — a
 * thin wisp low down, a full ring, and a dense deck where it's all but
 * gone. So the eye reads the missing top as above the clouds. Each puff
 * carries its ring's turn (radians a second) and bob (a phase): the
 * shader turns them (see `spinning`). */
const COLLAR = [
  { y: 30, puffs: 5, arc: 0.6, out: 1.75, size: [1.3, 2.0], speed: 0.35 },
  { y: 46, puffs: 10, arc: 1, out: 2.1, size: [1.5, 2.3], speed: -0.55 },
  { y: 56, puffs: 13, arc: 1, out: 2.5, size: [1.8, 2.8], speed: 0.4 },
];

function collar(): THREE.BufferGeometry {
  const rand = mulberry32(3030);
  const puffs: THREE.BufferGeometry[] = [];
  COLLAR.forEach((ring, j) => {
    const R = towerRadiusAt(ring.y) * ring.out;
    const turn = ring.speed / R;
    for (let i = 0; i < ring.puffs; i++) {
      const a = ((i + rand() * 0.5) / ring.puffs) * ring.arc * Math.PI * 2;
      const at = R * (0.85 + rand() * 0.3);
      const s = ring.size[0] + rand() * (ring.size[1] - ring.size[0]);
      const g = clump(
        new THREE.Vector3(
          Math.sin(a) * at,
          ring.y + (rand() - 0.5) * 3,
          Math.cos(a) * at,
        ),
        new THREE.Vector3(s, s * 0.55, s * 0.8),
        CLOUD,
        new THREE.Vector3(0, ring.y, 0),
        Math.floor(rand() * 1000),
      );
      const n = g.attributes.position.count;
      const spin = new Float32Array(n * 2);
      for (let v = 0; v < n; v++) spin.set([turn, j * 2.1], v * 2);
      g.setAttribute("spin", new THREE.BufferAttribute(spin, 2));
      puffs.push(g);
    }
  });
  return mergeGeometries(puffs) as THREE.BufferGeometry;
}

/** One tower's meshes' geometry. */
type TowerParts = {
  body: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  collar: THREE.BufferGeometry;
  shadow: THREE.BufferGeometry;
};

function buildTower(): TowerParts {
  const body: THREE.BufferGeometry[] = [];
  const lit: THREE.BufferGeometry[] = [];
  groundStorey(body, lit);
  floors(body, lit);
  return {
    body: mergeGeometries(body) as THREE.BufferGeometry,
    glow: mergeGeometries(lit) as THREE.BufferGeometry,
    collar: collar(),
    shadow: drum(
      TOWER_PLINTH - 0.3,
      towerRadiusAt(SHADOW_TOP) - 0.2,
      0,
      SHADOW_TOP,
      false,
    ),
  };
}
/** The one tower's geometry, built the first time a tower is drawn and
 * shared from then on. */
let built: TowerParts | null = null;

/** Chain a shader patch onto a material, as the other Town patches do
 * (see `seeThrough`): whatever it already patched runs first. */
export function chain<M extends THREE.Material>(
  material: M,
  key: string,
  patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void,
): M {
  const before = material.onBeforeCompile.bind(material);
  const was = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    patch(shader);
  };
  material.customProgramCacheKey = () => `${was()}:${key}`;
  return material;
}

/**
 * Coursed ashlar on the faces marked as stone: blocks laid round the
 * drum by angle, so a whole number of them (`blocks`, at `radius`) goes
 * round, in courses staggered by half a block, each block its own shade,
 * with dark joints. Measured round the axis rather than across a face, so
 * the courses run on unbroken round the corners. They keep the same count
 * as the drum narrows, so they get smaller as it rises. Far off, a
 * block's smaller than a pixel, and they give way to their average (as
 * the town's bricks do).
 */
export function ashlar<M extends THREE.Material>(
  material: M,
  radius: number,
  blocks: number,
): M {
  const height = 0.55;
  const length = (2 * Math.PI * radius) / blocks;
  return chain(material, `ashlar:${radius}:${blocks}`, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute float stone;
varying float vStone;
varying vec3 vStonePos;
varying vec3 vStoneNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
vStone = stone;
vStonePos = position;
vStoneNormal = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying float vStone;
varying vec3 vStonePos;
varying vec3 vStoneNormal;
float stoneHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
if ( vStone > 0.5 && abs( vStoneNormal.y ) < 0.5 ) {
  const float H = ${height.toFixed(3)};
  const float L = ${length.toFixed(4)};
  float u = atan( vStonePos.x, vStonePos.z ) * ${radius.toFixed(3)};
  float v = vStonePos.y;
  float px = max( fwidth( u ), fwidth( v ) );
  float row = floor( v / H );
  float along = u / L + mod( row, 2.0 ) * 0.5;
  vec2 f = vec2( fract( along ) * L, fract( v / H ) * H );
  float edge = min( min( f.x, L - f.x ), min( f.y, H - f.y ) );
  float joint = 1.0 - smoothstep( 0.025, 0.025 + px, edge );
  float tone = 0.9 + 0.16 * stoneHash( vec2( floor( along ), row ) );
  vec3 block = mix( diffuseColor.rgb * tone, diffuseColor.rgb * 0.72, joint );
  diffuseColor.rgb = mix( block, diffuseColor.rgb * 0.95, smoothstep( 0.3 * H, 0.7 * H, px ) );
}`,
      );
  });
}

/** Turn a cloud ring about the tower's axis, and bob it, on the shared
 * clock: each vertex's `spin` is its ring's turn (radians a second) and
 * bob (a phase). */
function spinning<M extends THREE.Material>(material: M): M {
  return chain(material, "spin", (shader) => {
    shader.uniforms.uTime = ambient.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
attribute vec2 spin;
uniform float uTime;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        /* glsl */ `#include <beginnormal_vertex>
float spinAngle = uTime * spin.x;
mat2 spinTurn = mat2( cos( spinAngle ), -sin( spinAngle ), sin( spinAngle ), cos( spinAngle ) );
objectNormal.xz = spinTurn * objectNormal.xz;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
transformed.xz = spinTurn * transformed.xz;
transformed.y += 0.3 * sin( uTime * ( 0.45 + 0.1 * spin.y ) + spin.y );`,
      );
  });
}

/**
 * Fade a material into the sky with height above the tower's floor, along
 * `towerFadeAt`'s curve. It stays opaque: the colour blends toward the sky
 * as seen in the same direction (the dome's own gradient, sun glow and
 * lightning; see SKY_GRADIENT_GLSL), losing its saturation first as far
 * things do. The last tenth is screen-door holes (the Town's Bayer
 * dither), so the real sky, stars and clouds show through where it ends.
 * Its haze is the sky's colour too, not the horizon's, so a far-off tower
 * vanishes against the sky above the horizon rather than standing there
 * as a pale pillar. Heights are the mesh's own, so it fades the same from
 * any island. `late` moves the fade up that far (always, or only by
 * night with `atNight`, for the windows: a few lights through the haze).
 */
function towerFade<M extends THREE.Material>(
  material: M,
  late = 0,
  atNight = false,
): M {
  const { hm, s, ditherFrom } = TOWER_FADE;
  const centre = atNight
    ? `${hm.toFixed(1)} + ${late.toFixed(1)} * uWindows`
    : (hm + late).toFixed(1);
  return chain(material, `tower:${late}:${atNight}`, (shader) => {
    Object.assign(shader.uniforms, {
      // By reference: the day cycle repaints the fade with the sky.
      uTop: skyUniforms.uTop,
      uHorizon: skyUniforms.uHorizon,
      uBottom: skyUniforms.uBottom,
      uSunDir: skyUniforms.uSunDir,
      uSunColor: skyUniforms.uSunColor,
      uFlash: skyUniforms.uFlash,
      ...(atNight ? { uWindows: windowGlow.uWindows } : {}),
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying float vTowerHeight;
varying vec3 vTowerWorld;`,
      )
      .replace(
        "#include <fog_vertex>",
        /* glsl */ `#include <fog_vertex>
vTowerHeight = transformed.y;
vTowerWorld = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz + cameraPosition;`,
      );
    // three's fog, but into the sky's colour behind the fragment rather
    // than the horizon's (depth.ts has already patched it, by now).
    const fog = THREE.ShaderChunk.fog_fragment.replaceAll(
      "fogColor",
      "towerSky",
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying float vTowerHeight;
varying vec3 vTowerWorld;
${atNight ? "uniform float uWindows;" : ""}
${SKY_GRADIENT_GLSL}
${BAYER_GLSL}
float towerFaded() {
  return 1.0 - exp2( - exp( ( vTowerHeight - ( ${centre} ) ) / ${s.toFixed(1)} ) );
}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        /* glsl */ `#include <clipping_planes_fragment>
float towerF = towerFaded();
if ( towerF > ${ditherFrom} && bayer4( gl_FragCoord.xy ) < ( towerF - ${ditherFrom} ) / ${(1 - ditherFrom).toFixed(2)} ) discard;`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.5 * towerF );`,
      )
      .replace(
        "#include <fog_fragment>",
        /* glsl */ `{
  // The sky behind this fragment, encoded as the dome's is.
  vec3 towerSky = linearToOutputTexel( vec4( skyColor( normalize( vTowerWorld - cameraPosition ) ), 1.0 ) ).rgb;
  ${fog}
  // Off-screen (see Post) both are still linear: mix them as they'd be
  // on screen, as depth.ts does the haze.
  if ( townLook.z > 0.5 ) {
    gl_FragColor.rgb = sRGBTransferEOTF( vec4( mix( sRGBTransferOETF( gl_FragColor ).rgb, sRGBTransferOETF( vec4( towerSky, 1.0 ) ).rgb, towerF ), 1.0 ) ).rgb;
  } else {
    gl_FragColor.rgb = mix( gl_FragColor.rgb, towerSky, towerF );
  }
}`,
      );
  });
}

const bodyMaterial = towerFade(
  seeThrough(
    inSeason(
      ashlar(
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          side: THREE.DoubleSide,
        }),
        TOWER_PLINTH,
        14,
      ),
    ),
  ),
);
const glassMaterial = towerFade(
  seeThrough(
    glassLighting(new THREE.MeshBasicMaterial({ color: LIT_WINDOW }), false),
  ),
  TOWER_FADE_LATE,
  true,
);
const collarMaterial = towerFade(
  spinning(new THREE.MeshLambertMaterial({ vertexColors: true })),
  TOWER_FADE_LATE,
);
/** Drawn into the sun's shadow map only: nothing on screen. */
const shadowOnly = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

/** Every Tower on the map (the home island has one). */
export function Tower({ map }: { map: TownMap }) {
  const towers = useMemo(
    () =>
      buildingsOf(map)
        .filter((b) => b.kind === "tower")
        .map((b) => ({ key: b.anchor.join(","), y: b.y, ...towerPlace(b) })),
    [map],
  );
  if (towers.length === 0) return null;
  built ??= buildTower();
  const parts = built;
  return (
    <>
      {towers.map((t) => (
        <group
          key={t.key}
          position={[t.x, t.y, t.z]}
          rotation-y={t.yaw}
          scale={t.scale}
        >
          <mesh geometry={parts.body} material={bodyMaterial} receiveShadow />
          <mesh geometry={parts.glow} material={glassMaterial} />
          <mesh geometry={parts.collar} material={collarMaterial} />
          <mesh geometry={parts.shadow} material={shadowOnly} castShadow />
        </group>
      ))}
    </>
  );
}
