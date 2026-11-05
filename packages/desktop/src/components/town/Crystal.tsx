import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { ambient, inSeason } from "./ambient";
import {
  CRYSTAL_GEOMETRY,
  type CrystalUniforms,
  crystalMaterial,
  FLOAT_Y,
  HALO_GEOMETRY,
  haloMaterial,
  MOTE_GEOMETRY,
  motesMaterial,
  PLINTH_GEOMETRY,
  PLINTH_R,
  RING_GEOMETRY,
  ringMaterial,
  SHARD_GEOMETRY,
  SHARD_SPOTS,
} from "./crystalModel";
import { crystalAlwaysShown, crystalLive, useCrystal } from "./crystalState";
import { cellCenter, groundY, objectAt, type TownMap } from "./map";
import { townSave } from "./runtime";

// The Crystal: a faceted crystal floating over a stone plinth. Listening
// charges it (see @herzies/shared crystal.ts); walk up and press E to attune
// and take what it's holding. It is its own meter — the glow, the pulse and
// the motes round it grow as it fills, so you can read it from across Town.

/** The map char for the Crystal ("quartz"). Painted with Q in the editor. */
export const CRYSTAL = "Q";

/** Where a Crystal stands. */
export type CrystalSpot = { x: number; y: number; z: number };

/** Every Crystal on the map. */
export function crystalsOf(map: TownMap): CrystalSpot[] {
  const out: CrystalSpot[] = [];
  for (let row = 0; row < map.size; row++)
    for (let col = 0; col < map.size; col++) {
      if (objectAt(map, col, row) !== CRYSTAL) continue;
      const [x, z] = cellCenter(map, col, row);
      out.push({ x, y: groundY(map, x, z), z });
    }
  return out;
}

/** How close you need to be to attune. */
export const CRYSTAL_REACH = 2.8;

/** The Crystal within reach, nearest first (null: none). */
export function crystalNear(
  crystals: readonly CrystalSpot[],
  x: number,
  z: number,
): CrystalSpot | null {
  let best: CrystalSpot | null = null;
  let reach = CRYSTAL_REACH;
  for (const c of crystals) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < reach) {
      reach = d;
      best = c;
    }
  }
  return best;
}

const uCharge = { value: 0 };
const uBurst = { value: 0 };
/** The Town's Crystals share one set: they show the same resonance. */
const uniforms: CrystalUniforms = { uTime: ambient.uTime, uCharge, uBurst };

const plinthMaterial = inSeason(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
);

/** How long the attune flash lasts, seconds. */
const BURST_SECONDS = 1.4;
/** Past this, the crystal and its motes stop animating (still drawn). */
const ANIMATE_REACH = 60;

function OneCrystal({ spot }: { spot: CrystalSpot }) {
  const materials = useMemo(
    () => ({
      crystal: crystalMaterial(uniforms),
      halo: haloMaterial(uniforms),
      motes: motesMaterial(uniforms),
      ring: ringMaterial(uniforms),
    }),
    [],
  );
  useLayoutEffect(
    () => () => {
      for (const m of Object.values(materials)) m.dispose();
    },
    [materials],
  );
  const refs = useMemo(
    () => ({
      spin: null as THREE.Group | null,
      shards: null as THREE.Group | null,
      ring: null as THREE.Mesh | null,
    }),
    [],
  );
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // Ease the charge toward the live value so a sync's jump glides.
    uCharge.value += (crystalLive.charge - uCharge.value) * 0.05;
    const since = performance.now() / 1000 - crystalLive.burstAt;
    const burst =
      since >= 0 && since < BURST_SECONDS
        ? (1 - since / BURST_SECONDS) ** 2
        : 0;
    uBurst.value = burst;
    if (Math.hypot(townSave.x - spot.x, townSave.z - spot.z) > ANIMATE_REACH)
      return;
    const fill = Math.min(1, uCharge.value);
    if (refs.spin) {
      refs.spin.rotation.y = t * (0.25 + fill * 0.5);
      refs.spin.position.y = FLOAT_Y + Math.sin(t * 1.3) * 0.08 + burst * 0.25;
      refs.spin.scale.setScalar(1 + burst * 0.2);
    }
    if (refs.shards) {
      refs.shards.rotation.y = -t * (0.4 + fill * 0.8);
      refs.shards.position.y = FLOAT_Y + Math.sin(t * 0.9) * 0.05;
    }
    if (refs.ring) {
      refs.ring.visible = burst > 0;
      refs.ring.scale.setScalar(0.5 + (1 - burst) * 4);
    }
  });
  return (
    <group position={[spot.x, spot.y, spot.z]}>
      <mesh
        geometry={PLINTH_GEOMETRY}
        material={plinthMaterial}
        castShadow
        receiveShadow
      />
      <group
        ref={(g) => {
          refs.spin = g;
        }}
        position-y={FLOAT_Y}
      >
        <mesh
          geometry={CRYSTAL_GEOMETRY}
          material={materials.crystal}
          castShadow
        />
      </group>
      <group
        ref={(g) => {
          refs.shards = g;
        }}
        position-y={FLOAT_Y}
      >
        {SHARD_SPOTS.map((s, i) => (
          <mesh
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed shards
            key={i}
            geometry={SHARD_GEOMETRY}
            material={materials.crystal}
            position={s.position}
            rotation-z={s.tilt}
          />
        ))}
      </group>
      <mesh
        geometry={HALO_GEOMETRY}
        material={materials.halo}
        position-y={FLOAT_Y}
        frustumCulled={false}
      />
      <points
        geometry={MOTE_GEOMETRY}
        material={materials.motes}
        position-y={FLOAT_Y}
        frustumCulled={false}
      />
      <mesh
        ref={(m) => {
          refs.ring = m;
        }}
        geometry={RING_GEOMETRY}
        material={materials.ring}
        position-y={0.05}
        visible={false}
      />
    </group>
  );
}

/** Every Crystal on the map. */
export function Crystals({ map }: { map: TownMap }) {
  const spots = useMemo(() => crystalsOf(map), [map]);
  // Not there at all until the server turns the Crystal on.
  const enabled = useCrystal()?.enabled === true || crystalAlwaysShown;
  if (!enabled) return null;
  return (
    <>
      {spots.map((s) => (
        <OneCrystal key={`crystal${s.x},${s.z}`} spot={s} />
      ))}
    </>
  );
}

/** The plinth is solid; you attune from beside it. */
export function CrystalColliders({ map }: { map: TownMap }) {
  const spots = useMemo(() => crystalsOf(map), [map]);
  const enabled = useCrystal()?.enabled === true || crystalAlwaysShown;
  if (!enabled) return null;
  return (
    <>
      {spots.map((s) => (
        <CylinderCollider
          key={`crystal${s.x},${s.z}`}
          args={[0.6, PLINTH_R * 0.9]}
          position={[s.x, s.y + 0.6, s.z]}
        />
      ))}
    </>
  );
}
