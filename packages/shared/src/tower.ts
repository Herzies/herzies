/**
 * The Tower: an event island fought floor by floor, alone. Every balance
 * number for it lives here, shared by the Town server (which runs the mobs
 * and judges every hit), the desktop (which draws them) and `town-vitals`
 * (which pays out kills).
 *
 * How it scales, after the usual practice for endless floors: each floor's
 * mobs grow by a fixed share over the last (clamped, so a long climb never
 * reaches silly numbers), and a mob's level — its floor — set against the
 * herzie's makes it take less from you and deal you more the further it's
 * above you (the MMO level-gap rule), and the other way round below.
 *
 * How it stays a fight, after action-game practice:
 * - Mixed mobs (MOB_KINDS): brutes that keep up with a walk, lungers that
 *   close a gap in one dash, and spitters that hang back and lob at where
 *   you're *going* — so neither standing still nor kiting is safe.
 * - Attack tokens (attackTokens): only so many mobs swing at once, the rest
 *   circle you waiting their turn (Doom 2016's push-forward combat). Steady
 *   pressure, never an unfair pile-on.
 * - Shorter tells the higher you go (windupScale), never below a floor a
 *   human can react to.
 * - A par time per floor (floorParMs): past it the mobs enrage, faster and
 *   quicker to swing, so waiting it out never works.
 * - Every 5th floor an elite (ELITE), every 10th a Warden (WARDEN), who
 *   leaves a chest behind (TOWER_CHEST).
 *
 * Kills pay a little XP (kept behind what the same time listening brings)
 * and now and then an item, picked as listening picks one (leaning a little
 * rarer the higher the floor: towerLootLean), under a daily cap. The
 * Warden's chest pays a few items more, leaning rarer still.
 */

import type { Rarity } from "./items.js";

/** A mob's body, in world units from the ground: an upright capsule a wave
 * is judged against, like a training dummy's. (Elites and the Warden are
 * drawn and judged bigger: see ELITE.scale, WARDEN.scale.) */
export const MOB = {
  radius: 0.55,
  chest: 0.8,
  top: 1.45,
  /** A brute's walk (MOB_KINDS has each kind's). */
  speed: 4.0,
  /** Starts its swing once you're this close (centre to centre). */
  reach: 1.9,
  /** Mobs keep this far apart from each other. */
  spacing: 1.3,
} as const;

/** Walking into a mob hurts: `hp` of your max health (before Def and
 * buffs) once bodies overlap past `overlap` of their two radii summed, and
 * again every `everyMs` while they do, from each mob. Mobs stop well short
 * of you, so only walking into one does it. */
export const CONTACT = { hp: 0.04, everyMs: 400, overlap: 0.85 } as const;

/** The kinds of mob. On the wire as `k` (a brute when missing). */
export type MobKind = "brute" | "spitter" | "lunger";

/**
 * Each kind: how fast it walks, how its attack is shaped and timed, and its
 * health and hit next to the floor's (towerMob). Times are floor 1's; they
 * shrink with windupScale.
 *
 * - brute: walks almost as fast as you (4.5; sprinting is 6), so you can't
 *   just stroll away. A circle in front of it.
 * - lunger: from up to `lunge` away it crouches, a lane of circles marks
 *   its path to you, and it dashes through. Up close it bites like a brute.
 * - spitter: keeps `keep` away (backing off if you close in) and lobs a
 *   circle at where you'll be when it lands if you keep on as you are.
 */
export const MOB_KINDS = {
  brute: {
    speed: 4.0,
    windupMs: 750,
    recoverMs: 750,
    radius: 1.7,
    ahead: 0.9,
    hp: 1,
    damage: 1,
  },
  lunger: {
    speed: 4.3,
    windupMs: 700,
    recoverMs: 1_000,
    /** The lane's circles. */
    radius: 1.15,
    ahead: 0.7,
    /** Lunges at you from this far or nearer (else walks closer). */
    lunge: 5.5,
    /** The dash runs this far past where you stood. */
    overshoot: 1.2,
    hp: 0.8,
    damage: 1.15,
  },
  spitter: {
    speed: 3.6,
    windupMs: 950,
    recoverMs: 1_300,
    radius: 1.6,
    ahead: 0,
    /** Stays between these distances from you. */
    keep: [6, 10] as const,
    /** Lobs from no further than this. */
    range: 12,
    /** Aims this share of its windup ahead along your path (all of it:
     * keep on as you are and it lands on you). */
    lead: 1,
    hp: 0.6,
    damage: 0.8,
  },
} as const;

