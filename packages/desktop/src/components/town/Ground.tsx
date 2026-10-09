import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  blendsFlat,
  bridgeAxis,
  cellShade,
  groundBlend,
  groundHeight,
  ISLAND_RADIUS,
  isOpenWater,
  MAP_SIZE,
  onIsland,
  TERRAIN,
  type TownMap,
  terrainAt,
} from "./map";
import { Water } from "./Water";

const BED_COLOR = new THREE.Color("#1b2f45");
const BANK_COLOR = new THREE.Color("#5a4030");
const GRASS_COLOR = new THREE.Color(TERRAIN["."].color);
const GRAVEL_COLOR = new THREE.Color(TERRAIN.g.color);
/** Bridges: deck top just above the ground, so you walk onto it. */
const DECK_TOP = 0.05;
const PLANKS_PER_CELL = 4;
const RAIL_HEIGHT = 0.45;
/** Quads a side for a cell where the ground changes, so banks slope and
 * borders blend smoothly. A cell that's the same all round stays one. */
const SUB = 4;

const HALF = MAP_SIZE / 2;

/** A cell corner, pulled in onto the island's edge if it's past it — so
 * the rim cells fill the island out to a round edge. */
function corner(x: number, z: number): [number, number] {
  const r = Math.hypot(x, z);
  if (r <= ISLAND_RADIUS) return [x, z];
  const s = ISLAND_RADIUS / r;
  return [x * s, z * s];
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Each cell's shade wobble, eased between cell centres so it doesn't
 * step at the finer cells' edges. */
function shadeAt(x: number, z: number): number {
  const u = x + HALF - 0.5;
  const v = z + HALF - 0.5;
  const c = Math.floor(u);
  const r = Math.floor(v);
  const fu = u - c;
  const fv = v - r;
  const top = cellShade(c, r) * (1 - fu) + cellShade(c + 1, r) * fu;
  const bot = cellShade(c, r + 1) * (1 - fu) + cellShade(c + 1, r + 1) * fu;
  return top * (1 - fv) + bot * fv;
}

/** The ground at a point: its height, and its colour as grass and as
 * gravel (the shader picks between them, see groundMaterial) — where it's
 * wet, an earth bank sloping down to a dark bed. Returns how much of the
 * dry ground round it is gravel. */
const under = new THREE.Color();
function groundPoint(
  map: TownMap,
  x: number,
  z: number,
  asGrass: THREE.Color,
  asGravel: THREE.Color,
): { y: number; gravel: number } {
  const { grass, gravel, wet } = groundBlend(map, x, z);
  under.copy(BANK_COLOR).lerp(BED_COLOR, smooth(0.6, 0.9, wet));
  const k = smooth(0.3, 0.6, wet);
  const shade = shadeAt(x, z) * 0.012;
  asGrass.copy(GRASS_COLOR).lerp(under, k).offsetHSL(0, 0, shade);
  asGravel.copy(GRAVEL_COLOR).lerp(under, k).offsetHSL(0, 0, shade);
  const dry = grass + gravel;
  return { y: groundHeight(wet), gravel: dry > 0 ? gravel / dry : 0 };
}

/**
 * The island's top, from the map: one merged, flat-shaded mesh coloured
 * by what's painted — grass and gravel at ground level, water sunk into a
 * bed with sloping banks. Cells where the ground changes are split finer,
 * so its edges come out round instead of in steps.
 */
function groundGeometry(map: TownMap): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const gravelCol: number[] = [];
  const gravel: number[] = [];
  const a = new THREE.Color();
  const b = new THREE.Color();
  const vertex = (vx: number, vz: number) => {
    const [x, z] = corner(vx, vz);
    const p = groundPoint(map, x, z, a, b);
    pos.push(x, p.y, z);
    col.push(a.r, a.g, a.b);
    gravelCol.push(b.r, b.g, b.b);
    gravel.push(p.gravel);
  };

  const split = (cl: number, row: number) =>
    onIsland(cl, row) && !blendsFlat(map, cl, row) ? SUB : 1;
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let cl = 0; cl < MAP_SIZE; cl++) {
      if (!onIsland(cl, row)) continue;
      const x0 = cl - HALF;
      const z0 = row - HALF;
      const n = split(cl, row);
      if (n > 1) {
        const step = 1 / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const xa = x0 + i * step;
            const za = z0 + j * step;
            const xb = xa + step;
            const zb = za + step;
            vertex(xa, za);
            vertex(xa, zb);
            vertex(xb, zb);
            vertex(xa, za);
            vertex(xb, zb);
            vertex(xb, za);
          }
        }
        continue;
      }
      // One piece — but its edges take the same points as a finer cell
      // beside it, fanned from the middle. A corner of the finer cell
      // landing mid-edge here (a T-junction) leaves hairline cracks that
      // sparkle as the camera moves.
      const ring: [number, number][] = [];
      const edge = (
        m: number,
        fx: (t: number) => number,
        fz: (t: number) => number,
      ) => {
        for (let k = 0; k < m; k++) ring.push([fx(k / m), fz(k / m)]);
      };
      edge(
        split(cl, row - 1),
        (t) => x0 + t,
        () => z0,
      );
      edge(
        split(cl + 1, row),
        () => x0 + 1,
        (t) => z0 + t,
      );
      edge(
        split(cl, row + 1),
        (t) => x0 + 1 - t,
        () => z0 + 1,
      );
      edge(
        split(cl - 1, row),
        () => x0,
        (t) => z0 + 1 - t,
      );
      if (ring.length === 4) {
        vertex(x0, z0);
        vertex(x0, z0 + 1);
        vertex(x0 + 1, z0 + 1);
        vertex(x0, z0);
        vertex(x0 + 1, z0 + 1);
        vertex(x0 + 1, z0);
        continue;
      }
      for (let k = 0; k < ring.length; k++) {
        const [px, pz] = ring[k];
        const [qx, qz] = ring[(k + 1) % ring.length];
        // Wound like the quads above (counter-clockwise from above).
        vertex(x0 + 0.5, z0 + 0.5);
        vertex(qx, qz);
        vertex(px, pz);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("gravelColor", new THREE.Float32BufferAttribute(gravelCol, 3));
  g.setAttribute("gravel", new THREE.Float32BufferAttribute(gravel, 1));
  g.computeVertexNormals();
  return g;
}

