import { mulberry32 } from "@herzies/shared";
import { TOWER_CHEST } from "@herzies/shared/tower";
import { TOWN_MAPS } from "@herzies/shared/town-net";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useReducer, useRef } from "react";
import * as THREE from "three";
import { bossFight, useBossFight } from "./combat/fight";
import { LootChest } from "./LootChest";
import { groundY, type TownMap } from "./map";
import { townNet } from "./net/townNet";
import { townSave } from "./runtime";
import { sfxLootBurst } from "./sfx";

/**
 * The Warden's chest in the Tower's hall (see TOWER_CHEST): it stands on
 * the compass while the room says a cleared floor has one (the floor's
 * `chest`), the Wilds' cache chest under a lower beam (the vault's over
 * it), its front to the way in. It lands shut. Once it's settled, stand by
 * it and E asks the room to open it (TownCanvas's prompt: chestInReach,
 * openChest); its lid rattles a crack while it's yours to open. The room
 * answers with the floor without its chest: the lid flings back, light
 * bursts out of it in a flash and a spray of sparks, the beam flares and
 * goes out, and the chest fades away; the loot follows from it as ordinary
 * loot (LootDrops). Going on with it still shut opens it too (the room's
 * doing): you're on the next floor by then, and it's simply gone.
 *
 * Mounted in the Tower only, in the island's frame.
 */

/** The beam's height: up into the vault's dark, short of its crown. */
const BEAM = 18;
/** How long it fades away once it's open. */
const FADE_MS = 500;
/** How far the lid flings back on opening (in LootChest's `lift`). */
const FLUNG = 3;
/** The beam over a shut chest: there, but holding something back. */
const SHUT_GLOW = 0.45;
/** E pressed again this soon after asking is the same ask. */
const ASK_AGAIN_MS = 1_000;
/** The chest's mouth, over the ground: where the light bursts out. */
const MOUTH = 0.65;
/** The sparks: how many, and how they fall (units/s²). */
const SPARKS = 32;
const SPARK_FALL = 9;

type Shown = {
  floor: number;
  x: number;
  z: number;
  /** When it appeared, when it opened, and when E last asked the room to
   * open it (performance.now() ms). */
  born: number;
  openedAt: number | null;
  askedAt: number;
};

/** The chest as drawn: kept here rather than in the component so the E
 * prompt (TownCanvas) can ask about it. */
let shown: Shown | null = null;

/** The chest the room still has (shut, on this floor), if it's drawn. */
function standing(): Shown | null {
  const s = shown;
  const chest = bossFight.tower?.chest;
  if (!s || s.openedAt !== null || !chest) return null;
  if (s.floor !== bossFight.tower?.floor || s.x !== chest.x || s.z !== chest.z)
    return null;
  return s;
}

/** Whether E would open the chest from (x, z): it's shut, has settled
 * (the room refuses it sooner) and is within reach. */
export function chestInReach(x: number, z: number, now: number): boolean {
  const s = standing();
  return (
    !!s &&
    now - s.born >= TOWER_CHEST.settleMs &&
    Math.hypot(x - s.x, z - s.z) <= TOWER_CHEST.reach
  );
}

/** E by the chest: ask the room to open it (once, until it answers or a
 * moment's passed). The answer is the floor without it. */
export function openChest(now: number): void {
  const s = standing();
  if (!s || now - s.askedAt < ASK_AGAIN_MS) return;
  if (townNet().sendChestOpen()) s.askedAt = now;
}

/** Where each spark flies off to (units/s), the same every time: up and
 * out of the chest's mouth in a fountain. */
const SPARK_VELOCITY = (() => {
  const rand = mulberry32(0x7c4e57);
  const v = new Float32Array(SPARKS * 3);
  for (let i = 0; i < SPARKS; i++) {
    const a = rand() * Math.PI * 2;
    const out = 0.8 + rand() * 2.2;
    v[i * 3] = Math.cos(a) * out;
    v[i * 3 + 1] = 3.5 + rand() * 4;
    v[i * 3 + 2] = Math.sin(a) * out;
  }
  return v;
})();

