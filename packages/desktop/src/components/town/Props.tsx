import { mulberry32 } from "@herzies/shared";
import {
  CuboidCollider,
  CylinderCollider,
  RigidBody,
} from "@react-three/rapier";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { seeThrough, swayInWind } from "./ambient";

const seeThroughLambert = (p: THREE.MeshLambertMaterialParameters) =>
  seeThrough(new THREE.MeshLambertMaterial(p));

import { BenchColliders, Benches } from "./Benches";
import { BuildingColliders, Buildings, windowMaterial } from "./Buildings";
import { trunkMaterial } from "./Islands";
import {
  LANTERN_Y,
  lampPostGeometry,
  lanternGlassGeometry,
  NightLights,
} from "./Lamps";
import {
  MAP_SIZE,
  objectAt,
  objectPlace,
  type TownMap,
  waterRuns,
} from "./map";
import { type Champion, StatueColliders, Statues } from "./Statues";
import {
  SPECIES,
  type Species,
  TREE_MATERIALS,
  TREE_RADIUS,
  TREE_VARIANTS,
  treeLook,
  treeSpecies,
} from "./trees";

type Placed = {
  x: number;
  z: number;
  scale: number;
  yaw: number;
  /** Stretched taller (or shorter) than its scale. */
  tall?: number;
  /** Leaning over, about x and z, in radians. */
  tilt?: [number, number];
  /** Tinted (times its own colours). */
  tint?: THREE.Color;
};
/** One of several drawn per thing (a flower in a patch): its offset in
 * the thing's own frame, and its size. */
type Copy = { x: number; z: number; s: number };
type Part = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Where the part sits on a thing of scale 1 (and its own scale). */
  y: number;
  shape?: [number, number, number];
  /** Draw it several times per thing (default: once, in the middle). */
  copies?: Copy[];
  /** Tint each copy with one of these, picked steadily per copy. */
  palette?: string[];
};

const rockGeometry = new THREE.DodecahedronGeometry(0.55, 0);
const rockMaterial = seeThroughLambert({
  color: "#7d7a80",
  flatShading: true,
});
const stumpGeometry = new THREE.CylinderGeometry(0.34, 0.42, 0.45, 7);
const stumpTopGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.02, 7);
const stumpTopMaterial = new THREE.MeshLambertMaterial({
  color: "#b08a5a",
  flatShading: true,
});

/** A tuft of tall grass: blades leaning out every which way, dark at the
 * root and light at the tip. */
function tuftGeometry(): THREE.BufferGeometry {
  const rand = mulberry32(4711);
  const base = new THREE.Color("#2c5a2c");
  const tip = new THREE.Color("#9cc76a");
  const blades = Array.from({ length: 11 }, () => {
    const h = 0.55 + rand() * 0.45;
    const g = new THREE.ConeGeometry(0.06, h, 3).toNonIndexed();
    g.translate(0, h / 2, 0);
    g.rotateZ((rand() - 0.5) * 0.7);
    g.rotateY(rand() * Math.PI * 2);
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.4;
    g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    const pos = g.attributes.position;
    const colors: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.lerpColors(base, tip, Math.min(1, pos.getY(i) / h));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.deleteAttribute("uv");
    return g;
  });
  const tuft = mergeGeometries(blades) as THREE.BufferGeometry;
  tuft.computeVertexNormals();
  return tuft;
}

/** Spots for a few small things scattered in a cell. */
function scatter(seed: number, n: number, spread: number, min = 0.7): Copy[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * spread;
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      s: min + rand() * (1 - min),
    };
  });
}

// Plants sway in the wind (see ambient.ts); the low ones part around you.
const vertexColored = swayInWind(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  { amount: 0.3, from: 0, bend: 1 },
);
const tintable = new THREE.MeshLambertMaterial({ flatShading: true });
const blossomMaterial = swayInWind(
  new THREE.MeshLambertMaterial({ flatShading: true }),
  { amount: 0.4, from: 0, bend: 1 },
);
const stemMaterial = swayInWind(
  new THREE.MeshLambertMaterial({ color: "#3f7a3a" }),
  { amount: 0.4, from: 0, bend: 1 },
);
/** The town's stumps, see-through like the trees. */
const townTrunk = seeThrough(trunkMaterial.clone());
const FLOWERS = scatter(99, 6, 0.4);
const stemGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 3);
const blossomGeometry = new THREE.OctahedronGeometry(0.09, 0);
const MUSHROOMS = scatter(7, 3, 0.3, 0.55);
const mushroomStemGeometry = new THREE.CylinderGeometry(0.05, 0.07, 0.2, 5);
const mushroomStemMaterial = new THREE.MeshLambertMaterial({
  color: "#e6dcc6",
  flatShading: true,
});
const capGeometry = new THREE.SphereGeometry(
  0.15,
  7,
  3,
  0,
  Math.PI * 2,
  0,
  Math.PI / 2,
);

/** A bush: a few leafy lumps huddled together, dark underneath and lit
 * on top. */