type Board = { x: number; y: number; z: number; yaw: number; shade: number };

/** Bridge timber: the planks of each deck, and a rail (beam on two posts)
 * along each side that drops into water. */
function bridgeParts(map: TownMap) {
  const planks: Board[] = [];
  const beams: Board[] = [];
  const posts: Board[] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let cl = 0; cl < MAP_SIZE; cl++) {
      if (terrainAt(map, cl, row) !== "=") continue;
      const x = cl - HALF + 0.5;
      const z = row - HALF + 0.5;
      // Crossing along z: planks lie across it (along x), and the other way.
      const alongZ = bridgeAxis(map, cl, row) === "z";
      for (let i = 0; i < PLANKS_PER_CELL; i++) {
        const o = (i + 0.5) / PLANKS_PER_CELL - 0.5;
        planks.push({
          x: alongZ ? x : x + o,
          y: DECK_TOP - 0.04,
          z: alongZ ? z + o : z,
          yaw: alongZ ? 0 : Math.PI / 2,
          shade: cellShade(cl * 4 + i, row),
        });
      }
      // The sides: across the crossing direction.
      const sides: [number, number, number, number][] = alongZ
        ? [
            [cl - 1, row, -0.45, 0],
            [cl + 1, row, 0.45, 0],
          ]
        : [
            [cl, row - 1, 0, -0.45],
            [cl, row + 1, 0, 0.45],
          ];
      for (const [nc, nr, ox, oz] of sides) {
        if (!isOpenWater(map, nc, nr)) continue;
        const yaw = alongZ ? 0 : Math.PI / 2;
        beams.push({ x: x + ox, y: RAIL_HEIGHT, z: z + oz, yaw, shade: 0 });
        for (const end of [-0.4, 0.4]) {
          posts.push({
            x: x + ox + (alongZ ? 0 : end),
            y: RAIL_HEIGHT / 2,
            z: z + oz + (alongZ ? end : 0),
            yaw: 0,
            shade: 0,
          });
        }
      }
    }
  }
  return { planks, beams, posts };
}

/** Grass or gravel, decided per pixel where the blend crosses half: a
 * crisp border that still curves round corners, rather than a fade. */
const groundMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  side: THREE.DoubleSide,
});
groundMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
attribute vec3 gravelColor;
attribute float gravel;
varying vec3 vGravelColor;
varying float vGravel;`,
    )
    .replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
vGravelColor = gravelColor;
vGravel = gravel;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
varying vec3 vGravelColor;
varying float vGravel;`,
    )
    .replace(
      "#include <color_fragment>",
      /* glsl */ `#include <color_fragment>
float aa = fwidth( vGravel ) * 0.5;
diffuseColor.rgb = mix( diffuseColor.rgb, vGravelColor, smoothstep( 0.5 - aa, 0.5 + aa, vGravel ) );`,
    );
};
groundMaterial.customProgramCacheKey = () => "town-ground";
const plankGeometry = new THREE.BoxGeometry(
  1,
  0.08,
  1 / PLANKS_PER_CELL - 0.03,
);
const beamGeometry = new THREE.BoxGeometry(0.08, 0.08, 1);
const postGeometry = new THREE.BoxGeometry(0.08, RAIL_HEIGHT, 0.08);
const PLANK_COLOR = new THREE.Color(TERRAIN["="].color);
const plankMaterial = new THREE.MeshLambertMaterial({ flatShading: true });
const railMaterial = new THREE.MeshLambertMaterial({
  color: "#5a4030",
  flatShading: true,
});

/** An instanced set of boards, placed (and tinted) once per change. */
function Boards({
  boards,
  geometry,
  material,
  tint,
}: {
  boards: Board[];
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  tint?: THREE.Color;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const c = new THREE.Color();
    boards.forEach((b, i) => {
      q.setFromAxisAngle(up, b.yaw);
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, one);
      mesh.setMatrixAt(i, m);
      if (tint)
        mesh.setColorAt(i, c.copy(tint).offsetHSL(0, 0, b.shade * 0.05));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [boards, tint]);
  if (boards.length === 0) return null;
  return (
    <instancedMesh
      // A new count needs a new mesh.
      key={boards.length}
      ref={ref}
      args={[geometry, material, boards.length]}
    />
  );
}

/** The island's top as the map paints it: ground, ponds and bridges. */
export function Ground({ map }: { map: TownMap }) {
  const ground = useMemo(() => groundGeometry(map), [map]);
  const bridges = useMemo(() => bridgeParts(map), [map]);
  useLayoutEffect(
    () => () => {
      ground.dispose();
    },
    [ground],
  );

  return (
    <>
      <mesh geometry={ground} material={groundMaterial} />
      <Water map={map} />
      <Boards
        boards={bridges.planks}
        geometry={plankGeometry}
        material={plankMaterial}
        tint={PLANK_COLOR}
      />
      <Boards
        boards={bridges.beams}
        geometry={beamGeometry}
        material={railMaterial}
      />
      <Boards
        boards={bridges.posts}
        geometry={postGeometry}
        material={railMaterial}
      />
    </>
  );
}
