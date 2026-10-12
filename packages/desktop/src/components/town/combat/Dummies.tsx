import { useFrame } from "@react-three/fiber";
import { CylinderCollider } from "@react-three/rapier";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { TownMap } from "../map";
import { DUMMY, type DummyState, dummiesOf, stepDummy } from "./dummy";

/**
 * The training grounds' training dummies: a stuffed burlap herzie on a post,
 * a target painted on its chest, stitched-cross eyes. A hit rocks it about
 * its base on a spring, bobbles its head, and flashes it white.
 *
 * The live dummies — the ones on the island you're on — are in
 * `liveDummies`, for the waves to hit.
 */
export const liveDummies: DummyState[] = [];

const BURLAP = "#c9a66b";
const BURLAP_DARK = "#a9854f";
const WOOD = "#6b4a2f";
const WOOD_DARK = "#4d3420";
const ROPE = "#8a6b3e";
const STITCH = "#3a2618";
const TARGET_RED = "#c8423a";
const TARGET_WHITE = "#efe6d2";

/** A part, coloured, moved into place. */
function part(
  g: THREE.BufferGeometry,
  color: string,
  at: [number, number, number] = [0, 0, 0],
  turn?: THREE.Euler,
): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (turn) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(turn));
  geo.translate(...at);
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(colors, i * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute("uv");
  return geo;
}

/** A lumpy sack: an icosphere, squashed and nudged so it isn't perfect. */
function sack(r: number, sy: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const n = Math.sin(i * 12.9898 + seed) * 43758.5453;
    const k = 1 + (n - Math.floor(n) - 0.5) * 0.08;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * sy, p.getZ(i) * k);
  }
  return g;
}

/** The base and post: they don't rock. */
function baseGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    part(
      new THREE.CylinderGeometry(0.5, 0.56, 0.14, 8),
      WOOD_DARK,
      [0, 0.07, 0],
    ),
    part(new THREE.CylinderGeometry(0.07, 0.09, 0.5, 6), WOOD, [0, 0.38, 0]),
  ]);
}

/** Everything that rocks, about the pivot (its origin): body, arms, target,
 * the rope at its waist. The head bobbles separately. */
function bodyGeometry(): THREE.BufferGeometry {
  const y = (v: number) => v - DUMMY.pivot;
  const front = DUMMY.radius * 0.93;
  const flat = new THREE.Euler(0, 0, 0);
  const ring = (r0: number, r1: number, color: string, dz: number) =>
    part(
      new THREE.RingGeometry(r0, r1, 20),
      color,
      [0, y(1.22), front + dz],
      flat,
    );
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.06, 0.07, 1.5, 6), WOOD, [0, y(1.2), 0]),
    part(sack(DUMMY.radius, 1.45, 1), BURLAP, [0, y(1.2), 0]),
    // The rope round its waist.
    part(
      new THREE.TorusGeometry(DUMMY.radius * 0.86, 0.04, 4, 14),
      ROPE,
      [0, y(0.86), 0],
      new THREE.Euler(Math.PI / 2, 0, 0),
    ),
    // The crossbar its arms are stuffed on, and the arms.
    part(
      new THREE.CylinderGeometry(0.045, 0.045, 1.5, 5),
      WOOD,
      [0, y(1.48), 0],
      new THREE.Euler(0, 0, Math.PI / 2),
    ),
    part(sack(0.16, 1.2, 2), BURLAP_DARK, [0.7, y(1.46), 0]),
    part(sack(0.16, 1.2, 3), BURLAP_DARK, [-0.7, y(1.46), 0]),
    part(sack(0.2, 0.9, 4), BURLAP, [0.42, y(1.47), 0]),
    part(sack(0.2, 0.9, 5), BURLAP, [-0.42, y(1.47), 0]),
    // The target on its chest.
    ring(0.27, 0.36, TARGET_RED, 0.01),
    ring(0.17, 0.27, TARGET_WHITE, 0.012),
    ring(0.08, 0.17, TARGET_RED, 0.014),
    part(
      new THREE.CircleGeometry(0.08, 14),
      TARGET_WHITE,
      [0, y(1.22), front + 0.016],
      flat,
    ),
  ]);
}

