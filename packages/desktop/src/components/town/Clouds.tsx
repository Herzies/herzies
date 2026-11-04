import { mulberry32 } from "@herzies/shared";
import { clump } from "@herzies/shared/gl";
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** How many clouds, and how fast the whole sky of them turns. */
const COUNT = 16;
const DRIFT = 0.006;

/** A cloud's colours: shaded blue-grey underneath, white on top. */
const CLOUD = { deep: "#c3cde0", mid: "#e4e9f3", lit: "#ffffff" };

/** One cloud: a few soft round puffs (the same rounded clumps as an oak's
 * crown, shaded as one mass), flattened, side by side. */
function puffGeometry(rand: () => number): THREE.BufferGeometry {
  const n = 3 + Math.floor(rand() * 4);
  const middle = new THREE.Vector3(0, 0, 0);
  const puffs = Array.from({ length: n }, (_, i) => {
    const r = 2.5 + rand() * 3;
    // Strung out along x, the middle ones biggest and highest.
    const high = 1 - Math.abs(i - (n - 1) / 2) / n;
    const at = new THREE.Vector3(
      (i - (n - 1) / 2) * 3.6,
      high * 1.6,
      (rand() - 0.5) * 3,
    );
    return clump(
      at,
      new THREE.Vector3(r, r * 0.6, r * 0.85),
      CLOUD,
      middle,
      Math.floor(rand() * 1000),
    );
  });
  return mergeGeometries(puffs) as THREE.BufferGeometry;
}

type Cloud = {
  geometry: THREE.BufferGeometry;
  angle: number;
  distance: number;
  y: number;
  scale: number;
  bob: number;
};

/** Smooth, and shaded softly: lit in steps like the trees (see
 * `banded`), a puff this big shows hard lines across it. */
const cloudMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.92,
});

/**
 * Clouds drifting round the island, some high and some below it, slowly
 * turning with the sky. Lit like everything else, so they go pink at dusk
 * and dark at night with the lights.
 */
export function Clouds() {
  const clouds = useMemo<Cloud[]>(() => {
    const rand = mulberry32(777);
    return Array.from({ length: COUNT }, (_, i) => ({
      geometry: puffGeometry(rand),
      angle: ((i + rand() * 0.7) / COUNT) * Math.PI * 2,
      distance: 75 + rand() * 110,
      // Two in three above the island, the rest drifting beneath it.
      y: i % 3 === 2 ? -(20 + rand() * 30) : 18 + rand() * 40,
      scale: 0.8 + rand() * 0.9,
      bob: rand() * Math.PI * 2,
    }));
  }, []);
  useLayoutEffect(
    () => () => {
      for (const c of clouds) c.geometry.dispose();
    },
    [clouds],
  );
  const ring = useRef<THREE.Group>(null);
  const meshes = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (ring.current) ring.current.rotation.y = t * DRIFT;
    clouds.forEach((c, i) => {
      const m = meshes.current[i];
      if (m) m.position.y = c.y + Math.sin(t * 0.15 + c.bob) * 1.2;
    });
  });

  return (
    <group ref={ring}>
      {clouds.map((c, i) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, seeded set
          key={i}
          ref={(m) => {
            meshes.current[i] = m;
          }}
          geometry={c.geometry}
          material={cloudMaterial}
          position={[
            Math.cos(c.angle) * c.distance,
            c.y,
            Math.sin(c.angle) * c.distance,
          ]}
          rotation-y={-c.angle + Math.PI / 2}
          scale={c.scale}
        />
      ))}
    </group>
  );
}
