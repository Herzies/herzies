import { mulberry32 } from "@herzies/shared";
import { bushGeometry, rockGeometry, tuftGeometry } from "@herzies/shared/gl";
import { useFrame } from "@react-three/fiber";
import {
  CuboidCollider,
  CylinderCollider,
  RigidBody,
} from "@react-three/rapier";
import { type ReactNode, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient, banded, inSeason, seasonNow, swayInWind } from "./ambient";

import { BenchColliders, Benches } from "./Benches";
import { BoardColliders, Boards } from "./Boards";
import { BuildingColliders, Buildings, lanternMaterial } from "./Buildings";
import { barrelGeometry, potsGeometry } from "./clutter";
import { Dummies, DummyColliders } from "./combat/Dummies";
import { trunkMaterial } from "./Islands";
import {
  LANTERN_Y,
  lampPostGeometry,
  lanternGlassGeometry,
  NightLights,
} from "./Lamps";
import {
  cellAt,
  elevation,
  isOpenWater,
  objectAt,
  objectPlace,
  type TownMap,
  terrainAt,
  waterRuns,
} from "./map";
import { Portals } from "./Portals";
import { type Copy, type Part, PartMesh, type Placed, painted } from "./parts";
import type { SeasonLook } from "./Seasons";
import { StandColliders, Stands } from "./Stands";
import { type Champion, StatueColliders, Statues } from "./Statues";
import {
  SPECIES,
  type Species,
  TREE_MATERIALS,
  TREE_RADIUS,
  TREE_SHADOWS,
  TREE_VARIANTS,
  treeLook,
  treeSpecies,
} from "./trees";

/** Rocks and stumps aren't see-through like the trees: low on the
 * ground, they never hide the player, and dithered they only speckle. */
const rockMaterial = inSeason(
  new THREE.MeshLambertMaterial({
    color: "#7d7a80",
    flatShading: true,
  }),
);
const stumpGeometry = new THREE.CylinderGeometry(0.34, 0.42, 0.45, 7);
const stumpTopGeometry = new THREE.CylinderGeometry(0.3, 0.3, 0.02, 7);
const stumpTopMaterial = inSeason(
  new THREE.MeshLambertMaterial({
    color: "#b08a5a",
    flatShading: true,
  }),
);

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
const vertexColored = inSeason(
  swayInWind(
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    { amount: 0.3, from: 0, bend: 1 },
  ),
  "leaf",
);
const tintable = new THREE.MeshLambertMaterial({ flatShading: true });
const blossomMaterial = swayInWind(
  new THREE.MeshLambertMaterial({ flatShading: true }),
  { amount: 0.4, from: 0, bend: 1 },
);
const stemMaterial = inSeason(
  swayInWind(new THREE.MeshLambertMaterial({ color: "#3f7a3a" }), {
    amount: 0.4,
    from: 0,
    bend: 1,
  }),
  "leaf",
);
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

/** Bushes sway a little (they're solid, so they don't part round you).
 * Smooth and lit in steps, like the trees' crowns (see `banded`). */
const bushMaterial = inSeason(
  swayInWind(banded(new THREE.MeshLambertMaterial({ vertexColors: true })), {
    amount: 0.12,
    from: 0.2,
  }),
  "leaf",
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

/** Lamp posts: dark iron. Not see-through like the trees: a post is too
 * slight to hide the player, and dithered it only speckles them. */
const ironMaterial = new THREE.MeshLambertMaterial({
  color: "#2b2d33",
  flatShading: true,
});

/** Barrels and pots: solid, low and not swaying; snowed on in winter. */
const clutterMaterial = inSeason(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
);

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
      { geometry: stumpGeometry, material: trunkMaterial, y: 0.225 },
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
  b: {
    parts: [{ geometry: barrelGeometry(), material: clutterMaterial, y: 0 }],
    radius: 0.4,
  },
  p: {
    parts: [{ geometry: potsGeometry(), material: clutterMaterial, y: 0 }],
    radius: 0,
  },
  L: {
    parts: [
      { geometry: lampPostGeometry(), material: ironMaterial, y: 0 },
      {
        geometry: lanternGlassGeometry,
        material: lanternMaterial,
        y: LANTERN_Y,
      },
    ],
    radius: 0.2,
  },
} satisfies Record<string, { parts: Part[]; radius: number }>;
type Kind = keyof typeof KINDS;