function bushGeometry(): THREE.BufferGeometry {
  const dark = new THREE.Color("#2c5a2c");
  const light = new THREE.Color("#5c9a48");
  const lumps = (
    [
      [0, 0.55, 0, 0.6],
      [0.36, 0.4, 0.2, 0.45],
      [-0.32, 0.42, -0.14, 0.48],
      [0.04, 0.38, -0.4, 0.4],
      [-0.12, 0.36, 0.4, 0.38],
    ] as const
  ).map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, 0.85, 1);
    g.translate(x, y, z);
    const pos = g.attributes.position;
    const colors: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.lerpColors(dark, light, Math.min(1, Math.max(0, pos.getY(i) / 1.05)));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.deleteAttribute("uv");
    return g;
  });
  return mergeGeometries(lumps) as THREE.BufferGeometry;
}
/** Bushes sway a little (they're solid, so they don't part round you). */
const bushMaterial = swayInWind(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  { amount: 0.12, from: 0.2 },
);
const berryMaterial = swayInWind(
  new THREE.MeshLambertMaterial({ flatShading: true }),
  { amount: 0.12, from: 0.2 },
);
const berryGeometry = new THREE.IcosahedronGeometry(0.06, 0);
/** Berries (or blossoms) dotted over a bush's sides. */
const BERRIES: Copy[] = [
  { x: 0.42, z: 0.38, s: 1 },
  { x: -0.45, z: 0.25, s: 1 },
  { x: 0.08, z: 0.6, s: 1 },
  { x: 0.55, z: -0.15, s: 1 },
  { x: -0.25, z: -0.5, s: 1 },
];

/** Lamp posts: dark iron, see-through like the trees. */
const ironMaterial = seeThroughLambert({ color: "#2b2d33", flatShading: true });

/** What each kind of thing is drawn with, and how wide it blocks (0: you
 * walk through it). */
const KINDS = {
  R: {
    parts: [
      {
        geometry: rockGeometry,
        material: rockMaterial,
        y: 0.18,
        shape: [1.1, 0.65, 0.9],
      },
    ],
    radius: 0.55,
  },
  S: {
    parts: [
      { geometry: stumpGeometry, material: townTrunk, y: 0.225 },
      { geometry: stumpTopGeometry, material: stumpTopMaterial, y: 0.45 },
    ],
    radius: 0.42,
  },
  v: {
    parts: [{ geometry: tuftGeometry(), material: vertexColored, y: 0 }],
    radius: 0,
  },
  "*": {
    parts: [
      {
        geometry: stemGeometry,
        material: stemMaterial,
        y: 0.15,
        copies: FLOWERS,
      },
      {
        geometry: blossomGeometry,
        material: blossomMaterial,
        y: 0.32,
        copies: FLOWERS,
        palette: ["#f2d03b", "#f4f1ea", "#e86fa8", "#9b86f0", "#e8573f"],
      },
    ],
    radius: 0,
  },
  m: {
    parts: [
      {
        geometry: mushroomStemGeometry,
        material: mushroomStemMaterial,
        y: 0.1,
        copies: MUSHROOMS,
      },
      {
        geometry: capGeometry,
        material: tintable,
        y: 0.18,
        copies: MUSHROOMS,
        palette: ["#c8372d", "#c8372d", "#a0703f", "#d9a441"],
      },
    ],
    radius: 0,
  },
  B: {
    parts: [
      { geometry: bushGeometry(), material: bushMaterial, y: 0 },
      {
        geometry: berryGeometry,
        material: berryMaterial,
        y: 0.74,
        copies: BERRIES,
        palette: ["#c8372d", "#c8372d", "#7a3fa0", "#f4f1ea"],
      },
    ],
    radius: 0.7,
  },
  L: {
    parts: [
      { geometry: lampPostGeometry(), material: ironMaterial, y: 0 },
      {
        geometry: lanternGlassGeometry,
        material: windowMaterial,
        y: LANTERN_Y,
      },
    ],
    radius: 0.2,
  },
} satisfies Record<string, { parts: Part[]; radius: number }>;
type Kind = keyof typeof KINDS;
const ONCE: Copy[] = [{ x: 0, z: 0, s: 1 }];

/** The trees, by kind and shape: one draw call each. */
const TREE_BUCKETS = SPECIES.flatMap((species) =>
  TREE_VARIANTS[species].map((geometry, variant) => ({
    key: `${species}${variant}`,
    species,
    part: { geometry, material: TREE_MATERIALS[species], y: 0 } satisfies Part,
  })),
);

function placeAll(map: TownMap) {
  const placed = Object.fromEntries(
    Object.keys(KINDS).map((k) => [k, []]),
  ) as unknown as Record<Kind, Placed[]>;
  const trees: Record<string, Placed[]> = Object.fromEntries(
    TREE_BUCKETS.map((b) => [b.key, []]),
  );
  const species: Record<Species, Placed[]> = { pine: [], oak: [] };
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      const o = objectAt(map, col, row);
      if (o === "T") {
        const kind = treeSpecies(map, col, row);
        const { variant, ...look } = treeLook(col, row, kind);
        const tree = { ...objectPlace(map, col, row), ...look };
        trees[`${kind}${variant}`].push(tree);
        species[kind].push(tree);
      } else if (o in KINDS) placed[o as Kind].push(objectPlace(map, col, row));
    }
  }
  return { placed, trees, species };
}

