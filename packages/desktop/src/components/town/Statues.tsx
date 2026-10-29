import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ambient } from "./ambient";
import type { Champion } from "./champion";
import { cellCenter, facingAt, groundY, objectAt, type TownMap } from "./map";
import { nameOpacity } from "./nameFade";
import { townSave } from "./runtime";

export type { Champion } from "./champion";

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

/** One statue: the champion in stone on a plinth, facing the middle of
 * town (or the way it was turned), with a plaque. */
function Statue({
  at: [x, z, heading, y],
  champion,
}: {
  at: [number, number, number, number];
  champion: Champion;
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
        <div
          ref={plaque}
          style={{ opacity: 0 }}
          className="whitespace-nowrap text-center text-[9px] leading-tight text-white/70 [text-shadow:0_1px_3px_#000,0_0_6px_#000]"
        >
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
      {spots.map(([x, z, , y]) => (
        <CylinderCollider
          key={`s${x},${z}`}
          args={[1, 0.68]}
          position={[x, y + 1, z]}
        />
      ))}
    </>
  );
}
