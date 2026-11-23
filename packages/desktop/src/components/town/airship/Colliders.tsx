import {
  CuboidCollider,
  CylinderCollider,
  RigidBody,
} from "@react-three/rapier";
import { useMemo } from "react";
import { BenchColliders } from "../Benches";
import { groundY, type TownMap } from "../map";
import { mapById } from "../maps";
import { berthOf } from "./berth";
import { dockObstacles } from "./DockModel";
import { DECK_OBSTACLES, RAIL_THICKNESS, railRuns } from "./deck";

/** Taller than anything that walks, so nothing hops over a rail. */
const WALL = 3;

/**
 * A deck's walls, for the physics of whoever's aboard (in the deck's own
 * frame, which is where physics runs while you're on a ship): the rail all
 * the way round but for the gangway — walked through onto the gangplank
 * while it's out, and shut by the step itself while it isn't (see
 * keepOnDeck) — the helm, the bell post and the benches.
 */
export function DeckColliders() {
  const deck = useMemo(() => mapById("airship"), []);
  const rails = useMemo(
    () =>
      railRuns().map(([x0, z0, x1, z1], i) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        // Outside the outline: the run's normal on the side away from the
        // deck's middle.
        let nx = (z1 - z0) / len;
        let nz = -(x1 - x0) / len;
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        if (nx * -mx + nz * -mz > 0) {
          nx = -nx;
          nz = -nz;
        }
        const off = RAIL_THICKNESS / 2;
        return {
          key: `rail${i}`,
          half: [len / 2 + RAIL_THICKNESS, WALL / 2, off] as [
            number,
            number,
            number,
          ],
          at: [mx + nx * off, WALL / 2, mz + nz * off] as [
            number,
            number,
            number,
          ],
          // Its length (local x) along the run: rotateY takes x to
          // (cos θ, −sin θ).
          yaw: Math.atan2(-(z1 - z0), x1 - x0),
        };
      }),
    [],
  );
  return (
    <RigidBody type="fixed" colliders={false}>
      {rails.map((r) => (
        <CuboidCollider
          key={r.key}
          args={r.half}
          position={r.at}
          rotation={[0, r.yaw, 0]}
        />
      ))}
      {DECK_OBSTACLES.map((o) => (
        <CylinderCollider
          key={`post${o.x},${o.z}`}
          args={[WALL / 2, o.r]}
          position={[o.x, WALL / 2, o.z]}
        />
      ))}
      <BenchColliders map={deck} />
    </RigidBody>
  );
}

/** The Sky Dock's posts on an island (its pier is walked on). */
export function DockColliders({ map }: { map: TownMap }) {
  const posts = useMemo(() => {
    const b = berthOf(map);
    return b ? dockObstacles(b) : [];
  }, [map]);
  if (posts.length === 0) return null;
  return (
    <RigidBody type="fixed" colliders={false}>
      {posts.map((p) => (
        <CylinderCollider
          key={`dock${p.x},${p.z}`}
          args={[1, p.r]}
          position={[p.x, groundY(map, p.x, p.z) + 1, p.z]}
        />
      ))}
    </RigidBody>
  );
}
