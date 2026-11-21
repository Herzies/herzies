import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import type { TownMap } from "../map";
import { berthOf } from "./berth";
import { dockOf } from "./boarding";
import { DockModel } from "./DockModel";
import { fleet } from "./fleet";
import { dockBells } from "./shipSounds";

/** An island's Sky Dock (if it has one), in the island's frame: its pier,
 * lanterns, sign and bell, which swings when the ship's bell is rung. */
export function Dock({ map }: { map: TownMap }) {
  const model = useMemo(() => {
    const b = berthOf(map);
    return b ? new DockModel(b) : null;
  }, [map]);
  useEffect(() => () => model?.dispose(), [model]);
  const dock = dockOf(map);
  const bell = useMemo(
    () => ({ bell: Number.POSITIVE_INFINITY, strikes: 0 }),
    [],
  );
  useFrame((_, dt) => {
    if (!model) return;
    const rung = dock ? dockBells[dock] : null;
    bell.bell = rung ? (fleet.now - rung.at) / 1000 : Number.POSITIVE_INFINITY;
    bell.strikes = rung ? rung.strikes : 0;
    model.update(dt, fleet.now / 1000, bell);
  });
  return model ? <primitive object={model.root} /> : null;
}