/** A swing, start to finish, for a brute on floor 1 (the old single kind,
 * kept for anything that only knows one mob). */
export const MOB_SWING = {
  windupMs: MOB_KINDS.brute.windupMs,
  recoverMs: MOB_KINDS.brute.recoverMs,
  /** The shape: a circle this big, this far in front of it. */
  radius: MOB_KINDS.brute.radius,
  ahead: MOB_KINDS.brute.ahead,
} as const;

/** Tells shrink 1% a floor, to 65% by floor 36, never below MIN_WINDUP_MS
 * (a reaction plus a step out of a circle, with room to spare). */
export function windupScale(floor: number): number {
  return Math.max(0.65, 1 - 0.01 * (Math.max(1, floor) - 1));
}
export const MIN_WINDUP_MS = 500;

/** How many mobs may be winding up or recovering at once: 2, one more
 * every 10 floors, at most 4. */
export function attackTokens(floor: number): number {
  return Math.min(4, 2 + Math.floor(Math.max(1, floor) / 10));
}

/** Mobs waiting for a token hold this far from you, round you. */
export const FLANK_RANGE = 2.7;

/** How long a floor may take before its mobs enrage: 45s and 6s a mob. */
export function floorParMs(floor: number): number {
  return 45_000 + 6_000 * mobsOnFloor(floor);
}
/** Enraged: this much faster, and swings this much quicker. */
export const ENRAGE = { speed: 1.4, windup: 0.75 } as const;

/** Every 5th floor (bar the Warden's) one mob is an elite: bigger, much
 * tougher, and with one trick (`affix`). */
export const ELITE = { every: 5, scale: 1.35, hp: 3, damage: 1.3 } as const;
/** An elite's trick: quicker on its feet, three lobs at once (spitters),
 * or barely a breather between swings. */
export type EliteAffix = "swift" | "volley" | "frenzy";

/** Every 10th floor the Warden stands among a smaller pack: a huge brute
 * that alternates a wide slam in front of it with a ring around itself
 * (whose middle is safe: get in close). */
export const WARDEN = {
  every: 10,
  scale: 1.8,
  hp: 10,
  damage: 1.5,
  speed: 3.4,
  windupMs: 1_100,
  recoverMs: 900,
  slam: { radius: 2.6, ahead: 1.4 },
  ring: { inner: 2.2, outer: 6 },
} as const;

/** Is this the Warden's floor, or an elite's? */
export const isWardenFloor = (floor: number) => floor % WARDEN.every === 0;
export const isEliteFloor = (floor: number) =>
  floor % ELITE.every === 0 && !isWardenFloor(floor);

/** Which kinds a floor's mobs are, before shuffling: brutes only on the
 * first floor, then spitters from floor 2 and lungers from floor 4, a
 * quarter each. */
export function floorKinds(floor: number): MobKind[] {
  const f = Math.max(1, floor);
  const n = mobsOnFloor(f);
  const spitters = f >= 2 ? Math.max(1, Math.floor(n / 4)) : 0;
  const lungers = f >= 4 ? Math.max(1, Math.floor(n / 4)) : 0;
  return [
    ...Array<MobKind>(spitters).fill("spitter"),
    ...Array<MobKind>(lungers).fill("lunger"),
    ...Array<MobKind>(Math.max(0, n - spitters - lungers)).fill("brute"),
  ];
}

/** After a floor opens, how long before the mobs wake. */
export const FLOOR_OPENING_MS = 2_000;

/** How many mobs a floor has (the Warden's floor: half, him among them). */
export function mobsOnFloor(floor: number): number {
  const n = Math.min(10, 3 + Math.floor(Math.max(1, floor) / 2));
  return isWardenFloor(Math.max(1, floor)) ? Math.ceil(n / 2) : n;
}

const BASE_HP = 300;
const HP_GROWTH = 1.1;
const BASE_DAMAGE = 8;
const DAMAGE_GROWTH = 1.08;
/** Past this floor the curves stop growing (the level gap still bites). */
const CURVE_CAP_FLOOR = 80;

/** A floor's mob: its level, health and how hard its swing lands (before
 * the level gap and Def). */
export function towerMob(floor: number): {
  level: number;
  hp: number;
  damage: number;
} {
  const f = Math.max(1, Math.floor(floor));
  const k = Math.min(f, CURVE_CAP_FLOOR) - 1;
  return {
    level: f,
    hp: Math.round(BASE_HP * HP_GROWTH ** k),
    damage: Math.round(BASE_DAMAGE * DAMAGE_GROWTH ** k),
  };
}