export function TowerChest({ map }: { map: TownMap }) {
  useBossFight();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const tower = bossFight.tower;
  const chest = tower?.chest;
  const now = performance.now();
  let s = shown;
  if (tower && chest) {
    if (
      !s ||
      s.openedAt !== null ||
      s.floor !== tower.floor ||
      s.x !== chest.x ||
      s.z !== chest.z
    )
      s = {
        floor: tower.floor,
        x: chest.x,
        z: chest.z,
        born: now,
        openedAt: null,
        askedAt: Number.NEGATIVE_INFINITY,
      };
  } else if (s && (s.floor !== tower?.floor || !tower)) {
    // Gone with its floor (opened on the way on): nothing to watch.
    s = null;
  } else if (s && s.openedAt === null) {
    // Gone from the floor it stood on: the room opened it.
    s = { ...s, openedAt: now };
  }
  shown = s;
  const openedAt = s?.openedAt ?? null;
  useEffect(() => {
    if (openedAt === null) return;
    sfxLootBurst();
    const id = setTimeout(() => {
      if (shown?.openedAt === openedAt) shown = null;
      redraw();
    }, TOWER_CHEST.openMs + FADE_MS);
    return () => clearTimeout(id);
  }, [openedAt]);

  // The burst: a flash of light swelling out of the chest's mouth, and
  // sparks thrown up out of it. Made with the chest and kept hidden until
  // it opens, so opening it makes nothing.
  const burst = useMemo(() => {
    const sparks = new THREE.BufferGeometry();
    const at = new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3);
    at.setUsage(THREE.DynamicDrawUsage);
    sparks.setAttribute("position", at);
    return {
      sparks,
      at,
      spark: new THREE.PointsMaterial({
        color: "#ffe08a",
        size: 0.16,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
      ball: new THREE.IcosahedronGeometry(1, 1),
      flash: new THREE.MeshBasicMaterial({
        color: "#fff1b8",
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    };
  }, []);
  useEffect(
    () => () => {
      burst.sparks.dispose();
      burst.spark.dispose();
      burst.ball.dispose();
      burst.flash.dispose();
    },
    [burst],
  );

  const lift = useRef(0);
  const shut = useRef(1);
  const glow = useRef(SHUT_GLOW);
  const fade = useRef(1);
  const points = useRef<THREE.Points>(null);
  const flash = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const c = shown;
    if (!c) return;
    const t = performance.now();
    const sparks = points.current;
    const ball = flash.current;
    if (c.openedAt === null) {
      // Shut; rattling a crack open while E would open it.
      lift.current = chestInReach(townSave.x, townSave.z, t)
        ? 0.1 + 0.08 * Math.abs(Math.sin(t / 70))
        : 0;
      glow.current = SHUT_GLOW;
      fade.current = 1;
      if (sparks) sparks.visible = false;
      if (ball) ball.visible = false;
      return;
    }
    const ms = t - c.openedAt;
    const k = Math.min(1, ms / TOWER_CHEST.openMs);
    // The lid flings back in the first 40%, overshooting a little.
    const swing = Math.min(1, k / 0.4);
    const c1 = 1.70158;
    lift.current =
      FLUNG * (1 + (c1 + 1) * (swing - 1) ** 3 + c1 * (swing - 1) ** 2);
    // The beam flares as it opens, then goes out.
    glow.current =
      k < 0.15
        ? SHUT_GLOW + (2 - SHUT_GLOW) * (k / 0.15)
        : 2 * (1 - (k - 0.15) / 0.85);
    fade.current =
      1 - Math.min(1, Math.max(0, ms - TOWER_CHEST.openMs) / FADE_MS);
    if (ball) {
      const f = Math.min(1, k / 0.35);
      ball.visible = f < 1;
      ball.scale.setScalar(0.3 + 2.1 * (1 - (1 - f) ** 2));
      burst.flash.opacity = 0.85 * (1 - f) ** 2;
    }
    if (sparks) {
      sparks.visible = k < 1;
      const sec = ms / 1000;
      const p = burst.at.array as Float32Array;
      for (let i = 0; i < SPARKS * 3; i += 3) {
        p[i] = SPARK_VELOCITY[i] * sec;
        p[i + 1] =
          MOUTH + SPARK_VELOCITY[i + 1] * sec - 0.5 * SPARK_FALL * sec * sec;
        p[i + 2] = SPARK_VELOCITY[i + 2] * sec;
      }
      burst.at.needsUpdate = true;
      burst.spark.opacity = 1 - k * k;
    }
  });
  if (!s) return null;
  const spawn = TOWN_MAPS.tower.spawn;
  const ground = groundY(map, s.x, s.z);
  return (
    <group key={`${s.floor}:${s.born}`}>
      <LootChest
        x={s.x}
        z={s.z}
        ground={ground}
        yaw={Math.atan2(spawn.x - s.x, spawn.z - s.z)}
        born={s.born}
        lift={lift}
        shut={shut}
        glow={glow}
        fade={fade}
        beam={BEAM}
      />
      <group position={[s.x, ground, s.z]}>
        <mesh
          ref={flash}
          geometry={burst.ball}
          material={burst.flash}
          position={[0, MOUTH, 0]}
          visible={false}
        />
        <points
          ref={points}
          geometry={burst.sparks}
          material={burst.spark}
          frustumCulled={false}
          visible={false}
        />
      </group>
    </group>
  );
}