/** The trees, by kind and shape: one draw call each. */
const TREE_BUCKETS = SPECIES.flatMap((species) =>
  TREE_VARIANTS[species].map((geometry, variant) => ({
    key: `${species}${variant}`,
    species,
    part: {
      geometry,
      material: TREE_MATERIALS[species],
      shadow: TREE_SHADOWS[species],
      y: 0,
    } satisfies Part,
  })),
);

// --- What comes and goes with the seasons --------------------------------------

/** A pumpkin: squat, ribbed (a low-poly sphere's facets), with a stalk. */
function pumpkinGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    painted(
      new THREE.SphereGeometry(0.3, 8, 5)
        .scale(1, 0.72, 1)
        .translate(0, 0.2, 0),
      "#e0782a",
    ),
    painted(
      new THREE.CylinderGeometry(0.035, 0.05, 0.14, 5).translate(0, 0.46, 0),
      "#5a6a2a",
    ),
  ]) as THREE.BufferGeometry;
}

/** A snowman: three balls of snow, coal eyes and buttons, a carrot nose
 * and a twig arm each side. Faces +z. */
function snowmanGeometry(): THREE.BufferGeometry {
  const snow = "#e8eef6";
  const coal = "#22232a";
  const twig = "#5a4030";
  const parts = [
    painted(new THREE.IcosahedronGeometry(0.46, 1).translate(0, 0.4, 0), snow),
    painted(new THREE.IcosahedronGeometry(0.33, 1).translate(0, 1.0, 0), snow),
    painted(new THREE.IcosahedronGeometry(0.24, 1).translate(0, 1.44, 0), snow),
    painted(
      new THREE.ConeGeometry(0.045, 0.24, 5)
        .rotateX(Math.PI / 2)
        .translate(0, 1.44, 0.32),
      "#e8782a",
    ),
    ...[-0.08, 0.08].map((x) =>
      painted(
        new THREE.BoxGeometry(0.05, 0.05, 0.03).translate(x, 1.52, 0.22),
        coal,
      ),
    ),
    ...[1.12, 0.98, 0.84].map((y) =>
      painted(
        new THREE.BoxGeometry(0.05, 0.05, 0.03).translate(
          0,
          y,
          0.32 - (1.12 - y) * 0.1,
        ),
        coal,
      ),
    ),
    ...[-1, 1].map((side) =>
      painted(
        new THREE.CylinderGeometry(0.02, 0.025, 0.55, 4)
          .rotateZ(side * -1.1)
          .translate(side * 0.52, 1.12, 0),
        twig,
      ),
    ),
  ];
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** A heap of fallen leaves, a few colours. */
function leafPileGeometry(): THREE.BufferGeometry {
  const rand = mulberry32(1031);
  const colors = ["#c8432a", "#e0782a", "#d9a032", "#a8502a"];
  return mergeGeometries(
    Array.from({ length: 6 }, (_, i) => {
      const a = rand() * Math.PI * 2;
      const r = rand() * 0.35;
      return painted(
        new THREE.IcosahedronGeometry(0.3 + rand() * 0.15, 0)
          .scale(1, 0.28, 1)
          .translate(Math.cos(a) * r, 0.03, Math.sin(a) * r),
        colors[i % colors.length],
      );
    }),
  ) as THREE.BufferGeometry;
}

/** Seasonal things aren't see-through or swaying: low, and solid. */
const seasonalMaterial = inSeason(
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
);
const PUMPKIN: Part = {
  geometry: pumpkinGeometry(),
  material: seasonalMaterial,
  y: 0,
};
const SNOWMAN: Part = {
  geometry: snowmanGeometry(),
  material: inSeason(
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  ),
  y: 0,
};
const LEAF_PILE: Part = {
  geometry: leafPileGeometry(),
  material: seasonalMaterial,
  y: 0,
};
/** At most this many snowmen on an island. */
const SNOWMEN = 3;

/** Where the seasonal things go, the same every year: pumpkins on open
 * grass beside the paths, snowmen a little further out, and a heap of
 * leaves at the foot of some of the oaks. */
export function placeSeasonal(map: TownMap, oaks: Placed[]) {
  const pumpkins: Placed[] = [];
  const snowmen: Placed[] = [];
  const isPath = (c: number, r: number) => terrainAt(map, c, r) === "g";
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
      if (terrainAt(map, col, row) !== "." || objectAt(map, col, row) !== ".")
        continue;
      const byPath = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dc, dr]) => isPath(col + dc, row + dr));
      const pick = mulberry32(col * 7349 + row * 15661 + 31)();
      const at = objectPlace(map, col, row);
      if (byPath && pick < 0.05)
        pumpkins.push({ ...at, scale: 0.8 + pick * 4 });
      else if (byPath && pick > 0.985 && snowmen.length < SNOWMEN)
        snowmen.push({ ...at, scale: 1 });
    }
  }
  const leafPiles = oaks
    .filter((_, i) => i % 2 === 0)
    .map((t, i) => {
      const a = mulberry32(i + 77)() * Math.PI * 2;
      return {
        ...t,
        x: t.x + Math.cos(a) * 1.1 * t.scale,
        z: t.z + Math.sin(a) * 1.1 * t.scale,
        tall: 1,
        tilt: undefined,
        tint: undefined,
      };
    });
  return { pumpkins, snowmen, leafPiles };
}