/**
 * What the level gap does: `gap` is the mob's level less the herzie's.
 * `dealt` scales the damage you do it, `taken` what it does you. Each level
 * above you takes 4% off yours and adds 5% to its; below you, the reverse,
 * up to a point.
 */
export function levelGapMods(gap: number): { dealt: number; taken: number } {
  const g = Number.isFinite(gap) ? gap : 0;
  return {
    dealt: clamp(1 - 0.04 * g, 0.3, 1.2),
    taken: clamp(1 + 0.05 * g, 0.6, 2),
  };
}

/** How a mob's level reads against yours: grey far below, white about
 * even, orange above, red well above. */
export function gapColour(gap: number): "grey" | "white" | "orange" | "red" {
  if (gap <= -5) return "grey";
  if (gap <= 2) return "white";
  if (gap <= 6) return "orange";
  return "red";
}

/** XP for a kill. Listening pays 10 XP a minute before bonuses; the first
 * floors go at about three kills a minute, so a third of that. Higher up a
 * kill pays a little more (to 3) but takes far longer, so it never catches
 * up. */
export function towerXpPerKill(floor: number): number {
  return Math.min(3, 1 + Math.floor(Math.max(1, floor) / 10));
}
/** At most this much tower XP a day (UTC). */
export const TOWER_XP_DAILY_CAP = 300;

/** The chance a kill drops an item: one in eight, so a floor or two of
 * mobs usually turns something up. That's faster than listening (one per ten
 * minutes) on purpose; the daily cap is what keeps it in check. The item is
 * picked as listening picks one (rarity weights and luck), leaning a little
 * rarer the higher the floor (towerLootLean). */
export const TOWER_DROP_CHANCE = 1 / 8;
/** At most this many tower drops a day (UTC). */
export const TOWER_DROPS_DAILY_CAP = 30;

/**
 * How much likelier the rare-and-up items get the higher the floor: every
 * 10 floors climbed adds `per10` to their drop weight (relative, so +10%
 * at floor 11, +20% at floor 21…), counted floor by floor, up to `cap`
 * (+50%, from floor 51 on). Gentle on purpose: a rare stays rare (at the
 * live pool a kill's drop is a rare about one time in 40 on the first
 * floors, about one in 27 at the cap), and climbing is worth it without
 * being the only way to play.
 */
export const TOWER_RARE_LEAN = { per10: 0.1, cap: 0.5 } as const;

/** The rare-and-up weight factor on `floor` (1 on floor 1, never down as
 * you climb, at most 1 + TOWER_RARE_LEAN.cap). */
export function towerRareFactor(floor: number): number {
  const f = Number.isFinite(floor) ? Math.max(1, Math.floor(floor)) : 1;
  return (
    1 + Math.min(TOWER_RARE_LEAN.cap, (TOWER_RARE_LEAN.per10 * (f - 1)) / 10)
  );
}

/**
 * Every 10th floor (the Warden's) leaves a chest on the compass in the
 * middle of the hall once its mobs are down. It stands shut until the
 * herzie, within `reach`, presses E (a `chestOpen`) — the Town server
 * judges that, as it judges every hit — and what's in it is
 * rolled by `town-vitals` like a kill's drop and tossed out like one:
 * towerChestRolls items, without Nostalgic Tokens (as a boss's loot),
 * leaning rarer than a kill's by `lean` on top of the floor's
 * (towerLootLean). Once per floor per Tower (the database keeps which:
 * 00155's tower_chests), outside the daily drop cap: it's a milestone, not
 * a farm. Going on with it still shut opens it on the way (nothing's lost).
 */
export const TOWER_CHEST = {
  every: WARDEN.every,
  /** Where it stands: the compass at the hall's middle. */
  at: { x: 0, z: 0 },
  /** E opens it from this close (centre to centre), plus the server's
   * usual slack for interpolation. */
  reach: 2.5,
  /** It lands first: it can't be opened sooner than this after the floor
   * clears, so it's seen landing. */
  settleMs: 1_000,
  /** How long the app plays its lid swinging open (and the loot bursting
   * out) before the chest fades away. */
  openMs: 900,
  /** On top of the floor's lean: a little rarer than a boss's random loot
   * leans (BOSS_LOOT_RARITY_BOOST in items.ts). */
  lean: {
    common: 1,
    uncommon: 1.5,
    rare: 2.5,
    legendary: 2.5,
    mythic: 2.5,
  } satisfies Record<Rarity, number>,
} as const;

