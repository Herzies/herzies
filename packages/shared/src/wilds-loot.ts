/**
 * What there is to get on the Wilds, besides a fight: its bits (crafting
 * materials found nowhere else), the instruments made from them, tuning an
 * instrument with them, the caches that listening there brings out, the
 * listening bonus for being there, and what a herzie drops when it's taken
 * down. Pure rules and numbers, shared by the Wilds room (which decides
 * who's near what), the database's edge functions (which grant and take)
 * and the app (which shows it all).
 *
 * Who may do what is always the server's call: the room judges reach and
 * who's first, `town-vitals` writes, the web API crafts and tunes. Nothing
 * here trusts a client.
 */

import { WILDS_SAFE_CAMP } from "./wilds.js";

// --- Bits ---------------------------------------------------------------------

/** The Wilds' crafting materials, commonest first: stackable cards that
 * drop only there (a cache, a herzie taken down, listening on the island),
 * spent on Wilds instruments and on tuning. */
export const WILDS_BITS = [
  "tonewood",
  "sky-string",
  "storm-hide",
  "resonite",
] as const;
export type WildsBit = (typeof WILDS_BITS)[number];

export function isWildsBit(id: string): id is WildsBit {
  return (WILDS_BITS as readonly string[]).includes(id);
}

/** How often each bit turns up when one's rolled, out of the total. */
export const WILDS_BIT_WEIGHTS: Record<WildsBit, number> = {
  tonewood: 60,
  "sky-string": 28,
  "storm-hide": 10,
  resonite: 2,
};

/** A bit, rolled by weight from `r` in [0, 1). */
export function rollBit(r: number): WildsBit {
  let total = 0;
  for (const b of WILDS_BITS) total += WILDS_BIT_WEIGHTS[b];
  let at = r * total;
  for (const b of WILDS_BITS) {
    at -= WILDS_BIT_WEIGHTS[b];
    if (at < 0) return b;
  }
  return WILDS_BITS[0];
}

/** Bits by how many: what a recipe or a tuning step costs. */
export type BitCost = Partial<Record<WildsBit, number>>;

// --- Instruments --------------------------------------------------------------

/** A Wilds instrument and what it's made from: the class instrument it's
 * built on (used up, its upgrade level carried over) and bits. */
export type WildsRecipe = {
  id: string;
  base: string;
  bits: BitCost;
};

/** The Wilds instruments, one for each class instrument. Each is a real
 * step up from the one it's made from (about half as strong again; see
 * items.ts). */
export const WILDS_RECIPES: readonly WildsRecipe[] = [
  {
    id: "wildwood-lute",
    base: "lute",
    bits: { tonewood: 12, "sky-string": 8, "storm-hide": 4 },
  },
  {
    id: "stormcut-discs",
    base: "compact-discs",
    bits: { tonewood: 10, "sky-string": 11, "storm-hide": 3 },
  },
  {
    id: "thunderhide-sticks",
    base: "worn-stick",
    bits: { tonewood: 16, "sky-string": 4, "storm-hide": 4 },
  },
  {
    id: "storm-cymbal",
    base: "old-cymbal",
    bits: { tonewood: 8, "sky-string": 8, "storm-hide": 4 },
  },
];

export function recipeFor(id: string): WildsRecipe | null {
  return WILDS_RECIPES.find((r) => r.id === id) ?? null;
}

/** Every instrument a class plays (the class's own and the Wilds' build of
 * it), main hand and off hand: what tuning takes. */
export const TUNABLE_INSTRUMENTS: readonly string[] = WILDS_RECIPES.flatMap(
  (r) => [r.base, r.id],
);

// --- Tuning -------------------------------------------------------------------

/** How far bits can take an instrument: past this, Power Dice as ever. */
export const TUNING_MAX_LEVEL = 6;

/** Bits to tune an instrument up from `level` (its current upgrade level)
 * to the next. Tuning never fails and never breaks the instrument. Null:
 * past what tuning does. */
export function tuningCost(level: number): BitCost | null {
  switch (level) {
    case 0:
      return { tonewood: 3 };
    case 1:
      return { tonewood: 5 };
    case 2:
      return { tonewood: 6, "sky-string": 2 };
    case 3:
      return { "sky-string": 4, "storm-hide": 1 };
    case 4:
      return { "sky-string": 5, "storm-hide": 2 };
    case 5:
      return { "storm-hide": 3, resonite: 1 };
    default:
      return null;
  }
}

/** Whether `have` (bits by id) covers `cost`. */
export function canAfford(
  have: Partial<Record<string, number>>,
  cost: BitCost,
): boolean {
  for (const [id, n] of Object.entries(cost))
    if ((have[id] ?? 0) < (n ?? 0)) return false;
  return true;
}

// --- Caches -------------------------------------------------------------------

/**
 * A cache isn't on a timer: listening brings it out. Every herzie on the
 * Wilds with music playing charges the room's Hunt Crystal (each shard has
 * its own); once it's full a cache turns up, and the crystal stays full
 * (the hunt is on) till someone opens it, then starts again from dull.
 * Alone it takes WILDS_HUNT_FILL_MS; more listening fills it quicker, by
 * the square root of how many (two: ~3½ min, four: 2½, nine: ~1⅔). It
 * keeps its charge while nobody's listening, and starts dull each event.
 */
export const WILDS_HUNT_FILL_MS = 5 * 60_000;

/** How fast the crystal fills with `listeners` playing music (charge a ms,
 * 1 being full). */
export function huntRate(listeners: number): number {
  return listeners > 0 ? Math.sqrt(listeners) / WILDS_HUNT_FILL_MS : 0;
}

/** The Hunt Crystal, as the room tells it: its charge (0 dull, 1 full) at
 * `at` (server ms), filling at `rate` a ms from then (0: nobody's
 * listening, or the hunt's on), and how many are listening. */
