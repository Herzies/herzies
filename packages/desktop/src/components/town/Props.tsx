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

import { BuildingColliders, Buildings } from "./Buildings";
import {
  leafGeometry,
  leafMaterial,
  trunkGeometry,
  trunkMaterial,
} from "./Islands";
import {
  MAP_SIZE,
  objectAt,
  objectJitter,
  type TownMap,
  waterRuns,
} from "./map";
import {
  type Champion,
  StatueColliders,
  Statues,
  statueSpots,
} from "./Statues";

type Placed = { x: number; z: number; scale: number; yaw: number };
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
/** The town's own leaves: the canopy sways above the trunk. (The distant
 * islands' trees keep the still original.) */
const swayingLeaves = seeThrough(
  swayInWind(leafMaterial.clone(), { amount: 0.035, from: 2.8 }),
);
/** The town's own trunks (and stumps), see-through like the leaves. */
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

/** What each kind of thing is drawn with, and how wide it blocks (0: you
 * walk through it). */
const KINDS = {
  T: {
    parts: [
      // Stretched taller than the distant islands' trees: up close, a
      // tree should tower over a herzie.
      {
        geometry: leafGeometry,
        material: swayingLeaves,
        y: 6.8,
        shape: [1.4, 2.6, 1.4],
      },
      {
        geometry: trunkGeometry,
        material: townTrunk,
        y: 1.5,
        shape: [1.5, 3, 1.5],
      },
    ],
    radius: 0.45,
  },
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
} satisfies Record<string, { parts: Part[]; radius: number }>;
type Kind = keyof typeof KINDS;
const ONCE: Copy[] = [{ x: 0, z: 0, s: 1 }];

function placeAll(map: TownMap): Record<Kind, Placed[]> {
  const placed = Object.fromEntries(
    Object.keys(KINDS).map((k) => [k, []]),
  ) as unknown as Record<Kind, Placed[]>;
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      const o = objectAt(map, col, row);
      if (o in KINDS) placed[o as Kind].push(objectJitter(col, row));
    }
  }
  return placed;
}

/** One part (say, every tree's leaves) as one instanced draw call. */
function PartMesh({ part, things }: { part: Part; things: Placed[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const [sx, sy, sz] = part.shape ?? [1, 1, 1];
    const copies = part.copies ?? ONCE;
    const color = new THREE.Color();
    let i = 0;
    for (const t of things) {
      q.setFromAxisAngle(up, t.yaw);
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
          new THREE.Vector3(sx * s, sy * s, sz * s),
        );
        mesh.setMatrixAt(i, m);
        if (part.palette) {
          const pick = mulberry32(Math.round(t.x * 131 + t.z * 7919) + j)();
          color.set(part.palette[Math.floor(pick * part.palette.length)]);
          mesh.setColorAt(i, color);
        }
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
  const placed = useMemo(() => placeAll(map), [map]);
  return (
    <>
      {(Object.keys(KINDS) as Kind[]).flatMap((k) =>
        KINDS[k].parts.map((part, i) => (
          <PartMesh
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed parts list
            key={`${k}${i}`}
            part={part}
            things={placed[k]}
          />
        )),
      )}
      <BlobShadows map={map} placed={placed} />
      <Buildings map={map} />
      <Statues map={map} champion={champion} />
    </>
  );
}

/** How wide a soft shadow each kind of thing casts (× its size). */
const SHADOW_RADIUS: Partial<Record<Kind, number>> = {
  B: 1.1,
  T: 1.5,
  R: 0.85,
  S: 0.6,
};
const shadowGeometry = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
const shadowMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
});

/** Soft dark discs under trees, rocks, stumps and statues, so they stand
 * on the ground rather than float on it (herzies have their own). */
function BlobShadows({
  map,
  placed,
}: {
  map: TownMap;
  placed: Record<Kind, Placed[]>;
}) {
  const discs = useMemo(() => {
    const out: { x: number; z: number; r: number }[] = [];
    for (const [k, r] of Object.entries(SHADOW_RADIUS) as [Kind, number][]) {
      for (const t of placed[k]) out.push({ x: t.x, z: t.z, r: r * t.scale });
    }
    for (const [x, z] of statueSpots(map)) out.push({ x, z, r: 1 });
    return out;
  }, [map, placed]);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    discs.forEach((d, i) => {
      m.makeScale(d.r, 1, d.r).setPosition(d.x, 0.02, d.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [discs]);
  if (discs.length === 0) return null;
  return (
    <instancedMesh
      key={discs.length}
      ref={ref}
      args={[shadowGeometry, shadowMaterial, discs.length]}
      renderOrder={-1}
    />
  );
}

/**
 * Everything on the map you can't walk through, as one fixed body: a
 * cylinder per tree, rock, stump and statue, a box per building block, and a box
 * per run of open water (bridges have none, so you can cross them).
 */
export function MapColliders({ map }: { map: TownMap }) {
  const placed = useMemo(() => placeAll(map), [map]);
  const runs = useMemo(() => waterRuns(map), [map]);
  return (
    <RigidBody type="fixed" colliders={false}>
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
      <StatueColliders map={map} />
    </RigidBody>
  );
}
