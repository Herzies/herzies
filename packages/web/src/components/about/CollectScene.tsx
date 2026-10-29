"use client";

import {
  ITEMS,
  type ItemDef,
  NON_DROPPABLE_ITEM_IDS,
  RARITY_COLORS,
  SH,
} from "@herzies/shared";
import {
  HerzieModel,
  herzieStage,
  islandScenery,
  itemVoxelMeshes,
  lootPillarMaterial,
} from "@herzies/shared/gl";
import { useEffect, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import {
  frameIslandCamera,
  ISLAND_COLS,
  ISLAND_GROUND,
  islandBox,
  islandSun,
} from "./island";

// The beat sheet, in ms from the start of a loop: the island stands empty,
// items pop up on it one by one (as the Town drops them: voxel cards in
// pillars of their rarity's light), then a stage 2 herzie runs across and
// picks them up. Then again, with other items.

/** The island empty, before the first item pops up. */
const EMPTY_MS = 1500;
/** Between one item popping up and the next. */
const POP_GAP_MS = 380;
/** An item's pop: up from nothing, overshooting a little. */
const POP_MS = 320;
/** After the last item, the herzie sets off. */
const RUN_AFTER_MS = 1800;
/** After it has gone, the next loop starts. */
const LOOP_GAP_MS = 1200;
/** Being picked up: it flies up out of the herzie's way, spinning faster
 * and fading out, this high over this long. */
const TAKE_MS = 480;
const TAKE_RISE = 1.2;
const TAKE_SPIN = 4;

/** Where the items lie, along the herzie's path (x), a little off it (z). */
const SPOTS = [
  { x: -1.7, z: 0.25 },
  { x: -0.55, z: -0.2 },
  { x: 0.6, z: 0.3 },
  { x: 1.75, z: -0.1 },
];
/** The herzie's run: from one edge of the island to the other, fading in
 * and out at the ends, at this speed (world units a second). */
const RUN_FROM = -2.5;
const RUN_TO = 2.5;
const RUN_SPEED = 3.2;
const RUN_FADE = 0.45;
/** It faces the way it runs (+x). */
const RUN_HEADING = Math.PI / 2;

/** An item's size and float (the Town's, scaled to the island). */
const ITEM_SCALE = 0.8;
const HOVER = 0.55;
const BOB = 0.05;
const SPIN_PER_SECOND = (Math.PI * 2) / 3;
/** The pillars by rarity (common..mythic): height and brightness. Lower
 * than the cave's, to stay inside the box, and brighter, to read small. */
const RARITY_TIER = {
  common: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
  mythic: 4,
} as const;
const PILLAR_HEIGHT = [1.2, 1.6, 2.2, 2.8, 3.2];
const PILLAR_GLOW = [0.45, 0.55, 0.7, 0.85, 0.95];

/** Everything that drops while you listen. */
const DROPPABLE = ITEMS.filter(
  (item) => !(NON_DROPPABLE_ITEM_IDS as readonly string[]).includes(item.id),
);

/** `count` different droppable items, at random. */
function pickItems(count: number): ItemDef[] {
  const pool = [...DROPPABLE];
  const out: ItemDef[] = [];
  while (out.length < count && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

function easeOutBack(t: number) {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u ** 3 + c * u ** 2;
}

type Drop = {
  group: THREE.Group;
  model: THREE.Group;
  pillar: THREE.Mesh;
  pillarMaterial: THREE.ShaderMaterial;
  /** The model's own materials, faded as it's picked up. */
  materials: THREE.Material[];
  tier: number;
  x: number;
  z: number;
  popAt: number;
  /** When the herzie got to it (ms into the loop). */
  takenAt: number | null;
  spin: number;
  dispose: () => void;
};

function makeDrop(item: ItemDef, i: number): Drop {
  const [plain, glow] = itemVoxelMeshes(item);
  const model = new THREE.Group();
  model.add(plain, glow);
  model.scale.setScalar(ITEM_SCALE);
  const materials = [plain.material, glow.material] as THREE.Material[];
  for (const m of materials) m.transparent = true;
  const pillarMaterial = lootPillarMaterial(
    new THREE.Color(RARITY_COLORS[item.rarity]),
  );
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.3, 1, 16, 1, true).translate(0, 0.5, 0),
    pillarMaterial,
  );
  const tier = RARITY_TIER[item.rarity];
  pillar.scale.y = PILLAR_HEIGHT[tier];
  const group = new THREE.Group();
  group.add(pillar, model);
  const spot = SPOTS[i];
  group.position.set(spot.x, 0, spot.z);
  return {
    group,
    model,
    pillar,
    pillarMaterial,
    materials,
    tier,
    x: spot.x,
    z: spot.z,
    popAt: EMPTY_MS + i * POP_GAP_MS,
    takenAt: null,
    spin: Math.random() * Math.PI * 2,
    dispose() {
      for (const m of [plain, glow]) {
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
      pillar.geometry.dispose();
      pillarMaterial.dispose();
    },
  };
}

/**
 * The empty island, then items popping up on it, then a stage 2 herzie
 * running across to pick them up, over and over. Drawn on the page's
 * shared herzie stage, framed like the other islands (see island.ts).
 * Starts over each time it comes on screen, and holds still off it.
 */
export function CollectScene({
  seed,
  size,
  active,
}: {
  seed: string;
  size: number;
  active: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { width, height } = islandBox(size);
  const live = useRef({ active, groundInset: height * ISLAND_GROUND });
  live.current.active = active;
  live.current.groundInset = height * ISLAND_GROUND;
  /** Set to start the loop over (coming back on screen). */
  const restart = useRef(false);
  useEffect(() => {
    if (active) restart.current = true;
  }, [active]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const scene = new THREE.Scene();
    scene.add(islandScenery());
    scene.add(islandSun());

    const herzie = new HerzieModel(
      { seed, stage: 2 },
      { layoutCols: ISLAND_COLS, layoutRows: SH, anchorScenery: 0 },
    );
    herzie.heading = RUN_HEADING;
    scene.add(herzie.root);

    const cam = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
    let drops: Drop[] = [];
    let clock = 0;
    let tint = -1;

    const startLoop = () => {
      for (const d of drops) {
        scene.remove(d.group);
        d.dispose();
      }
      drops = pickItems(SPOTS.length).map(makeDrop);
      for (const d of drops) scene.add(d.group);
      clock = 0;
    };
    startLoop();
    const runAt = drops[drops.length - 1].popAt + RUN_AFTER_MS;
    const runMs = ((RUN_TO - RUN_FROM) / RUN_SPEED) * 1000;
    const loopMs = runAt + runMs + LOOP_GAP_MS;

    const remove = herzieStage.add({
      element,
      scene,
      camera: cam,
      idle: () => !live.current.active,
      update(dt, w, h) {
        if (!live.current.active) return;
        if (restart.current) {
          restart.current = false;
          startLoop();
        }
        clock += dt * 1000;
        if (clock >= loopMs) startLoop();

        // The herzie: out of sight until it sets off, then running across.
        const running = clock >= runAt && clock < runAt + runMs;
        const x = running
          ? RUN_FROM + ((clock - runAt) / 1000) * RUN_SPEED
          : RUN_FROM;
        herzie.root.position.set(x, 0, 0);
        herzie.root.visible = running;
        const fade = running
          ? Math.min(1, (x - RUN_FROM) / RUN_FADE, (RUN_TO - x) / RUN_FADE)
          : 0;
        if (Math.abs(fade - tint) > 0.01) {
          herzie.setTint(0, fade);
          tint = fade;
        }
        herzie.heading = RUN_HEADING;
        herzie.update(dt, running ? RUN_SPEED : 0);

        for (const d of drops) {
          if (d.takenAt === null && running && x >= d.x - 0.1) {
            d.takenAt = clock;
          }
          const popT = (clock - d.popAt) / POP_MS;
          d.group.visible = popT > 0;
          if (popT <= 0) continue;
          d.spin += dt * SPIN_PER_SECOND;
          const pop = popT >= 1 ? 1 : Math.max(0, easeOutBack(popT));
          const bob = Math.sin((clock / 1000) * Math.PI * 1.6 + d.x) * BOB;
          d.model.rotation.y = d.spin;
          let glow = Math.min(1, popT) * PILLAR_GLOW[d.tier];
          if (d.takenAt === null) {
            d.model.position.set(0, HOVER * pop + bob, 0);
            d.model.scale.setScalar(ITEM_SCALE * pop);
          } else {
            // Flies up as the herzie passes, spinning, fading out.
            const t = Math.min(1, (clock - d.takenAt) / TAKE_MS);
            const rise = 1 - (1 - t) ** 3;
            d.spin += dt * TAKE_SPIN * (1 - t);
            d.model.position.set(0, HOVER + bob + rise * TAKE_RISE, 0);
            d.model.scale.setScalar(ITEM_SCALE * (1 - 0.3 * t));
            for (const m of d.materials) m.opacity = 1 - t * t;
            d.model.visible = t < 1;
            glow *= 1 - t;
          }
          d.pillar.visible = glow > 0.001;
          d.pillarMaterial.uniforms.uOpacity.value = glow;
        }

        frameIslandCamera(cam, w, h, live.current.groundInset);
      },
    });
    return () => {
      remove();
      for (const d of drops) d.dispose();
      herzie.dispose();
    };
  }, [seed]);

  return (
    <div
      ref={box}
      role="img"
      aria-label="Items popping up on an island, and a herzie running across to pick them up"
      style={{ width, height, flexShrink: 0, position: "relative", zIndex: 1 }}
    />
  );
}