/** Whether clearing `floor` leaves a chest. */
export const isChestFloor = (floor: number) =>
  Number.isInteger(floor) && floor >= 1 && floor % TOWER_CHEST.every === 0;

/**
 * Tower boons (players see them as "buffs"; boon here, so as not to be
 * mistaken for a skill's Buff in skills.ts): every `every`th floor cleared
 * in a climb earns a pick, for the rest of the month's Tower (its event),
 * in the Tower only. A pick offers three different boons at random, each
 * at a rarity rolled on its own that leans rarer the higher the floor
 * (towerBoonOffers); the herzie takes one, or skips the lot. Picks stack:
 * two rare damage boons are +24%. The Tower Guard can start a climb over
 * (tower_reset): back to floor 1 with no boons, the month's best floor
 * (the leaderboard) kept.
 *
 * The offers are the Town server's to roll and the app's to show; seeded
 * by the herzie, the Tower, the climb and the pick, so a reconnect brings
 * back the same three. Mirrored in SQL: tower_grant's cap on picks
 * (00163_tower_buffs_every_3.sql).
 */
export const TOWER_BOON_IDS = [
  "speed",
  "damage",
  "def",
  "crit",
  "ferocity",
  "tempo",
  "thorns",
  "executioner",
] as const;
export type TowerBoonId = (typeof TOWER_BOON_IDS)[number];

/** A boon a climb holds (or is offered): which, and how rare. */
export type TowerBoon = { id: TowerBoonId; rarity: Rarity };

/** The rarities a boon comes in, plainest first (items' rarities). */
export const TOWER_BOON_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "legendary",
  "mythic",
] as const satisfies readonly Rarity[];

export const TOWER_BOONS = {
  every: 3,
  /** How many boons a pick offers. */
  offers: 3,
  /** Each rarity's weight on the first pick's floor (`every`); `lean`
   * raises the rarer ones from there (see towerBoonWeights). */
  weights: { common: 60, uncommon: 25, rare: 10, legendary: 4, mythic: 1 },
  /** Each floor up adds this much to a factor that multiplies a rarity's
   * weight once per step above common: by floor 30 a pick is more likely
   * rare or better than common, by floor 60 legendary leads. */
  lean: 0.04,
} as const satisfies { weights: Record<Rarity, number> } & Record<
  string,
  unknown
>;

/** Each boon: its name, what it does (`{v}` its value), and its value at
 * each rarity, plainest first. Shares unless said: 0.1 = 10%. */
export const TOWER_BOON_DEFS: Record<
  TowerBoonId,
  {
    name: string;
    describe: string;
    values: readonly [number, number, number, number, number];
  }
> = {
  speed: {
    name: "Quick Hands",
    describe: "Attacks {v} faster.",
    values: [0.05, 0.08, 0.12, 0.18, 0.25],
  },
  damage: {
    name: "Heavy Hitter",
    describe: "Hits {v} harder.",
    values: [0.05, 0.08, 0.12, 0.18, 0.25],
  },
  def: {
    name: "Thick Skin",
    describe: "{v} more Def.",
    values: [0.08, 0.12, 0.18, 0.27, 0.4],
  },
  crit: {
    name: "Keen Ear",
    describe: "{v} more crit chance (points).",
    values: [3, 5, 8, 12, 16],
  },
  ferocity: {
    name: "Ferocity",
    describe: "Crits hit {v} harder.",
    values: [0.1, 0.15, 0.25, 0.4, 0.6],
  },
  tempo: {
    name: "Tempo",
    describe: "Skills come back {v} sooner.",
    values: [0.05, 0.08, 0.12, 0.16, 0.2],
  },
  thorns: {
    name: "Thorns",
    describe: "A mob that hits you takes {v} of the blow back.",
    values: [0.1, 0.15, 0.25, 0.4, 0.6],
  },
  executioner: {
    name: "Executioner",
    describe: "Hits {v} harder on a mob under a third of its health.",
    values: [0.1, 0.15, 0.25, 0.4, 0.6],
  },
};

/** The most a climb's boons may add up to, where unbounded stacking would
 * break something: cooldowns never less than half, crit chance points. */
export const TOWER_BOON_CAPS: Partial<Record<TowerBoonId, number>> = {
  tempo: 0.5,
  crit: 50,
};

export function isTowerBoonId(value: unknown): value is TowerBoonId {
  return (
    typeof value === "string" &&
    (TOWER_BOON_IDS as readonly string[]).includes(value)
  );
}

