import { CuboidCollider } from "@react-three/rapier";
import { Fragment, useEffect, useMemo } from "react";
import type { TownMap } from "../map";
import { craftingStationsOf } from "./craftingSpot";
import { BENCH_HALF, workbenchGeometry, workbenchMaterial } from "./models";

/** Every Crafting Station's workbench on the map (see craftingSpot.ts),
 * turned to face its way. They share one geometry and material (the
 * see-through dither is per pixel, not per bench). Solid: you work at one
 * from in front. */
export function CraftingStation({ map }: { map: TownMap }) {
  const stations = useMemo(() => craftingStationsOf(map), [map]);
  const parts = useMemo(
    () => ({ geometry: workbenchGeometry(), material: workbenchMaterial() }),
    [],
  );
  useEffect(
    () => () => {
      parts.geometry.dispose();
      parts.material.dispose();
    },
    [parts],
  );
  return stations.map((s) => (
    <Fragment key={`${s.x},${s.z}`}>
      <mesh
        geometry={parts.geometry}
        material={parts.material}
        position={[s.x, s.y, s.z]}
        rotation={[0, s.yaw, 0]}
        castShadow
        receiveShadow
      />
      <CuboidCollider
        args={[BENCH_HALF.x, 0.5, BENCH_HALF.z]}
        position={[s.x, s.y + 0.5, s.z]}
        rotation={[0, s.yaw, 0]}
      />
    </Fragment>
  ));
}
