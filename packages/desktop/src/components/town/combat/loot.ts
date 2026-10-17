import {
  getItem,
  getItemIcon,
  hasCardFrame,
  type ItemDef,
  RARITY_COLORS,
  type Rarity,
} from "@herzies/shared";
import { BOSS_STAND } from "@herzies/shared/combat";
import type { LootTier } from "../sfx";

/**
 * The boss's loot, as the cave shows it: the pure part (no three.js scene,
 * no React), so the timing and the shapes are tested on their own. The
 * beat sheet, from the killing blow:
 *
 *  1. The kill lands first (the boss turns to stone; nothing drops yet).
 *  2. The stone bursts, and the loot fountains out of it, one piece after
 *     another, in high arcs toward you.
 *  3. Each lands with a squash, two bounces and a clink, then hovers,
 *     turning, in a pillar of its rarity's light.
 *  4. Walk close and it's pulled to you; or your spirit spots it, fetches
 *     it and brings it back. The payoff (chime, card) comes when it reaches
 *     you.
 *
 * The rewards are already in the bank when this starts (the server paid
 * out on the kill): all of this is the show, and leaving early loses
 * nothing.
 */

/** Every knob in one place, so the feel can be tuned without hunting. */
export const LOOT = {
  /** The stone bursts once the room says what dropped, but never sooner
   * than this after the killing blow (the kill gets its own beat), and
   * this long after it at the latest (nothing dropped for you: the boss
   * still cracks). The room only knows once the server has paid out. */
  burstAfterMs: 500,
  burstFallbackMs: 3_000,
  /** After the burst, the loot comes out of it. */
  ejectAfterMs: 220,
  /** Between one piece and the next coming out. */
  staggerMs: 140,
  /** Time in the air, and how far above the boss's chest the arc peaks. */
  flightMs: 820,
  apex: 2.6,
  /** How far in front of the boss pieces land, and how far apart. */
  landNear: 3.2,
  landFar: 4.4,
  spacing: 1.6,
  /** Two decaying hops after landing: [height, ms]. */
  bounces: [
    [0.38, 300],
    [0.12, 170],
  ] as const,
  /** Squash on each impact: how flat, for how long. */
  squash: 0.28,
  squashMs: 110,
  /** Resting: how high it floats, its bob, and its turn. */
  hover: 0.55,
  riseMs: 350,
  bob: 0.08,
  bobHz: 0.8,
  spinPerSecond: (Math.PI * 2) / 3,
  /** The voxel model's size: world units per pixel of a 24px icon. */
  voxel: 0.045,
  /** Walk within this and it's pulled to you, taking this long. */
  magnetRadius: 1.7,
  magnetMs: 260,
  /** The spirit spots loot that has rested this long, within this far:
   * the whole lair (bosses are fought from range, and only you see your
   * loot, so nobody's is being taken). */
  spiritDelayMs: 800,
  spiritRadius: 40,
  /** At the loot, it hovers this long before taking it in. */
  spiritHoverMs: 250,
  /** Taken in (spiralling into the spirit), and brought back within this
   * far of you. */
  spiritAbsorbMs: 320,
  deliverRadius: 1.8,
  /** The name shows within this far. */
  labelRadius: 8,
  /** Pillars by tier (common..mythic): height and brightness. */
  pillarHeight: [1.6, 2.6, 4.5, 7, 9],
  pillarGlow: [0.25, 0.35, 0.55, 0.75, 0.9],
} as const;

/** Rarity as a number: how grand the drop looks and sounds. */
export function tierOf(rarity: Rarity): LootTier {
  return (
    { common: 0, uncommon: 1, rare: 2, legendary: 3, mythic: 4 } as const
  )[rarity];
}

// --- The voxel model --------------------------------------------------------

export type Voxel = {
  /** Grid position: x right, y up (from the bottom row), z out of the card. */
  x: number;
  y: number;
  z: number;
  color: string;
  /** Glows a little (the rarity frame). */
  glow: boolean;
};

/**
 * The item's 24px icon as voxels, two deep. A card icon (most items) keeps
 * its card shape: the frame is painted in the rarity's colour and glows,
 * and the picture stands a voxel proud of the card's face, so it reads in
 * the round. Anything else (dice, the Safety Pick) is simply extruded.
 */