/** Its things, there for as much of the year as `weight` says: they rise
 * out of the ground as their season comes and sink back as it goes (the
 * ground hides them), and aren't drawn at all out of season. */
function InSeason({
  weight,
  depth,
  children,
}: {
  weight: (look: SeasonLook) => number;
  /** How far down they sink: as tall as they are. */
  depth: number;
  children: ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const w = THREE.MathUtils.clamp(weight(seasonNow.look), 0, 1);
    group.visible = w > 0.01;
    group.position.y = -(1 - w) * depth;
  });
  return <group ref={ref}>{children}</group>;
}

const inFall = (l: SeasonLook) => l.fall * (1 - l.snow) * 1.5 - 0.25;
const inSnow = (l: SeasonLook) => l.snow * 1.4 - 0.4;
const noSnow = (l: SeasonLook) => 1 - l.snow * 1.5;

function SeasonalProps({ map, oaks }: { map: TownMap; oaks: Placed[] }) {
  const { pumpkins, snowmen, leafPiles } = useMemo(
    () => placeSeasonal(map, oaks),
    [map, oaks],
  );
  return (
    <>
      <InSeason weight={inFall} depth={0.7}>
        <PartMesh part={PUMPKIN} things={pumpkins} cast />
        <PartMesh part={LEAF_PILE} things={leafPiles} cast={false} />
      </InSeason>
      <InSeason weight={inSnow} depth={1.8}>
        <PartMesh part={SNOWMAN} things={snowmen} cast />
      </InSeason>
    </>
  );
}

