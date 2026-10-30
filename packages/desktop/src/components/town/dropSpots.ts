import type { PendingDrop } from "@herzies/shared";

/**
 * What drops while you listen, on the ground around you: the pure part (no
 * scene, no React), so where things land is tested on its own. The scene's
 * side is HomeDrops (HomeDrops.tsx).
 *
 * The server keeps only what dropped, never where: each drop's spot is
 * picked here the first time it's seen, and remembered on this machine, so
 * it's still lying where it fell next time — until it's picked up (by
 * walking over it, or a spirit fetching it).
 */

export type Vec2 = { x: number; z: number };

/** Where a drop lies: on which island, and where on it. */
export type DropSpot = { map: string; x: number; z: number };

/** Every number in one place, so the feel can be tuned without hunting. */
export const HOME_DROPS = {
  /** How far from the herzie drops land: past where walking up pulls them
   * in (LOOT.magnetRadius, 1.7) with room to spare, so they're there to be
   * walked to (or fetched), never picked up by standing still. */
  near: 2.3,
  far: 4.2,
  /** The most they ever land out, when it's crowded round you (Home's
   * picture is narrow: further back is where there's room). */
  widest: 9,
  /** How far apart they keep. */
  spacing: 1.3,
  /** Never right behind the herzie (it would hide them): at least this far
   * (radians) to one side of straight on from the camera... */
  minAside: 0.38,
  /** ...and at most this far, so they stay in the picture. */
  maxAside: 1.3,
  /** A drop further than this from you (or on another island), when you
   * go Home, is brought to you again (see the HomeDrops summons). */
  homeReach: 7,
  /** Between one drop arriving and the next, when several come at once. */
  staggerMs: 260,
} as const;

/**
 * Where the next drop lands: round the herzie at `player`, on the far side
 * from the camera (`away`: the azimuth pointing from the camera past the
 * herzie, camera-controls' convention), so it's seen beyond it — off to one
 * side, never hidden right behind it. At least HOME_DROPS.spacing from the
 * ones already down (`taken`), on ground `ok` says can hold one. Null if
 * there's nowhere (then it waits, and tries again).
 */
export function placeDrop(opts: {
  player: Vec2;
  away: number;
  taken: readonly Vec2[];
  ok: (x: number, z: number) => boolean;
  random?: () => number;
}): Vec2 | null {
  const { player, away, taken, ok } = opts;
  const random = opts.random ?? Math.random;
  const clear = (x: number, z: number, spacing: number) =>
    taken.every((t) => Math.hypot(t.x - x, t.z - z) >= spacing);
  // Out from the closest ring, then wider and further when that's full;
  // the last pass only asks for somewhere it can stand.
  const passes = [
    {
      near: HOME_DROPS.near,
      far: HOME_DROPS.far,
      aside: HOME_DROPS.maxAside,
      spacing: HOME_DROPS.spacing,
    },
    {
      near: HOME_DROPS.near,
      far: HOME_DROPS.widest,
      aside: HOME_DROPS.maxAside + 0.4,
      spacing: HOME_DROPS.spacing,
    },
    {
      near: HOME_DROPS.near,
      far: HOME_DROPS.widest,
      aside: Math.PI,
      spacing: HOME_DROPS.spacing * 0.75,
    },
  ];
  for (const pass of passes) {
    for (let i = 0; i < 64; i++) {
      const side = random() < 0.5 ? -1 : 1;
      const aside =
        HOME_DROPS.minAside +
        random() * Math.max(0, pass.aside - HOME_DROPS.minAside);
      const angle = away + side * aside;
      const r = pass.near + random() * (pass.far - pass.near);
      const x = player.x + Math.sin(angle) * r;
      const z = player.z + Math.cos(angle) * r;
      if (clear(x, z, pass.spacing) && ok(x, z)) return { x, z };
    }
  }
  return null;
}

/** Whether a drop at `spot` is in Home's picture of a herzie at `player`
 * seen looking `away`: near enough, and not out past the sides. */
export function seenAtHome(spot: Vec2, player: Vec2, away: number): boolean {
  const dx = spot.x - player.x;
  const dz = spot.z - player.z;
  const d = Math.hypot(dx, dz);
  if (d > HOME_DROPS.homeReach || d < 1) return false;
  let off = Math.atan2(dx, dz) - away;
  off = Math.atan2(Math.sin(off), Math.cos(off));
  return Math.abs(off) <= HOME_DROPS.maxAside + 0.5;
}

// --- What's on the ground, from the app --------------------------------------

/** The drops on the ground as the app last heard (its state's
 * `pendingDrops`), handed in from outside the 3D world. */
export const homeDropFeed = {
  drops: [] as readonly PendingDrop[],
  /** Bumped whenever they change. */
  version: 0,
  set(drops: readonly PendingDrop[]): void {
    const same =
      drops.length === this.drops.length &&
      drops.every((d, i) => d.id === this.drops[i]?.id);
    if (same) return;
    this.drops = drops;
    this.version += 1;
  },
};

// --- Where they lie, remembered ----------------------------------------------

const SPOTS_KEY = "town.homeDrops.spots.v1";

/** Where each drop lies, by drop id, as last saved on this machine. */
export function loadSpots(): Map<string, DropSpot> {
  try {
    const raw = localStorage.getItem(SPOTS_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, DropSpot>;
    const out = new Map<string, DropSpot>();
    for (const [id, s] of Object.entries(parsed)) {
      if (
        s &&
        typeof s.map === "string" &&
        Number.isFinite(s.x) &&
        Number.isFinite(s.z)
      )
        out.set(id, { map: s.map, x: s.x, z: s.z });
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Saves them. */
export function saveSpots(spots: Map<string, DropSpot>): void {
  try {
    localStorage.setItem(SPOTS_KEY, JSON.stringify(Object.fromEntries(spots)));
  } catch {
    // Private mode, or full: they'll be placed afresh next time.
  }
}
