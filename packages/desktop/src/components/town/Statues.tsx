import type { ClassRole } from "@herzies/shared";
import { AWARD_NAMES, AWARD_ROLES } from "@herzies/shared/combat";
import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import type { Champion, Champions } from "./champion";
import { homeMode } from "./homeMode";
import { cellCenter, facingAt, groundY, objectAt, type TownMap } from "./map";
import { nameOpacity } from "./nameFade";
import { townSave } from "./runtime";

export type { Champion, Champions } from "./champion";

const PLINTH_HEIGHT = 0.7;
const STATUE_SCALE = 1.4;
/** From the middle of the plinth to each winner: three at the corners of
 * a triangle, a good stride apart. */
const RING = 1.3;
/** The plinth: a square with room for the triangle; its cap a little
 * bigger. */
const PLINTH_WIDTH = 3.5;
const PLINTH_DEPTH = PLINTH_WIDTH;
const CAP_WIDTH = PLINTH_WIDTH + 0.15;
const CAP_DEPTH = PLINTH_DEPTH + 0.15;
const plinthGeometry = new THREE.BoxGeometry(
  PLINTH_WIDTH,
  PLINTH_HEIGHT,
  PLINTH_DEPTH,
);
const capGeometry = new THREE.BoxGeometry(CAP_WIDTH, 0.12, CAP_DEPTH);
// Plinths stay solid: low, and the statues on top never go see-through.
const plinthMaterial = new THREE.MeshLambertMaterial({
  color: "#8f8a82",
  flatShading: true,
});
const capMaterial = new THREE.MeshLambertMaterial({
  color: "#a9a49b",
  flatShading: true,
});

/** The chain fence round the plinth: this far out from its middle, a
 * little way out from the cap. */
const FENCE_HALF = CAP_WIDTH / 2 + 0.55;
const POST_HEIGHT = 0.75;
/** Where the chain hangs from a post, and how far it sags mid-span. */
const CHAIN_Y = 0.62;
const CHAIN_SAG = 0.14;
/** One link's length along the chain. */
const LINK_LENGTH = 0.1;
const fenceMaterial = new THREE.MeshLambertMaterial({
  color: "#34343a",
  flatShading: true,
});

/** The fence, in the statue's own space: iron posts at the corners and the
 * middle of each side, each on a little foot with a ball on top, and a
 * chain sagging from one to the next, its links turned alternately flat
 * and upright. One geometry, one draw. */
function fenceGeometry(): THREE.BufferGeometry {
  const f = FENCE_HALF;
  const posts: [number, number][] = [
    [-f, -f],
    [0, -f],
    [f, -f],
    [f, 0],
    [f, f],
    [0, f],
    [-f, f],
    [-f, 0],
  ];
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, z] of posts) {
    parts.push(
      new THREE.CylinderGeometry(0.11, 0.13, 0.06, 6).translate(x, 0.03, z),
      new THREE.CylinderGeometry(0.04, 0.05, POST_HEIGHT, 6).translate(
        x,
        POST_HEIGHT / 2,
        z,
      ),
      new THREE.SphereGeometry(0.065, 8, 6).translate(x, POST_HEIGHT + 0.03, z),
    );
  }
  const link = new THREE.TorusGeometry(0.032, 0.01, 4, 8).scale(1.4, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const along = new THREE.Vector3();
  const across = new THREE.Vector3();
  const out = new THREE.Vector3();
  const m = new THREE.Matrix4();
  posts.forEach(([ax, az], i) => {
    const [bx, bz] = posts[(i + 1) % posts.length];
    const n = Math.round(Math.hypot(bx - ax, bz - az) / LINK_LENGTH);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      // A parabola: near enough a hanging chain at this sag.
      along.set(bx - ax, -4 * CHAIN_SAG * (1 - 2 * t), bz - az).normalize();
      out.crossVectors(along, up).normalize();
      // Every other link turned a quarter round the chain.
      if (k % 2) across.copy(out);
      else across.crossVectors(out, along);
      m.makeBasis(along, across, out.crossVectors(along, across));
      m.setPosition(
        ax + (bx - ax) * t,
        CHAIN_Y - 4 * CHAIN_SAG * t * (1 - t),
        az + (bz - az) * t,
      );
      parts.push(link.clone().applyMatrix4(m));
    }
  });
  link.dispose();
  const merged = mergeGeometries(parts) as THREE.BufferGeometry;
  for (const p of parts) p.dispose();
  return merged;
}
const fence = fenceGeometry();

/** Every statue: [x, z, heading, the ground it stands on]. */
export function statueSpots(map: TownMap): [number, number, number, number][] {
  const spots: [number, number, number, number][] = [];
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== "@") continue;
      const [x, z] = cellCenter(map, col, row);
      // The way it was turned in the editor, else the middle of town.
      spots.push([
        x,
        z,
        facingAt(map, col, row) ?? Math.atan2(-x, -z),
        groundY(map, x, z),
      ]);
    }
  }
  return spots;
}