function placeAll(map: TownMap) {
  const placed = Object.fromEntries(
    Object.keys(KINDS).map((k) => [k, []]),
  ) as unknown as Record<Kind, Placed[]>;
  const trees: Record<string, Placed[]> = Object.fromEntries(
    TREE_BUCKETS.map((b) => [b.key, []]),
  );
  const species: Record<Species, Placed[]> = { pine: [], oak: [] };
  for (let row = 0; row < map.size; row++) {
    for (let col = 0; col < map.size; col++) {
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

/** What isn't drawn on an island seen across the sky (see Backdrop). */
const TOO_SMALL_TO_SEE = new Set<Kind>(["v", "*", "m", "S", "p", "b"]);

/** What casts a shadow in the sun: the small stuff (grass, flowers,
 * mushrooms) isn't worth drawing a second time for it. */
const CASTS = new Set<Kind>(["R", "S", "B", "L", "b", "p"]);

/**
 * What stands on the island — trees, rocks, stumps, tall grass, flowers,
 * mushrooms — instanced, one draw call per part, and the buildings and
 * statues. The tall ones go see-through when they're between the camera
 * and the player (see `seeThrough`).
 */
export function Props({
  map,
  champion,
  backdrop = false,
}: {
  map: TownMap;
  /** Who the statues show. */
  champion: Champion;
  /** Another island, seen across the sky: no lamps lighting this one, and
   * no statues (their plaques would float over it). */
  backdrop?: boolean;
}) {
  const { placed, trees, species } = useMemo(() => placeAll(map), [map]);
  return (
    <>
      {TREE_BUCKETS.map((b) => (
        <PartMesh key={b.key} part={b.part} things={trees[b.key]} cast />
      ))}
      {(Object.keys(KINDS) as Kind[]).flatMap((k) =>
        // Across the sky, the little things can't be made out.
        backdrop && TOO_SMALL_TO_SEE.has(k)
          ? []
          : KINDS[k].parts.map((part, i) => {
              const mesh = (
                <PartMesh
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed parts list
                  key={`${k}${i}`}
                  part={part}
                  things={placed[k]}
                  cast={CASTS.has(k)}
                />
              );
              // Flowers are gone under the snow.
              return k === "*" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed parts list
                <InSeason key={`${k}${i}`} weight={noSnow} depth={0.5}>
                  {mesh}
                </InSeason>
              ) : (
                mesh
              );
            }),
      )}
      {!backdrop && <SeasonalProps map={map} oaks={species.oak} />}
      <Buildings map={map} />
      {!backdrop && <NightLights map={map} />}
      <Benches map={map} />
      <Stands map={map} />
      <Boards map={map} />
      {!backdrop && <Statues map={map} champion={champion} />}
      <Dummies map={map} live={!backdrop} />
      <Portals map={map} live={!backdrop} />
    </>
  );
}

/** Whether the ponds are frozen hard enough to walk on (see Seasons.ts):
 * re-rendering only when that changes. A thaw waits for you to be off
 * the ice, so the water's colliders don't come back with you inside. */
function useFrozen(map: TownMap): boolean {
  const [frozen, setFrozen] = useState(() => seasonNow.look.ice > 0.5);
  useFrame(() => {
    const now = seasonNow.look.ice > 0.5;
    if (now === frozen) return;
    const { x, z } = ambient.uPlayer.value;
    if (!now && isOpenWater(map, ...cellAt(map, x, z))) return;
    setFrozen(now);
  });
  return frozen;
}

/** A box per run of open water (bridges have none, so you can cross
 * them) — none while it's frozen over, when you can walk out on the ice. */
function WaterColliders({ map }: { map: TownMap }) {
  const runs = useMemo(() => waterRuns(map), [map]);
  const frozen = useFrozen(map);
  if (frozen || runs.length === 0) return null;
  return (
    <RigidBody type="fixed" colliders={false}>
      {runs.map((w) => {
        // Tall enough to hold its whole run, if the run is on a slope.
        const ends = [w.x0, w.x1].map((x) => elevation(map, x, w.z0));
        const lo = Math.min(...ends);
        const half = 1 + (Math.max(...ends) - lo) / 2;
        return (
          <CuboidCollider
            key={`w${w.x0},${w.z0}`}
            args={[(w.x1 - w.x0) / 2, half, (w.z1 - w.z0) / 2]}
            position={[(w.x0 + w.x1) / 2, lo + half, (w.z0 + w.z1) / 2]}
          />
        );
      })}
    </RigidBody>
  );
}

/**
 * Everything on the map you can't walk through, as fixed bodies: a
 * cylinder per tree, rock, stump and statue, a box per building block, and
 * the water (see WaterColliders).
 */
export function MapColliders({ map }: { map: TownMap }) {
  const { placed, species } = useMemo(() => placeAll(map), [map]);
  return (
    <>
      <WaterColliders map={map} />
      <RigidBody type="fixed" colliders={false}>
        {SPECIES.flatMap((k) =>
          species[k].map((t) => (
            <CylinderCollider
              key={`T${t.x},${t.z}`}
              args={[1, TREE_RADIUS[k] * t.scale]}
              position={[t.x, t.y + 1, t.z]}
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
                  position={[t.x, t.y + 1, t.z]}
                />
              )),
        )}
        <BuildingColliders map={map} />
        <BenchColliders map={map} />
        <StandColliders map={map} />
        <BoardColliders map={map} />
        <StatueColliders map={map} />
        <DummyColliders map={map} />
      </RigidBody>
    </>
  );
}
