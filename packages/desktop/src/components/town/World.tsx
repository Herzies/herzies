import { mulberry32 } from "@herzies/shared";
import { CylinderCollider, RigidBody } from "@react-three/rapier";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { WORLD_RADIUS } from "./runtime";

type Tree = { x: number; z: number; s: number };

/** The same trees for everyone: a seeded ring around the plaza. */
function plantTrees(): Tree[] {
  const rand = mulberry32(20261008);
  return Array.from({ length: 48 }, () => {
    const a = rand() * Math.PI * 2;
    const r = 17 + rand() * (WORLD_RADIUS - 12);
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.8 + rand() * 0.7 };
  });
}

/**
 * The static town: sky, light, ground, the plaza, and a ring of trees you
 * can't walk (or swing the camera) through. Trees are instanced — one draw
 * call for all the leaves, one for all the trunks.
 */
export function World({
  onTreeMeshes,
}: {
  /** The tree meshes, for the camera to collide with. */
  onTreeMeshes?: (meshes: THREE.Object3D[]) => void;
}) {
  const trees = useMemo(plantTrees, []);
  const leaves = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    trees.forEach((t, i) => {
      const scale = new THREE.Vector3(t.s, t.s, t.s);
      m.compose(new THREE.Vector3(t.x, 2.4 * t.s, t.z), q, scale);
      leaves.current?.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, 0.5 * t.s, t.z), q, scale);
      trunks.current?.setMatrixAt(i, m);
    });
    for (const mesh of [leaves.current, trunks.current]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    if (leaves.current && trunks.current) {
      onTreeMeshes?.([leaves.current, trunks.current]);
    }
  }, [trees, onTreeMeshes]);

  return (
    <>
      <color attach="background" args={["#1d2c44"]} />
      <fog attach="fog" args={["#1d2c44", 18, 55]} />
      <hemisphereLight args={["#bcd7ff", "#2a3a2a", 1.6]} />
      <directionalLight position={[-10, 20, 8]} intensity={1.4} />

      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[WORLD_RADIUS + 30, 48]} />
        <meshLambertMaterial color="#2f5233" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.01}>
        <circleGeometry args={[13, 48]} />
        <meshLambertMaterial color="#6b6155" />
      </mesh>

      <instancedMesh ref={leaves} args={[undefined, undefined, trees.length]}>
        <coneGeometry args={[1.3, 3.2, 6]} />
        <meshLambertMaterial color="#2d6b3a" flatShading />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, trees.length]}>
        <cylinderGeometry args={[0.2, 0.25, 1, 5]} />
        <meshLambertMaterial color="#5a4030" />
      </instancedMesh>

      {/* One fixed body holding every trunk's collider. */}
      <RigidBody type="fixed" colliders={false}>
        {trees.map((t, i) => (
          <CylinderCollider
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed, seeded set
            key={i}
            args={[1, 0.45 * t.s]}
            position={[t.x, 1, t.z]}
          />
        ))}
      </RigidBody>
    </>
  );
}
