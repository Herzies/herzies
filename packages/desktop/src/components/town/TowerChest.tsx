import { TOWER_CHEST } from "@herzies/shared/tower";
import { TOWN_MAPS } from "@herzies/shared/town-net";
import { useFrame } from "@react-three/fiber";
import { useEffect, useReducer, useRef } from "react";
import { bossFight, useBossFight } from "./combat/fight";
import { LootChest } from "./LootChest";
import { groundY, type TownMap } from "./map";
import { townSave } from "./runtime";
import { sfxLootBurst } from "./sfx";

/**
 * The Warden's chest in the Tower's hall (see TOWER_CHEST): it stands on
 * the compass while the room says a cleared floor has one (the floor's
 * `chest`), the Wilds' cache chest under a lower beam (the vault's over
 * it), its front to the way in. Its lid lifts a little as you come close;
 * walk onto the star and the room opens it: the lid flings back, the beam
 * goes out, and the loot follows from it as ordinary loot (LootDrops) once
 * `town-vitals` has rolled it. Going on with it still shut opens it too
 * (the room's doing; you're on the next floor by then).
 *
 * Mounted in the Tower only, in the island's frame.
 */

/** The beam's height: up into the vault's dark, short of its crown. */
const BEAM = 18;
/** How long an opened chest stays, lid flung back and beam going out. */
const OPEN_MS = 1_400;
/** The lid starts to lift from this far off, and is half up at the edge
 * of TOWER_CHEST.reach. */
const NOTICE = 5;
/** How far the lid flings back on opening (in LootChest's `lift`). */
const FLUNG = 2.2;

type Shown = {
  floor: number;
  x: number;
  z: number;
  /** When it appeared, and when it opened (performance.now() ms). */
  born: number;
  openedAt: number | null;
};

export function TowerChest({ map }: { map: TownMap }) {
  useBossFight();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const shown = useRef<Shown | null>(null);
  const tower = bossFight.tower;
  const chest = tower?.chest;
  const now = performance.now();
  let s = shown.current;
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
      };
  } else if (s && (s.floor !== tower?.floor || !tower)) {
    // Gone with its floor (opened on the way on): nothing to watch.
    s = null;
  } else if (s && s.openedAt === null) {
    s = { ...s, openedAt: now };
  }
  shown.current = s;
  const openedAt = s?.openedAt ?? null;
  useEffect(() => {
    if (openedAt === null) return;
    sfxLootBurst();
    const id = setTimeout(() => {
      if (shown.current?.openedAt === openedAt) shown.current = null;
      redraw();
    }, OPEN_MS);
    return () => clearTimeout(id);
  }, [openedAt]);
  const lift = useRef(0);
  const glow = useRef(1);
  useFrame(() => {
    const c = shown.current;
    if (!c) return;
    if (c.openedAt !== null) {
      const k = Math.min(1, (performance.now() - c.openedAt) / OPEN_MS);
      lift.current = FLUNG * (1 - (1 - Math.min(1, k * 4)) ** 3);
      glow.current = 1 - k;
      return;
    }
    const d = Math.hypot(townSave.x - c.x, townSave.z - c.z);
    lift.current = Math.max(
      0,
      Math.min(1, (NOTICE - d) / (NOTICE - TOWER_CHEST.reach) / 2),
    );
    glow.current = 1;
  });
  if (!s) return null;
  const spawn = TOWN_MAPS.tower.spawn;
  return (
    <LootChest
      key={`${s.floor}:${s.born}`}
      x={s.x}
      z={s.z}
      ground={groundY(map, s.x, s.z)}
      yaw={Math.atan2(spawn.x - s.x, spawn.z - s.z)}
      born={s.born}
      lift={lift}
      glow={glow}
      beam={BEAM}
    />
  );
}