/** Where the head bobbles from, above the pivot. */
const NECK = 1.86;

/** The head, about the neck: a sack with stitched crosses for eyes and a
 * stitched mouth. */
function headGeometry(): THREE.BufferGeometry {
  const r = 0.3;
  const eye = (x: number) => {
    const bar = () => new THREE.BoxGeometry(0.11, 0.025, 0.02);
    return [
      part(
        bar(),
        STITCH,
        [x, 0.2, r * 0.95],
        new THREE.Euler(0, 0, Math.PI / 4),
      ),
      part(
        bar(),
        STITCH,
        [x, 0.2, r * 0.95],
        new THREE.Euler(0, 0, -Math.PI / 4),
      ),
    ];
  };
  return mergeGeometries([
    part(sack(r, 1.05, 6), BURLAP, [0, 0.18, 0]),
    // A tied-off tuft on top.
    part(new THREE.ConeGeometry(0.07, 0.14, 5), BURLAP_DARK, [0, 0.52, 0]),
    ...eye(0.11),
    ...eye(-0.11),
    part(new THREE.BoxGeometry(0.16, 0.02, 0.02), STITCH, [0, 0.07, r * 0.93]),
  ]);
}

const geometries = {
  base: baseGeometry(),
  body: bodyGeometry(),
  head: headGeometry(),
};
const baseMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

/** One dummy: its own material, so it can flash on its own. */
function Dummy({ state }: { state: DummyState }) {
  const rock = useRef<THREE.Group>(null);
  const bobble = useRef<THREE.Group>(null);
  const material = useMemo(
    () =>
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        flatShading: true,
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 0,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useFrame((_, dt) => {
    stepDummy(state, Math.min(dt, 0.1), performance.now());
    const r = rock.current;
    const h = bobble.current;
    if (!r || !h) return;
    r.rotation.set(state.rock.x, 0, state.rock.z);
    // The head lags the body: its own spring on top of the body's turn.
    h.rotation.set(
      state.bobble.x - state.rock.x * 0.4,
      0,
      state.bobble.z - state.rock.z * 0.4,
    );
    const sq = state.squash * 0.07;
    r.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
    // A flash: white, quickly gone (eased so the start reads as a pop).
    material.emissiveIntensity = state.flash ** 2 * 0.9;
  });
  return (
    <group position={[state.x, 0, state.z]} rotation-y={state.yaw}>
      <mesh
        geometry={geometries.base}
        material={baseMaterial}
        castShadow
        receiveShadow
      />
      <group ref={rock} position-y={DUMMY.pivot}>
        <mesh
          geometry={geometries.body}
          material={material}
          castShadow
          receiveShadow
        />
        <group ref={bobble} position-y={NECK - DUMMY.pivot}>
          <mesh
            geometry={geometries.head}
            material={material}
            castShadow
            receiveShadow
          />
        </group>
      </group>
    </group>
  );
}

/** Every dummy on the map. `live`: the island you're on, whose dummies
 * the waves can hit. */
export function Dummies({
  map,
  live = false,
}: {
  map: TownMap;
  live?: boolean;
}) {
  const dummies = useMemo(() => dummiesOf(map), [map]);
  useLayoutEffect(() => {
    if (!live) return;
    liveDummies.push(...dummies);
    return () => {
      for (const d of dummies) {
        const i = liveDummies.indexOf(d);
        if (i >= 0) liveDummies.splice(i, 1);
      }
    };
  }, [dummies, live]);
  return (
    <>
      {dummies.map((d) => (
        <Dummy key={d.key} state={d} />
      ))}
    </>
  );
}

/** A dummy is solid: you walk round it, and the aim stops on it. */
export function DummyColliders({ map }: { map: TownMap }) {
  const dummies = useMemo(() => dummiesOf(map), [map]);
  return (
    <>
      {dummies.map((d) => (
        <CylinderCollider
          key={`d${d.key}`}
          args={[(DUMMY.top - 0) / 2, DUMMY.radius]}
          position={[d.x, DUMMY.top / 2, d.z]}
        />
      ))}
    </>
  );
}
