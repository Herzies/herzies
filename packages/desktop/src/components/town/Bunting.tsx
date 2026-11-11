import { mulberry32 } from "@herzies/shared";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import { LANTERN_Y } from "./Lamps";
import {
  cellAt,
  groundY,
  isBuildingChar,
  objectAt,
  objectJitter,
  onIsland,
  type TownMap,
} from "./map";

// Bunting strung between the lamp posts along the streets: a rope sagging
// from one lantern to the next, little pennants hanging off it, all of it
// swinging in the same gusts as the trees and grass (see ambient.ts) and
// the pennants fluttering. Two draw calls for the whole island: the ropes
// as one set of line segments, the pennants as one mesh, moved on the GPU.

/** Lamps closer than this are strung together; further, the rope would
 * sag to the ground. Never closer than MIN: that's two lamps on one
 * corner. */
const MAX_SPAN = 14;
const MIN_SPAN = 3.5;
/** How many strings a lamp post carries at most. */
const PER_LAMP = 2;
/** Where the rope ties on: just below the lantern's floor, high enough
 * that the pennants clear a stage-3 herzie's head mid-span. */
const TIE_BELOW = 0.3;
/** How much the rope sags in the middle, per unit of span. */
const SAG = 0.03;
/** Pennants this far apart along the rope. */
const PENNANT_EVERY = 0.75;
const PENNANT_W = 0.24;
const PENNANT_H = 0.32;
const PENNANT_COLORS = ["#e04a4a", "#f2c94c", "#4a8fe0", "#5cb85c", "#f4f1ea"];
const ROPE_COLOR = "#5a4632";
/** Points along each rope: enough that the sag reads as a curve. */
const ROPE_STEPS = 10;

export type BuntingLine = {
  from: [number, number, number];
  to: [number, number, number];
};

/** The strings on this island: between lamp posts near enough each other,
 * with nothing in the way (a house between them would have the rope
 * through its roof), two to a post at most, nearest first. */
