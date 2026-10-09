import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Look } from "../TownScene";
import { ambient } from "./ambient";

import { cellCenter, facingAt, MAP_SIZE, objectAt, type TownMap } from "./map";

/** Who a statue shows: whoever came out on top in the last boss fight. */
export type Champion = { look: Look; name: string };

/** Until the server says who won, the champion is set here by hand: eddie,
 * top damage on Nohoot Henry (2026-10-09). Their look as the server has it
 * (seeded by friend code), less ground accessories, like a herzie out
 * walking. */
export const PLACEHOLDER_CHAMPION: Champion = {
  look: {
    seed: "HERZ-2CCV",
    stage: 3,
    equipped: {
      body: "gold-chain",
      head: "headphones",
      color: "purple-dane",
      scenery: "stars",
      modifier: ["first-edition", "good-eye-sniper"],
    },
  },
  name: "eddie",
};

const PLINTH_HEIGHT = 0.7;
const STATUE_SCALE = 1.4;
const plinthGeometry = new THREE.BoxGeometry(1.15, PLINTH_HEIGHT, 1.15);
const capGeometry = new THREE.BoxGeometry(1.3, 0.12, 1.3);
// Plinths stay solid: low, and the statue on top never goes see-through.
const plinthMaterial = new THREE.MeshLambertMaterial({
  color: "#8f8a82",
  flatShading: true,
});
const capMaterial = new THREE.MeshLambertMaterial({
  color: "#a9a49b",
  flatShading: true,
});

export function statueSpots(map: TownMap): [number, number, number][] {
  const spots: [number, number, number][] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      if (objectAt(map, col, row) !== "@") continue;
      const [x, z] = cellCenter(col, row);
      // The way it was turned in the editor, else the middle of town.
      spots.push([x, z, facingAt(map, col, row) ?? Math.atan2(-x, -z)]);
    }
  }
  return spots;
}

/** One statue: the champion in stone on a plinth, facing the middle of
 * town (or the way it was turned), with a plaque. */
function Statue({
  at: [x, z, heading],
  champion,
}: {
  at: [number, number, number];
  champion: Champion;
}) {
  const lookKey = JSON.stringify(champion.look);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(() => {
    const h = new HerzieModel(champion.look, { lighting: ambient });
    h.petrify();
    h.heading = heading;
    return h;
  }, [lookKey, x, z, heading]);
  useEffect(() => () => herzie.dispose(), [herzie]);
  // Posed once, where it stands (its bands are laid out by world height).
  const posed = useRef<HerzieModel | null>(null);
  useFrame(() => {
    if (posed.current === herzie) return;
    herzie.update(0, 0);
    posed.current = herzie;
  });

  return (
    <group position={[x, 0, z]}>
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
      <group position-y={PLINTH_HEIGHT + 0.12} scale={STATUE_SCALE}>
        <primitive object={herzie.root} />
      </group>
      <Html
        position={[0, 0.25, 0]}
        center
        zIndexRange={[20, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div className="whitespace-nowrap rounded bg-black/55 px-1.5 py-0.5 text-center text-[9px] leading-tight text-text-dim">
          champion
          <div className="text-[10px] text-white">{champion.name}</div>
        </div>
      </Html>
    </group>
  );
}

/** Every statue on the map. */
export function Statues({
  map,
  champion,
}: {
  map: TownMap;
  champion: Champion;
}) {
  const spots = useMemo(() => statueSpots(map), [map]);
  return (
    <>
      {spots.map((at) => (
        <Statue key={`${at[0]},${at[1]}`} at={at} champion={champion} />
      ))}
    </>
  );
}

/** A statue is solid: plinth and all. */
export function StatueColliders({ map }: { map: TownMap }) {
  const spots = useMemo(() => statueSpots(map), [map]);
  return (
    <>
      {spots.map(([x, z]) => (
        <CylinderCollider
          key={`s${x},${z}`}
          args={[1, 0.68]}
          position={[x, 1, z]}
        />
      ))}
    </>
  );
}
