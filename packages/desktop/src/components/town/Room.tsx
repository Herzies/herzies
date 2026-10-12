import { useMemo } from "react";
import * as THREE from "three";
import { islandRadius, type TownMap } from "./map";

/** The cave's wall: dark, rough rock. */
const WALL_COLOR = "#2b2536";
const WALL_HEIGHT = 11;

/**
 * A room instead of an island: a ring of rough rock round the floor, open
 * to a dark ceiling you never see. What's inside (the gravel floor, lamps,
 * rocks) is the map's own; the dark is DayLight's.
 */
export function Room({ map }: { map: TownMap }) {
  const geometry = useMemo(() => wallGeometry(islandRadius(map) - 0.6), [map]);
  const material = useMemo(
    () =>
      new THREE.MeshLambertMaterial({
        color: WALL_COLOR,
        flatShading: true,
        side: THREE.BackSide,
      }),
    [],
  );
  return <mesh geometry={geometry} material={material} position-y={-0.6} />;
}

/** A cylinder seen from inside, its rock pushed in and out so the wall
 * isn't a ring of straight panels. Seeded, so it's the same cave every time. */
function wallGeometry(radius: number): THREE.BufferGeometry {
  const around = 56;
  const rows = 7;
  const g = new THREE.CylinderGeometry(
    radius,
    radius * 1.04,
    WALL_HEIGHT,
    around,
    rows,
    true,
  );
  const pos = g.attributes.position;
  let seed = 20261010;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // One push per (ring, row), so the seam of the cylinder closes.
  const pushes: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: number[] = [];
    for (let a = 0; a < around; a++) row.push((rand() - 0.5) * 1.6);
    pushes.push(row);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = pos.getY(i);
    const row = Math.round((y / WALL_HEIGHT + 0.5) * rows);
    const a = ((Math.atan2(z, x) / (Math.PI * 2) + 1) % 1) * around;
    const push = pushes[row][Math.round(a) % around];
    // Pushed inward more the higher it goes: the room closes in overhead.
    const lean = (row / rows) * 1.2;
    const r = Math.hypot(x, z);
    const k = (r + push - lean) / r;
    pos.setX(i, x * k);
    pos.setZ(i, z * k);
  }
  g.computeVertexNormals();
  return g;
}
