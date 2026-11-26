import type { ClassRole } from "@herzies/shared";
import { AWARD_NAMES, AWARD_ROLES } from "@herzies/shared/combat";
import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import type { Champion, Champions } from "./champion";
import { homeMode } from "./homeMode";
import { cellCenter, facingAt, groundY, objectAt, type TownMap } from "./map";
import { nameOpacity } from "./nameFade";
import { townSave } from "./runtime";

export type { Champion, Champions } from "./champion";

const PLINTH_HEIGHT = 0.7;
const STATUE_SCALE = 1.4;
/** From one winner to the next along the plinth. */
const SPACING = 1.5;
/** The plinth: room for three, side by side; its cap a little bigger. */
const PLINTH_WIDTH = 2 * SPACING + 1.15;
const PLINTH_DEPTH = 1.15;
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

/** One statue: the three award winners in stone on one wide plinth,
 * facing the middle of town (or the way it was turned) — Big Hitter on
 * the left as you face it, Soundproof in the middle, Lifesaver on the
 * right — each with a plaque. A role with nobody leaves its place empty. */
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
      </group>
      {AWARD_ROLES.map((role, i) => {
        const champion = champions[role];
        // Along the plinth, to the right as you face it (its heading
        // turned a quarter).
        const along = (i - 1) * SPACING;
        return champion ? (
          <Winner
            key={role}
            role={role}
            champion={champion}
            at={[
              x + along * Math.cos(heading),
              z - along * Math.sin(heading),
              heading,
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

/** A statue is solid: plinth and all. */
export function StatueColliders({ map }: { map: TownMap }) {
  const spots = useMemo(() => statueSpots(map), [map]);
  return (
    <>
      {spots.map(([x, z, heading, y]) => (
        <CuboidCollider
          key={`s${x},${z}`}
          args={[CAP_WIDTH / 2, 1, CAP_DEPTH / 2]}
          position={[x, y + 1, z]}
          rotation={[0, heading, 0]}
        />
      ))}
    </>
  );
}