/** What casts a shadow in the sun: the small stuff (grass, flowers,
 * mushrooms) isn't worth drawing a second time for it. */
const CASTS = new Set<Kind>(["R", "S", "B", "L"]);

/** One part (say, every tree's leaves) as one instanced draw call. */
function PartMesh({
  part,
  things,
  cast,
}: {
  part: Part;
  things: Placed[];
  cast: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const lean = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const up = new THREE.Vector3(0, 1, 0);
    const [sx, sy, sz] = part.shape ?? [1, 1, 1];
    const copies = part.copies ?? ONCE;
    const color = new THREE.Color();
    let i = 0;
    for (const t of things) {
      q.setFromAxisAngle(up, t.yaw);
      if (t.tilt) {
        q.premultiply(lean.setFromEuler(euler.set(t.tilt[0], 0, t.tilt[1])));
      }
      const tall = t.tall ?? 1;
      const cos = Math.cos(t.yaw);
      const sin = Math.sin(t.yaw);
      for (const [j, cp] of copies.entries()) {
        const s = t.scale * cp.s;
        m.compose(
          new THREE.Vector3(
            t.x + (cp.x * cos + cp.z * sin) * t.scale,
            part.y * s,
            t.z + (cp.z * cos - cp.x * sin) * t.scale,
          ),
          q,
          new THREE.Vector3(sx * s, sy * s * tall, sz * s),
        );
        mesh.setMatrixAt(i, m);
        if (part.palette) {
          const pick = mulberry32(Math.round(t.x * 131 + t.z * 7919) + j)();
          color.set(part.palette[Math.floor(pick * part.palette.length)]);
          mesh.setColorAt(i, color);
        } else if (t.tint) mesh.setColorAt(i, t.tint);
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [part, things]);
  const count = things.length * (part.copies?.length ?? 1);
  if (count === 0) return null;
  return (
    <instancedMesh
      // A new count needs a new mesh.
      key={count}
      ref={ref}
      args={[part.geometry, part.material, count]}
      castShadow={cast}
      receiveShadow
    />
  );
}

/**
 * What stands on the island — trees, rocks, stumps, tall grass, flowers,
 * mushrooms — instanced, one draw call per part, and the buildings and
 * statues. The tall ones go see-through when they're between the camera
 * and the player (see `seeThrough`).
 */
export function Props({
  map,
  champion,
}: {
  map: TownMap;
  /** Who the statues show. */
  champion: Champion;
}) {
  const { placed, trees } = useMemo(() => placeAll(map), [map]);
  return (
    <>
      {TREE_BUCKETS.map((b) => (
        <PartMesh key={b.key} part={b.part} things={trees[b.key]} cast />
      ))}
      {(Object.keys(KINDS) as Kind[]).flatMap((k) =>
        KINDS[k].parts.map((part, i) => (
          <PartMesh
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed parts list
            key={`${k}${i}`}
            part={part}
            things={placed[k]}
            cast={CASTS.has(k)}
          />
        )),
      )}
      <Buildings map={map} />
      <NightLights map={map} />
      <Benches map={map} />
      <Statues map={map} champion={champion} />
    </>
  );
}

/**
 * Everything on the map you can't walk through, as one fixed body: a
 * cylinder per tree, rock, stump and statue, a box per building block, and a box
 * per run of open water (bridges have none, so you can cross them).
 */
export function MapColliders({ map }: { map: TownMap }) {
  const { placed, species } = useMemo(() => placeAll(map), [map]);
  const runs = useMemo(() => waterRuns(map), [map]);
  return (
    <RigidBody type="fixed" colliders={false}>
      {SPECIES.flatMap((k) =>
        species[k].map((t) => (
          <CylinderCollider
            key={`T${t.x},${t.z}`}
            args={[1, TREE_RADIUS[k] * t.scale]}
            position={[t.x, 1, t.z]}
          />
        )),
      )}
      {(Object.keys(KINDS) as Kind[]).flatMap((k) =>
        KINDS[k].radius === 0
          ? []
          : placed[k].map((t) => (
              <CylinderCollider
                key={`${k}${t.x},${t.z}`}
                args={[1, KINDS[k].radius * t.scale]}
                position={[t.x, 1, t.z]}
              />
            )),
      )}
      {runs.map((w) => (
        <CuboidCollider
          key={`w${w.x0},${w.z0}`}
          args={[(w.x1 - w.x0) / 2, 1, (w.z1 - w.z0) / 2]}
          position={[(w.x0 + w.x1) / 2, 1, (w.z0 + w.z1) / 2]}
        />
      ))}
      <BuildingColliders map={map} />
      <BenchColliders map={map} />
      <StatueColliders map={map} />
    </RigidBody>
  );
}