export function buntingOf(map: TownMap): BuntingLine[] {
  const lamps: { x: number; y: number; z: number; strings: number }[] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== "L") continue;
      const { x, z, scale } = objectJitter(map, col, row);
      lamps.push({
        x,
        y: groundY(map, x, z) + LANTERN_Y * scale - TIE_BELOW * scale,
        z,
        strings: 0,
      });
    }
  }
  const pairs: { a: number; b: number; d: number }[] = [];
  for (let a = 0; a < lamps.length; a++) {
    for (let b = a + 1; b < lamps.length; b++) {
      const d = Math.hypot(lamps[a].x - lamps[b].x, lamps[a].z - lamps[b].z);
      if (d >= MIN_SPAN && d <= MAX_SPAN) pairs.push({ a, b, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const out: BuntingLine[] = [];
  for (const { a, b, d } of pairs) {
    const la = lamps[a];
    const lb = lamps[b];
    if (la.strings >= PER_LAMP || lb.strings >= PER_LAMP) continue;
    if (!clearBetween(map, la, lb, d)) continue;
    la.strings++;
    lb.strings++;
    out.push({ from: [la.x, la.y, la.z], to: [lb.x, lb.y, lb.z] });
  }
  return out;
}

/** Nothing tall between two lamps: no building, no tree. Over water is
 * fine. */
function clearBetween(
  map: TownMap,
  a: { x: number; z: number },
  b: { x: number; z: number },
  d: number,
): boolean {
  const n = Math.ceil(d / 0.5);
  const seen = new Set<string>();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const [col, row] = cellAt(
      map,
      a.x + (b.x - a.x) * t,
      a.z + (b.z - a.z) * t,
    );
    const key = `${col},${row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!onIsland(map, col, row)) return false;
    const o = objectAt(map, col, row);
    if (isBuildingChar(o) || o === "T" || o === "@" || o === "O") return false;
  }
  return true;
}

/** Where the rope is `t` of the way along, sagging in the middle. */
function ropePoint(line: BuntingLine, t: number, out: THREE.Vector3) {
  const [x0, y0, z0] = line.from;
  const [x1, y1, z1] = line.to;
  const span = Math.hypot(x1 - x0, z1 - z0);
  const sag = span * SAG * 4 * t * (1 - t);
  return out.set(
    x0 + (x1 - x0) * t,
    y0 + (y1 - y0) * t - sag,
    z0 + (z1 - z0) * t,
  );
}

/** Lets a material swing in the gusts: `hang` says how free each vertex
 * is (0 where the rope's tied, 1 in the middle), `flap` how much it
 * flutters besides (the pennants' loose corners). The same gust as
 * swayInWind, so the bunting moves with the trees round it. */
function hanging<M extends THREE.Material>(material: M): M {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: ambient.uTime,
      uWindDir: ambient.uWindDir,
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
attribute float hang;
attribute float flap;`,
      )
      .replace(
        "#include <project_vertex>",
        /* glsl */ `vec4 mvPosition = vec4( transformed, 1.0 );
vec4 worldPos = modelMatrix * mvPosition;
float along = dot( worldPos.xz, uWindDir );
float swell = 0.55 + 0.45 * sin( along * 0.07 - uTime * 0.45 );
float wave = sin( along * 0.35 - uTime * 1.7 ) + 0.35 * sin( along * 0.9 + worldPos.x * 0.3 - uTime * 2.9 );
// The rope swings downwind as a whole, lifting a little as it does.
worldPos.xz += uWindDir * wave * swell * hang * 0.22;
worldPos.y += abs( wave ) * swell * hang * 0.04;
// The pennants flutter, each corner its own way.
if ( flap > 0.0 ) {
  float phase = dot( worldPos.xyz, vec3( 2.1, 3.3, 1.7 ) );
  worldPos.xyz += flap * ( 0.4 + 0.6 * swell ) * 0.07 * vec3(
    sin( uTime * 7.1 + phase ),
    0.4 * sin( uTime * 9.3 + phase * 1.3 ),
    sin( uTime * 6.2 + phase * 0.7 )
  );
}
mvPosition = viewMatrix * worldPos;
gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  material.customProgramCacheKey = () => "bunting";
  return material;
}

const ropeMaterial = hanging(new THREE.LineBasicMaterial({ color: ROPE_COLOR }));
const pennantMaterial = hanging(
  new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  }),
);

/** The ropes (line segments) and pennants (triangles) for every string,
 * each vertex tagged with how free it hangs. */
export function buntingGeometry(lines: BuntingLine[]): {
  rope: THREE.BufferGeometry;
  pennants: THREE.BufferGeometry;
} {
  const rand = mulberry32(20261110);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const ropePos: number[] = [];
  const ropeHang: number[] = [];
  const ropeFlap: number[] = [];
  const penPos: number[] = [];
  const penHang: number[] = [];
  const penFlap: number[] = [];
  const penColor: number[] = [];
  const penNormal: number[] = [];
  const color = new THREE.Color();
  for (const line of lines) {
    for (let i = 0; i < ROPE_STEPS; i++) {
      const t0 = i / ROPE_STEPS;
      const t1 = (i + 1) / ROPE_STEPS;
      ropePoint(line, t0, p);
      ropePoint(line, t1, q);
      ropePos.push(p.x, p.y, p.z, q.x, q.y, q.z);
      ropeHang.push(4 * t0 * (1 - t0), 4 * t1 * (1 - t1));
      ropeFlap.push(0, 0);
    }
    const span = Math.hypot(
      line.to[0] - line.from[0],
      line.to[2] - line.from[2],
    );
    // Across the rope, so the pennant hangs flat facing the street.
    const dx = (line.to[0] - line.from[0]) / span;
    const dz = (line.to[2] - line.from[2]) / span;
    const n = Math.floor(span / PENNANT_EVERY);
    for (let k = 1; k <= n; k++) {
      const t = (k - 0.5) / n;
      ropePoint(line, t, p);
      const hang = 4 * t * (1 - t);
      color.set(PENNANT_COLORS[Math.floor(rand() * PENNANT_COLORS.length)]);
      const hw = PENNANT_W / 2;
      // Two corners on the rope, the point hanging below.
      const corners = [
        [p.x - dx * hw, p.y, p.z - dz * hw, 0],
        [p.x + dx * hw, p.y, p.z + dz * hw, 0],
        [p.x, p.y - PENNANT_H, p.z, 1],
      ];
      for (const [x, y, z, loose] of corners) {
        penPos.push(x, y, z);
        penHang.push(hang);
        penFlap.push(loose);
        penColor.push(color.r, color.g, color.b);
        penNormal.push(-dz, 0, dx);
      }
    }
  }
  const rope = new THREE.BufferGeometry();
  rope.setAttribute("position", new THREE.Float32BufferAttribute(ropePos, 3));
  rope.setAttribute("hang", new THREE.Float32BufferAttribute(ropeHang, 1));
  rope.setAttribute("flap", new THREE.Float32BufferAttribute(ropeFlap, 1));
  const pennants = new THREE.BufferGeometry();
  pennants.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(penPos, 3),
  );
  pennants.setAttribute("hang", new THREE.Float32BufferAttribute(penHang, 1));
  pennants.setAttribute("flap", new THREE.Float32BufferAttribute(penFlap, 1));
  pennants.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(penColor, 3),
  );
  pennants.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(penNormal, 3),
  );
  return { rope, pennants };
}

/** Bunting along the island's lamp-lit streets. */
export function Bunting({ map }: { map: TownMap }) {
  const lines = useMemo(() => buntingOf(map), [map]);
  const built = useMemo(
    () => (lines.length > 0 ? buntingGeometry(lines) : null),
    [lines],
  );
  useLayoutEffect(
    () => () => {
      built?.rope.dispose();
      built?.pennants.dispose();
    },
    [built],
  );
  if (!built) return null;
  return (
    <>
      <lineSegments
        geometry={built.rope}
        material={ropeMaterial}
        frustumCulled={false}
      />
      <mesh
        geometry={built.pennants}
        material={pennantMaterial}
        frustumCulled={false}
        castShadow
      />
    </>
  );
}
