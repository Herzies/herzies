import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { Fragment, useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { ambient, inSeason } from "../ambient";
import { groundY, type TownMap } from "../map";
import { townSave } from "../runtime";
import {
  CRADLE_GEOMETRY,
  HUNT_CRYSTAL_GEOMETRY,
  HUNT_DAIS_R,
  HUNT_FLOAT_Y,
  HUNT_HALO_GEOMETRY,
  HUNT_MOTE_GEOMETRY,
  HUNT_RING_GEOMETRY,
  type HuntUniforms,
  huntArcGeometry,
  huntArcMaterial,
  huntCrystalMaterial,
  huntHaloMaterial,
  huntMotesMaterial,
  huntRingMaterial,
} from "./huntCrystalModel";
import {
  huntCrystalsOf,
  type HuntCrystalSpot as Spot,
} from "./huntCrystalSpot";
import { type CacheSpot, huntNow, useWildsLoot, wildsLoot } from "./loot";

/**
 * The Hunt Crystal: the Wilds' meter for its next cache, as a thing in the
 * world rather than a bar on the screen. Everyone on the Wilds with music
 * playing fills it (the room counts; see shared wilds-loot.ts): a grey
 * lump of stone, still in its cradle, when it's empty; gold rising up it
 * from the foot as it fills, turning quicker and glowing brighter the
 * fuller it gets. Full, the hunt's on: it flashes, a ring of gold rolls out
 * across the camp, it spins and blazes, and an arc of light leaps from it
 * toward the cache, stopping high over the trees short of it (the rest is
 * yours to find), there till someone opens it. Then it goes dull and
 * starts again.
 *
 * Painted on a map like any object (see huntCrystalSpot.ts); the Wilds has
 * one in its safe camp, and you can talk to it. Its cradle is solid.
 */

/** How long the flash when it fills lasts, and the arc takes to draw
 * itself out (seconds). */
const BURST_SECONDS = 1.6;
const GROW_SECONDS = 1.4;
/** How far along its way to the cache the arc goes before it fades out,
 * high over the trees: it shows the way, not the spot. */
const ARC_REACH = 0.62;
/** How far the ring rolls out when it fills (world units). */
const RING_REACH = 16;
/** Turns a second: still when it's dull, up to this full, and faster
 * still while the hunt's on. */
const SPIN_FULL = 2.6;
const SPIN_HUNT = 7;
/** Past this, it stops animating (still drawn). */
const ANIMATE_REACH = 90;

const cradleMaterial = inSeason(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
);

/** The Hunt Crystals share one set of uniforms: they show the same
 * crystal (the room has one). */
const uniforms: HuntUniforms = {
  uTime: ambient.uTime,
  uCharge: { value: 0 },
  uHunt: { value: 0 },
  uBurst: { value: 0 },
};

/** Eases the shared uniforms toward the room's word, once a frame (by
 * whichever crystal draws first). The room's first word on arriving is
 * taken at once: the crystal is as full as it is, not filling up as you
 * step ashore. */
let easedAt = -1;
let heard = false;
function ease(frame: number, dt: number) {
  if (frame === easedAt) return;
  easedAt = frame;
  const now = performance.now();
  const on = wildsLoot.cache ? 1 : 0;
  const k = wildsLoot.hunt && !heard ? 1 : 1 - Math.exp(-dt * 3);
  heard = wildsLoot.hunt !== null;
  uniforms.uCharge.value += (huntNow(now) - uniforms.uCharge.value) * k;
  uniforms.uHunt.value += (on - uniforms.uHunt.value) * k;
  const since = (now - wildsLoot.huntOnAt) / 1000;
  uniforms.uBurst.value =
    since >= 0 && since < BURST_SECONDS ? (1 - since / BURST_SECONDS) ** 2 : 0;
}

function OneHuntCrystal({ spot }: { spot: Spot }) {
  const materials = useMemo(
    () => ({
      crystal: huntCrystalMaterial(uniforms),
      halo: huntHaloMaterial(uniforms),
      motes: huntMotesMaterial(uniforms),
      ring: huntRingMaterial(uniforms),
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
      ring: null as THREE.Mesh | null,
      angle: 0,
    }),
    [],
  );
  useFrame(({ clock }, dt) => {
    ease(clock.elapsedTime, dt);
    if (Math.hypot(townSave.x - spot.x, townSave.z - spot.z) > ANIMATE_REACH)
      return;
    const t = clock.elapsedTime;
    const fill = Math.min(1, uniforms.uCharge.value);
    const hunt = uniforms.uHunt.value;
    const burst = uniforms.uBurst.value;
    refs.angle +=
      Math.min(dt, 0.1) * (SPIN_FULL * fill * fill + SPIN_HUNT * hunt);
    if (refs.spin) {
      refs.spin.rotation.y = refs.angle;
      // A wobble as it wakes; full, it rises clear of its cradle.
      refs.spin.rotation.z = Math.sin(t * 1.7) * 0.06 * fill * (1 - hunt);
      refs.spin.position.y =
        HUNT_FLOAT_Y +
        Math.sin(t * 1.3) * 0.08 * fill +
        hunt * 0.45 +
        burst * 0.3;
      refs.spin.scale.setScalar(1 + burst * 0.25 + hunt * 0.08);
    }
    if (refs.ring) {
      refs.ring.visible = burst > 0;
      refs.ring.scale.setScalar(1 + (1 - burst) * RING_REACH);
    }
  });
  return (
    <group position={[spot.x, spot.y, spot.z]}>
      <mesh
        geometry={CRADLE_GEOMETRY}
        material={cradleMaterial}
        castShadow
        receiveShadow
      />
      <group
        ref={(g) => {
          refs.spin = g;
        }}
        position-y={HUNT_FLOAT_Y}
      >
        <mesh
          geometry={HUNT_CRYSTAL_GEOMETRY}
          material={materials.crystal}
          castShadow
        />
      </group>
      <mesh
        geometry={HUNT_HALO_GEOMETRY}
        material={materials.halo}
        position-y={HUNT_FLOAT_Y}
        frustumCulled={false}
      />
      <points
        geometry={HUNT_MOTE_GEOMETRY}
        material={materials.motes}
        position-y={HUNT_FLOAT_Y}
        frustumCulled={false}
      />
      <mesh
        ref={(m) => {
          refs.ring = m;
        }}
        geometry={HUNT_RING_GEOMETRY}
        material={materials.ring}
        position-y={0.06}
        visible={false}
      />
    </group>
  );
}

/** The arc of light from a crystal at `spot` toward the cache out,
 * stopping in the air ARC_REACH of the way there. It draws itself out
 * from the crystal when the cache turns up while you're there (one already
 * out is simply there). */
function HuntArc({
  spot,
  cache,
  map,
}: {
  spot: Spot;
  cache: CacheSpot;
  map: TownMap;
}) {
  const geometry = useMemo(
    () =>
      huntArcGeometry(
        new THREE.Vector3(spot.x, spot.y + HUNT_FLOAT_Y + 1.2, spot.z),
        new THREE.Vector3(
          cache.x,
          groundY(map, cache.x, cache.z) + 0.6,
          cache.z,
        ),
      ),
    [spot, cache.x, cache.z, map],
  );
  const material = useMemo(() => huntArcMaterial(uniforms), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  // Live: drawn out from when it filled. A newcomer's: whole at once.
  const from = wildsLoot.huntOnAt >= cache.at - 1 ? wildsLoot.huntOnAt : null;
  useFrame(() => {
    const u = material.uniforms;
    const grow =
      from === null
        ? 1
        : Math.min(1, (performance.now() - from) / 1000 / GROW_SECONDS);
    u.uGrow.value = grow * ARC_REACH;
    u.uOn.value = uniforms.uHunt.value;
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

/** Every Hunt Crystal on the map, and while a cache is out, its arc.
 * Drawn outside the physics, so it's there seen from a sky ship; what's
 * solid is HuntCrystalColliders. */
export function HuntCrystals({ map }: { map: TownMap }) {
  useWildsLoot();
  const spots = useMemo(() => huntCrystalsOf(map), [map]);
  const cache = wildsLoot.cache;
  return spots.map((s) => (
    <Fragment key={`${s.x},${s.z}`}>
      <OneHuntCrystal spot={s} />
      {cache ? (
        <HuntArc key={cache.id} spot={s} cache={cache} map={map} />
      ) : null}
    </Fragment>
  ));
}

/** Every Hunt Crystal's cradle, solid. */
export function HuntCrystalColliders({ map }: { map: TownMap }) {
  const spots = useMemo(() => huntCrystalsOf(map), [map]);
  return spots.map((s) => (
    <CylinderCollider
      key={`${s.x},${s.z}`}
      args={[0.5, HUNT_DAIS_R * 0.9]}
      position={[s.x, s.y + 0.5, s.z]}
    />
  ));
}
