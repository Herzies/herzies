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
 * - Every 5th floor an elite (ELITE), every 10th a Warden (WARDEN).
 *
 * Kills pay a little XP (kept behind what the same time listening brings)
 * and now and then an item, picked exactly as listening picks one, under a
 * daily cap.
 */

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
 * the level gap, Def and the hit cap). */
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
 * picked as listening picks one (rarity weights and luck). */
export const TOWER_DROP_CHANCE = 1 / 8;
/** At most this many tower drops a day (UTC). */
export const TOWER_DROPS_DAILY_CAP = 30;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