export function isTowerBoon(value: unknown): value is TowerBoon {
  if (!value || typeof value !== "object") return false;
  const v = value as { id?: unknown; rarity?: unknown };
  return (
    isTowerBoonId(v.id) &&
    (TOWER_BOON_RARITIES as readonly unknown[]).includes(v.rarity)
  );
}

/** A boon's value at its rarity. */
export function towerBoonValue(boon: TowerBoon): number {
  return TOWER_BOON_DEFS[boon.id].values[
    TOWER_BOON_RARITIES.indexOf(boon.rarity)
  ];
}

/** A boon's line for the app: its description with its value in ("Hits
 * 12% harder."). */
export function describeTowerBoon(boon: TowerBoon): string {
  const v = towerBoonValue(boon);
  const shown = boon.id === "crit" ? `+${v}` : `${Math.round(v * 100)}%`;
  return TOWER_BOON_DEFS[boon.id].describe.replace("{v}", shown);
}

/** How many boon picks a climb has earned by clearing `cleared` floors. */
export function towerBoonPicks(cleared: number): number {
  return Math.floor(Math.max(0, cleared) / TOWER_BOONS.every);
}

/** What a climb's boons add up to per boon, capped (TOWER_BOON_CAPS). */
export function towerBoonTotals(
  boons: readonly TowerBoon[],
): Record<TowerBoonId, number> {
  const t = Object.fromEntries(TOWER_BOON_IDS.map((id) => [id, 0])) as Record<
    TowerBoonId,
    number
  >;
  for (const b of boons) t[b.id] += towerBoonValue(b);
  for (const [id, cap] of Object.entries(TOWER_BOON_CAPS))
    t[id as TowerBoonId] = Math.min(t[id as TowerBoonId], cap);
  return t;
}

/** Each rarity's weight for a pick earned on `floor`. */
export function towerBoonWeights(floor: number): Record<Rarity, number> {
  const f = 1 + TOWER_BOONS.lean * Math.max(0, floor - TOWER_BOONS.every);
  const w = {} as Record<Rarity, number>;
  TOWER_BOON_RARITIES.forEach((r, tier) => {
    w[r] = TOWER_BOONS.weights[r] * f ** tier;
  });
  return w;
}

/** The seed for a herzie's `pick`th boon pick (0 the first) in a climb. */
export function towerBoonSeed(
  uid: string,
  event: string,
  climb: number,
  pick: number,
): string {
  return `${uid}:${event}:${climb}:${pick}`;
}

/** The boons a pick offers: TOWER_BOONS.offers different ones, each at a
 * rarity rolled from towerBoonWeights(floor), the same every time for the
 * same seed. `floor`: the floor that earned the pick. */
export function towerBoonOffers(seed: string, floor: number): TowerBoon[] {
  const rand = seededRandom(seed);
  const ids = [...TOWER_BOON_IDS];
  const weights = towerBoonWeights(floor);
  const total = TOWER_BOON_RARITIES.reduce((s, r) => s + weights[r], 0);
  const out: TowerBoon[] = [];
  for (let i = 0; i < TOWER_BOONS.offers && ids.length; i++) {
    const id = ids.splice(Math.floor(rand() * ids.length), 1)[0];
    let roll = rand() * total;
    let rarity: Rarity = "common";
    for (const r of TOWER_BOON_RARITIES) {
      roll -= weights[r];
      if (roll < 0) {
        rarity = r;
        break;
      }
    }
    out.push({ id, rarity });
  }
  return out;
}

/** A boon as the database keeps it: "damage:rare". */
export function towerBoonKey(boon: TowerBoon): string {
  return `${boon.id}:${boon.rarity}`;
}

/** A string hash (FNV-1a) into mulberry32: a small seeded RNG. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many items a chest holds: 2 on floor 10, one more every 20 floors,
 * at most 4 (floor 40 on). */
export function towerChestRolls(floor: number): number {
  return Math.min(4, 2 + Math.floor(Math.max(1, floor) / 20));
}

/** Each rarity's drop-weight factor for an item dropped on `floor` (a
 * chest's, with `chest`), on top of listening's weights and luck: what
 * `town-vitals` hands pickWeightedDrop. */
export function towerLootLean(
  floor: number,
  chest = false,
): Record<Rarity, number> {
  const rare = towerRareFactor(floor);
  const lean: Record<Rarity, number> | null = chest ? TOWER_CHEST.lean : null;
  return {
    common: lean?.common ?? 1,
    uncommon: lean?.uncommon ?? 1,
    rare: rare * (lean?.rare ?? 1),
    legendary: rare * (lean?.legendary ?? 1),
    mythic: rare * (lean?.mythic ?? 1),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