export type WildsHunt = {
  charge: number;
  rate: number;
  at: number;
  listeners: number;
};

/** The crystal's charge at `now` (same clock as `h.at`), counted on from
 * what the room said. */
export function huntCharge(h: WildsHunt, now: number): number {
  return Math.min(1, h.charge + h.rate * Math.max(0, now - h.at));
}

/**
 * A cache isn't opened, it's held: it opens for the first herzie to stay
 * on their feet within WILDS_CACHE_HOLD_RADIUS of it (world units) for
 * WILDS_CACHE_HOLD_MS, so whoever wants it has to stand there and defend
 * it. Leaving the ring or going down starts you over from nothing; while
 * two or more herzies are up in the ring it's contested, and nobody's
 * hold counts on (each keeps what they had) till only one is left. The
 * room judges it all from where it has everyone (see the room's
 * wilds-loot.ts); the app only draws it. Every cache spot is far enough
 * out of the safe camp (see outOfCamp) that the whole ring is fair game.
 */
export const WILDS_CACHE_HOLD_RADIUS = 5;
export const WILDS_CACHE_HOLD_MS = 10_000;

/** Where a cache can turn up: Wilds-map (x, z), on open ground, all out of
 * the safe camp (it's worth a walk, and a fight). Checked against the map
 * by the app's tests. */
export const WILDS_CACHE_SPOTS: readonly { x: number; z: number }[] = [
  { x: 0.5, z: 0.5 },
  { x: -41.5, z: -61.5 },
  { x: -5.5, z: 74.5 },
  { x: 74.5, z: -3.5 },
  { x: -63.5, z: 36.5 },
  { x: 26.5, z: -69.5 },
  { x: 52.5, z: 50.5 },
  { x: -47.5, z: -13.5 },
  { x: 38.5, z: -27.5 },
];

/** Where the `k`th cache of an event turns up (0 the first): a different
 * spot each time, in an order of the event's own. */
export function wildsCacheSpot(
  event: string,
  k: number,
): { x: number; z: number } {
  const n = WILDS_CACHE_SPOTS.length;
  const spot = WILDS_CACHE_SPOTS[(hash(event) + k * 7) % n];
  return { x: spot.x, z: spot.z };
}

/** A cache's id: one per event, shard and the moment it turned up (server
 * ms), what opening it once hangs on. */
export function wildsCacheId(event: string, at: number, shard: number): string {
  return `${event}:${at}:${shard}`;
}

/** What's in a cache: a handful of bits, and now and then a Power Die or a
 * Safety Pick (for the rolls tuning doesn't reach). `rand` gives [0, 1). */
export function rollCacheLoot(rand: () => number): string[] {
  const out: string[] = [];
  const n = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) out.push(rollBit(rand()));
  const r = rand();
  if (r < 0.02) out.push("safety-pick");
  else if (r < 0.1) out.push("power-dice-1");
  return out;
}

// --- Taken down ---------------------------------------------------------------

/** A herzie taken down on the Wilds drops one random card from its bag
 * (not worn, not held by a loadout; from a stack, just one) where it fell.
 * Whoever took it down has it to themselves for `killerFirstMs`; then
 * anyone within `reach` may take it; after `lifeMs` unclaimed, it goes
 * back to its owner. */
export const WILDS_DROP = {
  killerFirstMs: 15_000,
  lifeMs: 120_000,
  reach: 1.8,
} as const;

/** A card lying on the Wilds for anyone to take, as the room tells it.
 * Times are server ms. */
export type WildsGroundDrop = {
  id: string;
  item: string;
  /** Its upgrade level (it keeps it, whoever takes it). */
  level: number;
  x: number;
  z: number;
  /** Until then only entity `firstFor` (who took its owner down) may take
   * it. Null: anyone. */
  firstFor: number | null;
  firstUntil: number;
  /** When it goes back to its owner. */
  expiresAt: number;
};

/** A cache out on the Wilds, as the room tells it. */
export type WildsCacheView = { id: string; x: number; z: number };

/** Who's holding the cache that's out, as the room tells it (on each
 * change: someone stepping into or out of the ring, going down, it being
 * contested or no longer). `holders`: each herzie up in the ring (entity
 * id) and how much of WILDS_CACHE_HOLD_MS they had at `at` (server ms).
 * Uncontested, the one holder's goes on counting from there; contested,
 * everyone's stands still. */
export type WildsCacheHold = {
  holders: { id: number; ms: number }[];
  contested: boolean;
  at: number;
};

/** Why the room wouldn't let you take a drop or open a cache. */
export type WildsLootRefusal = "far" | "not-yet" | "gone" | "bag-full" | "down";

// --- Listening ----------------------------------------------------------------

/** Listening XP on the Wilds, on top of everything else: +50%. */
export const WILDS_LISTEN_BONUS = 0.5;
/** The multiplier's name, as the app lists it. */
export const WILDS_LISTEN_LABEL = "The Wilds";
/** How long one word from the room that you're there counts for (ms): the
 * room says so every half minute, so a little over two of those. */
export const WILDS_PRESENCE_MS = 75_000;
/** Of the listening drops rolled while you're on the Wilds, this share are
 * a bit instead. */
export const WILDS_LISTEN_BIT_SHARE = 0.5;

// --- Helpers ------------------------------------------------------------------

/** FNV-1a over a string: a stable small number from an id. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Whether a cache spot is fair game: out of the safe camp. */
export function outOfCamp(x: number, z: number): boolean {
  return (
    Math.hypot(x - WILDS_SAFE_CAMP.x, z - WILDS_SAFE_CAMP.z) >
    WILDS_SAFE_CAMP.r + 8
  );
}