export function voxelsOf(item: ItemDef): Voxel[] {
  const { grid, palette } = getItemIcon(item);
  const card = hasCardFrame(grid);
  const h = grid.length;
  const frameColor = RARITY_COLORS[item.rarity];
  // The card's face colour: the commonest one inside the frame.
  let face: string | null = null;
  if (card) {
    const counts = new Map<string, number>();
    for (let y = 2; y < 22; y++)
      for (let x = 5; x < 19; x++) {
        const c = grid[y][x];
        if (c !== ".") counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    face = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  const colorOf = (c: string) => {
    if (c === "#" || !palette) return "#d8d8e0";
    const i = Number.parseInt(c, 36);
    return palette[i] ?? "#d8d8e0";
  };
  const out: Voxel[] = [];
  for (let gy = 0; gy < h; gy++) {
    const row = grid[gy];
    for (let gx = 0; gx < row.length; gx++) {
      const c = row[gx];
      if (c === ".") continue;
      const y = h - 1 - gy;
      const frame = card && (gx === 4 || gx === 19 || gy === 1 || gy === 22);
      const color = frame ? frameColor : colorOf(c);
      // Card back and face, and the picture on the face one proud of it.
      out.push({ x: gx, y, z: 0, color, glow: frame });
      out.push({ x: gx, y, z: 1, color, glow: frame });
      if (card && !frame && c !== face)
        out.push({ x: gx, y, z: 2, color, glow: false });
      if (frame) out.push({ x: gx, y, z: 2, color, glow: true });
    }
  }
  return out;
}

// --- Where it goes ----------------------------------------------------------

export type Vec2 = { x: number; z: number };

/**
 * Where `count` pieces land: fanned out in front of the boss, toward the
 * player so they come to you, at least LOOT.spacing apart. A handful make
 * one arc; a boss's full haul (a dozen) makes two staggered rows on a
 * wider fan, every other piece in the back row.
 */
export function landingSpots(
  count: number,
  player: Vec2,
  random: () => number = Math.random,
): Vec2[] {
  const toward = Math.atan2(player.x - BOSS_STAND.x, player.z - BOSS_STAND.z);
  const spots: Vec2[] = [];
  const spread =
    count > 1 ? Math.min(1.45, 0.55 + 0.09 * Math.max(0, count - 3)) : 0;
  const rows = count > 5 ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) - 0.5 : 0;
    const angle = toward + t * 2 * spread + (random() - 0.5) * 0.15;
    const back = rows === 2 && i % 2 === 1 ? LOOT.spacing : 0;
    const r = LOOT.landNear + back + random() * (LOOT.landFar - LOOT.landNear);
    spots.push({
      x: BOSS_STAND.x + Math.sin(angle) * r,
      z: BOSS_STAND.z + Math.cos(angle) * r,
    });
  }
  // Pull apart any two that landed too close (a spread of one leaves none).
  for (let pass = 0; pass < 4; pass++)
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) {
        const dx = spots[j].x - spots[i].x;
        const dz = spots[j].z - spots[i].z;
        const d = Math.hypot(dx, dz) || 1e-3;
        if (d >= LOOT.spacing) continue;
        const push = (LOOT.spacing - d) / 2;
        spots[i].x -= (dx / d) * push;
        spots[i].z -= (dz / d) * push;
        spots[j].x += (dx / d) * push;
        spots[j].z += (dz / d) * push;
      }
  return spots;
}

/** Where the boss's loot comes out: its chest. */
export const BOSS_ORIGIN = {
  x: BOSS_STAND.x,
  y: BOSS_STAND.chest,
  z: BOSS_STAND.z,
} as const;

/** Where a piece is `ms` into its flight from `from` (the boss's chest,
 * unless it's tossed from somewhere else) to `to`, peaking `apex` above
 * where it started. y is height above the floor. */
export function flightAt(
  to: Vec2,
  ms: number,
  from: { x: number; y: number; z: number } = BOSS_ORIGIN,
  apex: number = LOOT.apex,
): { x: number; y: number; z: number } {
  const t = Math.min(1, Math.max(0, ms / LOOT.flightMs));
  const y0 = from.y;
  const peak = y0 + apex;
  // A parabola through the start, the peak (at 40%: up fast, a long fall)
  // and the floor.
  const k = 0.4;
  const y =
    t < k
      ? y0 + (peak - y0) * (1 - ((k - t) / k) ** 2)
      : peak * (1 - ((t - k) / (1 - k)) ** 2);
  return {
    x: from.x + (to.x - from.x) * t,
    y,
    z: from.z + (to.z - from.z) * t,
  };
}

/**
 * After landing: its height and squash `ms` after touching down. The
 * bounces, then the rise to its hover, then a bob for good. `squash` is how
 * flat it is (0 none), right after each impact.
 */
export function restAt(ms: number): { y: number; squash: number } {
  let t = ms;
  let squash = impactSquash(t, 1);
  for (const [height, dur] of LOOT.bounces) {
    if (t < dur) {
      const u = t / dur;
      return { y: height * 4 * u * (1 - u), squash };
    }
    t -= dur;
    squash = Math.max(squash, impactSquash(t, height / LOOT.bounces[0][0]));
  }
  const rise = Math.min(1, t / LOOT.riseMs);
  const eased = 1 - (1 - rise) ** 3;
  const bob =
    Math.sin((t / 1000) * LOOT.bobHz * Math.PI * 2) * LOOT.bob * eased;
  return { y: LOOT.hover * eased + bob, squash };
}

/** How long the bounces take, landing to resting in the air. */
export const SETTLE_MS =
  LOOT.bounces.reduce((sum, [, ms]) => sum + ms, 0) + LOOT.riseMs;

function impactSquash(sinceImpact: number, strength: number): number {
  if (sinceImpact < 0 || sinceImpact > LOOT.squashMs) return 0;
  return LOOT.squash * strength * (1 - sinceImpact / LOOT.squashMs);
}

/** The item behind an id, if this build knows it. */
export function lootItem(id: string): ItemDef | null {
  return getItem(id) ?? null;
}