/** One statue: the three award winners in stone on one square plinth,
 * back to back in a triangle, each facing its own way, roped off with a
 * chain. Soundproof faces the middle of town (or the way it was turned);
 * Big Hitter stands back on the left as you face it, Lifesaver back on the
 * right; each with a plaque. A role with nobody leaves its place empty. */
function Statue({
  at: [x, z, heading, y],
  champions,
}: {
  at: [number, number, number, number];
  champions: Champions;
}) {
  return (
    <>
      <group position={[x, y, z]} rotation-y={heading}>
        <mesh
          geometry={plinthGeometry}
          material={plinthMaterial}
          position-y={PLINTH_HEIGHT / 2}
          castShadow
          receiveShadow
        />
        <mesh
          geometry={capGeometry}
          material={capMaterial}
          position-y={PLINTH_HEIGHT + 0.06}
          castShadow
          receiveShadow
        />
        <mesh geometry={fence} material={fenceMaterial} castShadow />
      </group>
      {AWARD_ROLES.map((role, i) => {
        const champion = champions[role];
        // A third of a turn apart, each facing out from the middle: Big
        // Hitter a third to the left, Soundproof straight on, Lifesaver a
        // third to the right.
        const facing = heading + ((i - 1) * 2 * Math.PI) / 3;
        return champion ? (
          <Winner
            key={role}
            role={role}
            champion={champion}
            at={[
              x + RING * Math.sin(facing),
              z + RING * Math.cos(facing),
              facing,
              y,
            ]}
          />
        ) : null;
      })}
    </>
  );
}

/** One winner on the plinth, petrified, with a plaque: its name, then its
 * award. */
function Winner({
  role,
  champion,
  at: [x, z, heading, y],
}: {
  role: ClassRole;
  champion: Champion;
  at: [number, number, number, number];
}) {
  const lookKey = JSON.stringify(champion.look);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(() => {
    const h = new HerzieModel(champion.look, { lighting: ambient });
    h.petrify();
    h.heading = heading;
    // Stone: its cloak hangs as it settled, for good.
    h.clothDetail = "frozen";
    return h;
  }, [lookKey, x, y, z, heading]);
  useEffect(() => () => herzie.dispose(), [herzie]);
  // Posed once, where it stands (its bands are laid out by world height).
  const posed = useRef<HerzieModel | null>(null);
  // The plaque fades in as you come near.
  const plaque = useRef<HTMLDivElement>(null);
  useFrame(() => {
    // Settled at Home the plaque's already faded out (see nameOpacity).
    if (homeMode.full) return;
    if (plaque.current) {
      plaque.current.style.opacity = String(
        nameOpacity(Math.hypot(townSave.x - x, townSave.z - z)),
      );
    }
    if (posed.current === herzie) return;
    herzie.update(0, 0);
    posed.current = herzie;
  });

  return (
    <group position={[x, y, z]}>
      <group position-y={PLINTH_HEIGHT + 0.12} scale={STATUE_SCALE}>
        <primitive object={herzie.root} />
      </group>
      <Html
        position={[0, 0.25, 0]}
        center
        zIndexRange={[20, 0]}
        style={{ pointerEvents: "none" }}
      >
        {/* The award under the name, smaller, as a worn title reads under
            a herzie's. */}
        <div
          ref={plaque}
          style={{ opacity: 0 }}
          className="whitespace-nowrap text-center text-[9px] leading-tight text-white [text-shadow:0_1px_3px_#000,0_0_6px_#000]"
        >
          <div className="text-[10px] text-white">{champion.name}</div>
          {AWARD_NAMES[role]}
        </div>
      </Html>
    </group>
  );
}

/** Every statue on the map. */
export function Statues({
  map,
  champions,
}: {
  map: TownMap;
  champions: Champions;
}) {
  const spots = useMemo(() => statueSpots(map), [map]);
  return (
    <>
      {spots.map((at) => (
        <Statue key={`${at[0]},${at[1]}`} at={at} champions={champions} />
      ))}
    </>
  );
}

/** A statue is solid out to its fence. */
export function StatueColliders({ map }: { map: TownMap }) {
  const spots = useMemo(() => statueSpots(map), [map]);
  return (
    <>
      {spots.map(([x, z, heading, y]) => (
        <CuboidCollider
          key={`s${x},${z}`}
          args={[FENCE_HALF, 1, FENCE_HALF]}
          position={[x, y + 1, z]}
          rotation={[0, heading, 0]}
        />
      ))}
    </>
  );
}
