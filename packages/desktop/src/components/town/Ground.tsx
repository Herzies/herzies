import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  bridgeAxis,
  cellShade,
  ISLAND_RADIUS,
  isOpenWater,
  isSunk,
  MAP_SIZE,
  OFF,
  onIsland,
  TERRAIN,
  type TerrainChar,
  type TownMap,
  terrainAt,
} from "./map";
import { Water } from "./Water";

/** How deep a pond's bed sits, and its surface. */
const BED = -0.6;
const BED_COLOR = new THREE.Color("#1b2f45");
const BANK_COLOR = new THREE.Color("#5a4030");
/** Bridges: deck top just above the ground, so you walk onto it. */
const DECK_TOP = 0.05;
const PLANKS_PER_CELL = 4;
const RAIL_HEIGHT = 0.45;

const HALF = MAP_SIZE / 2;

/** A cell corner, pulled in onto the island's edge if it's past it — so
 * the rim cells fill the island out to a round edge. */
function corner(x: number, z: number): [number, number] {
  const r = Math.hypot(x, z);
  if (r <= ISLAND_RADIUS) return [x, z];
  const s = ISLAND_RADIUS / r;
  return [x * s, z * s];
}

/**
 * The island's top, from the map: one merged, flat-shaded mesh, each cell
 * a quad coloured by what it is — grass and gravel at ground level, water
 * sunk into a bed with earth banks round it.
 */
function groundGeometry(map: TownMap): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    d: [number, number, number],
    e: [number, number, number],
    color: THREE.Color,
  ) => {
    pos.push(...a, ...b, ...d, ...a, ...d, ...e);
    for (let i = 0; i < 6; i++) col.push(color.r, color.g, color.b);
  };

  for (let row = 0; row < MAP_SIZE; row++) {
    for (let cl = 0; cl < MAP_SIZE; cl++) {
      if (!onIsland(cl, row)) continue;
      const t = terrainAt(map, cl, row);
      const x0 = cl - HALF;
      const z0 = row - HALF;
      const sunk = isSunk(t);
      const y = sunk ? BED : 0;
      const [ax, az] = corner(x0, z0);
      const [bx, bz] = corner(x0, z0 + 1);
      const [dx, dz] = corner(x0 + 1, z0 + 1);
      const [ex, ez] = corner(x0 + 1, z0);
      if (sunk) c.copy(BED_COLOR);
      else c.set(TERRAIN[(t === OFF ? "." : t) as TerrainChar].color);
      c.offsetHSL(0, 0, cellShade(cl, row) * 0.012);
      quad([ax, y, az], [bx, y, bz], [dx, y, dz], [ex, y, ez], c);

      if (!sunk) continue;
      // Banks: a wall down to the bed on every side that isn't more water.
      // (Water is never on the rim, so these corners are all inland.)
      const sides: [number, number, [number, number], [number, number]][] = [
        [cl, row - 1, [x0, z0], [x0 + 1, z0]],
        [cl, row + 1, [x0 + 1, z0 + 1], [x0, z0 + 1]],
        [cl - 1, row, [x0, z0 + 1], [x0, z0]],
        [cl + 1, row, [x0 + 1, z0], [x0 + 1, z0 + 1]],
      ];
      for (const [nc, nr, [px, pz], [qx, qz]] of sides) {
        if (isSunk(terrainAt(map, nc, nr))) continue;
        c.copy(BANK_COLOR).offsetHSL(0, 0, cellShade(nc, nr) * 0.015);
        quad([px, 0, pz], [px, BED, pz], [qx, BED, qz], [qx, 0, qz], c);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
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

const groundMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  side: THREE.DoubleSide,
});
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
