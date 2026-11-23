import { useFrame } from "@react-three/fiber";
import { CuboidCollider } from "@react-three/rapier";
import { Fragment, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { TownMap } from "../map";
import { townSave } from "../runtime";
import {
  CRAFTING_REACH,
  type CraftingSpot,
  craftingStationsOf,
  craftingTalking,
} from "./craftingSpot";
import { BENCH_HALF, workbenchGeometry, workbenchMaterial } from "./models";

/** Every Crafting Station's workbench on the map (see craftingSpot.ts),
 * turned to face its way. They share one geometry and material (the
 * see-through dither is per pixel, not per bench). Drawn outside the
 * physics (so it's there seen from a sky ship); what's solid is
 * CraftingStationColliders. Talked to, a bench wakes (BenchEyes). */
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
      <BenchEyes spot={s} />
    </Fragment>
  ));
}

/** Where the eyes sit on the board behind the bench (its front face, under
 * the tools), how far apart, and how big. */
const EYE_Y = 1.1;
const EYE_Z = -0.302;
const EYE_APART = 0.21;
const EYE_R = 0.085;
const PUPIL_R = 0.04;
/** How far a pupil wanders from the middle to look at you. */
const LOOK = 0.035;
/** How quickly the eyes open and shut (per second, eased). */
const OPEN_RATE = 10;

const eyeWhite = new THREE.CircleGeometry(EYE_R, 16);
const eyePupil = new THREE.CircleGeometry(PUPIL_R, 12);
const whiteMaterial = new THREE.MeshBasicMaterial({ color: "#f4ead3" });
const pupilMaterial = new THREE.MeshBasicMaterial({ color: "#1a1208" });

/** A bench's eyes, on the board behind it: shut (not there at all) till you
 * talk to it, then open, blinking now and then and following you about;
 * they shut again when you're done. */
function BenchEyes({ spot }: { spot: CraftingSpot }) {
  const eyes = useRef<THREE.Group>(null);
  const pupils = useRef<(THREE.Mesh | null)[]>([]);
  const state = useRef({ open: 0, blinkAt: 2, blinkUntil: -1 });
  useFrame(({ clock }, dt) => {
    const g = eyes.current;
    if (!g) return;
    const s = state.current;
    const t = clock.elapsedTime;
    const near =
      Math.hypot(townSave.x - spot.x, townSave.z - spot.z) <
      CRAFTING_REACH + 1.5;
    const awake = craftingTalking() && near;
    if (t > s.blinkAt) {
      s.blinkUntil = t + 0.12;
      // Now and then a double blink.
      s.blinkAt = t + (Math.random() < 0.2 ? 0.3 : 2 + Math.random() * 3);
    }
    const target = awake && t >= s.blinkUntil ? 1 : 0;
    s.open = THREE.MathUtils.damp(s.open, target, OPEN_RATE, dt);
    g.visible = s.open > 0.02;
    g.scale.y = s.open;
    // You, in the bench's own frame: the pupils turn your way.
    const dx = townSave.x - spot.x;
    const dz = townSave.z - spot.z;
    const c = Math.cos(-spot.yaw);
    const n = Math.sin(-spot.yaw);
    const lx = dx * c + dz * n;
    const lz = -dx * n + dz * c;
    const d = Math.max(1, Math.hypot(lx, lz));
    const look = THREE.MathUtils.clamp((lx / d) * LOOK * 2, -LOOK, LOOK);
    for (const p of pupils.current) p?.position.set(look, -LOOK * 0.4, 0.002);
  });
  return (
    <group position={[spot.x, spot.y, spot.z]} rotation={[0, spot.yaw, 0]}>
      <group ref={eyes} position={[0, EYE_Y, EYE_Z]} visible={false}>
        {[-1, 1].map((side, i) => (
          <group key={side} position={[side * EYE_APART, 0, 0]}>
            <mesh geometry={eyeWhite} material={whiteMaterial} />
            <mesh
              ref={(m) => {
                pupils.current[i] = m;
              }}
              geometry={eyePupil}
              material={pupilMaterial}
              position-z={0.002}
            />
          </group>
        ))}
      </group>
    </group>
  );
}

/** Every Crafting Station's bench, solid: you work at one from in front. */
export function CraftingStationColliders({ map }: { map: TownMap }) {
  const stations = useMemo(() => craftingStationsOf(map), [map]);
  return stations.map((s) => (
    <CuboidCollider
      key={`${s.x},${s.z}`}
      args={[BENCH_HALF.x, 0.5, BENCH_HALF.z]}
      position={[s.x, s.y + 0.5, s.z]}
      rotation={[0, s.yaw, 0]}
    />
  ));
}
