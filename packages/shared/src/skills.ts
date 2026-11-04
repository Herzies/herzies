/**
 * Class skills: definitions, tuning, levelling and the combat maths the Town
 * server applies. Pure and dependency-free, so the Town server, the desktop
 * and the edge functions all share one copy.
 *
 * Design rules (see the classes plan):
 *  - The Town server decides; the client predicts cooldowns and buffers input.
 *  - Skill XP pays for what a skill actually did — HP restored, damage
 *    absorbed, damage dealt — never for pressing the button. Overheal is 0.
 *  - The same buff from several casters doesn't stack: the strongest applies.
 *  - Damage reduction multiplies and is clamped, so it never reaches 100%.
 *
 * Mirrored in SQL: SKILL_MAX_LEVEL and skillXpForLevel by
 * apply_skill_xp_batch (00107_skill_effects.sql).
 */

export const SKILL_IDS = [
  "soothing-drones",
  "backspin",
  "cymbrella",
  "resurrect",
  "taunt",
  "haste",
  "shuffle",
  "rimshot",
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export const SKILL_MAX_LEVEL = 10;

export type SkillKind = "heal" | "buff" | "attack" | "revive" | "taunt";

export interface SkillDef {
  id: SkillId;
  name: string;
  kind: SkillKind;
  /** Short description; `{v}` is replaced with the level's value. */
  describe: string;
  /** Effect value at level 1 and level 10; linear in between. A fraction:
   * 0.2 is 20% (of max HP healed, of damage reduced, of a normal hit),
   * unless `count`. */
  value: readonly [number, number];
  /** The value is a whole number of things (Shuffle's bounces), rounded,
   * not a share: what one and several of them are called. */
  count?: readonly [string, string];
  cooldownMs: number;
  /** Buffs only: how long the buff lasts. */
  durationMs?: number;
  /** Heals: who is in reach, metres from the caster. A revive: how close
   * the downed herzie must be. */
  radius?: number;
  /** A channel: the caster stands still this long before it takes effect
   * (moving or going down cancels it, and costs nothing). */
  channelMs?: number;
  /** A wind-up: the caster is held where they stand this long, then it
   * lands (only going down cancels it). Its cooldown runs from the press. */
  castMs?: number;
  /** A skill a class learns later: the herzie level it's learned at (the
   * database grants it then; see 00137_shuffle.sql). */
  minLevel?: number;
  /** Skill XP per unit of effect (per HP healed, per damage absorbed, per
   * damage dealt). Meant to make each class level at a similar pace over
   * the same number of fights — first guesses, not yet calibrated against
   * a simulated fight with skill-using players. */
  xpPerUnit: number;
}

export const SKILL_DEFS: Record<SkillId, SkillDef> = {
  "soothing-drones": {
    id: "soothing-drones",
    name: "Soothing Drones",
    kind: "heal",
    describe: "Heals every herzie nearby by {v} of their health.",
    value: [0.2, 0.5],
    // The Bard's burst heal; its lute's heal bolts carry the steady work
    // between, so this one comes round often.
    cooldownMs: 12_000,
    radius: 8,
    xpPerUnit: 1 / 6,
  },
  backspin: {
    id: "backspin",
    name: "Backspin",
    kind: "attack",
    describe: "Flings three spinning discs, each hitting for {v} of a wave.",
    // Each disc out-hits a plain throw (DISC_DAMAGE 1.15) from level 1: a
    // burst worth pressing, not a weaker throw.
    value: [1.5, 2.5],
    cooldownMs: 12_000,
    xpPerUnit: 1 / 40,
  },
  cymbrella: {
    id: "cymbrella",
    name: "Cymbrella",
    kind: "buff",
    describe:
      "A golden dome for {v}: no one inside it is hurt, no enemy gets in, and the boss turns on you.",
    // How long the dome stands (seconds): see DOME in combat.ts for its
    // size. Short against a long cooldown: a save timed for the big hit,
    // not a shelter that's always up.
    value: [3, 5],
    count: ["second", "seconds"],
    cooldownMs: 30_000,
    // Per HP it kept off anyone inside (as a heal pays per HP restored).
    xpPerUnit: 1 / 6,
  },
  resurrect: {
    id: "resurrect",
    name: "Resurrect",
    kind: "revive",
    describe:
      "Plays a downed herzie back to its feet with {v} of its health. 3 s to play; moving stops it.",
    value: [0.3, 0.5],
    // Revives are unlimited: this keeps one Bard from chaining several in
    // a row.
    cooldownMs: 30_000,
    channelMs: 3_000,
    radius: 4,
    // Per HP brought back, as a heal pays.
    xpPerUnit: 1 / 6,
  },
  taunt: {
    id: "taunt",
    name: "Taunt",
    kind: "taunt",
    describe:
      "A crash that turns the boss on you for 10 s, its busters too. Each buster leaves you Rattled (the next hits harder): trade the boss with another Percussionist.",
    value: [0, 0],
    // Short, with a gap: one Percussionist can't hold it forever, and two
    // trading it is the job.
    cooldownMs: 20_000,
    durationMs: 10_000,
    // Per point of boss damage it drew onto you (aimed, before Def): what
    // a taunt is for.
    xpPerUnit: 0.25,
  },
  haste: {
    id: "haste",
    name: "Haste",
    kind: "buff",
    describe:
      "A quickening tune: every herzie nearby (you too) attacks {v} faster for 12 s.",
    // Raid-wide attack speed, as Bloodlust/Heroism (30%) or a Bard's
    // songs: strong, so on a long cooldown, to be called at the right time.
    value: [0.25, 0.4],
    cooldownMs: 60_000,
    durationMs: 12_000,
    radius: 10,
    minLevel: 15,
    // Per point of extra damage the hasted dealt because of it (the share
    // of their hits that haste added): the Backspin scale, a little lower
    // since it comes from many hands at once.
    xpPerUnit: 1 / 150,
  },
  shuffle: {
    id: "shuffle",
    name: "Shuffle",
    kind: "buff",
    describe:
      "For 10 s, each disc you throw bounces on to {v} nearby, each bounce 30% weaker than the last.",
    // Bounces: 1 at level 1, one more every two levels, 5 at the cap.
    value: [1, 5],
    count: ["more enemy", "more enemies"],
    // Only for a pack: a lone target is hit as ever, so it adds nothing
    // to a boss with no minions up.
    cooldownMs: 30_000,
    durationMs: 10_000,
    minLevel: 15,
    // Per point of damage the bounces dealt (the first hit is a plain
    // throw's): Backspin's scale.
    xpPerUnit: 1 / 40,
  },
  rimshot: {
    id: "rimshot",
    name: "Rimshot",
    kind: "attack",
    describe:
      "Winds up for 0.8 s, then slams the ground: every enemy within 3.5 m takes twice a strike, each with a {v} chance to be stunned for 2 s (the boss 1 s), cutting short whatever it was winding up.",
    // The chance to stun each enemy hit (see RIMSHOT).
    value: [0.25, 0.5],
    cooldownMs: 10_000,
    castMs: 800,
    minLevel: 15,
    // Per point of damage it dealt.
    xpPerUnit: 1 / 40,
  },
};

/** Rimshot, a ground slam: how far round its caster it reaches, its blow
 * on each enemy there as a share of a strike's, and its stun: how long on
 * a mob, how much shorter on the boss, and the window in which another
 * stun on the same target is halved again (WoW-style diminishing
 * returns, so two Percussionists can't keep the boss locked). Its wind-up
 * is SKILL_DEFS.rimshot.castMs; the herzie's slam lands at its end
 * (gl/HerzieModel SLAM_RELEASE_SECONDS). */
export const RIMSHOT = {
  radius: 3.5,
  damage: 2,
  stunMs: 2_000,
  bossStunScale: 0.5,
  drWindowMs: 16_000,
} as const;

/** The skills a class has learned by herzie level `level` (a skill with no
 * minLevel from the start). */
export function skillLearned(id: SkillId, level: number): boolean {
  return level >= (SKILL_DEFS[id].minLevel ?? 0);
}

/** Shuffle: how far a disc bounces on from what it hit, centre to centre
 * on the ground (the training grounds' dummies stand 8.5 apart), and how
 * much weaker each bounce is than the one before. */
export const SHUFFLE_REACH = 9;
export const SHUFFLE_FALLOFF = 0.7;

/** How many times a disc bounces on under a Shuffle at `level`. */
export function shuffleBounces(level: number): number {
  return Math.round(skillValue("shuffle", level));
}

/** A disc's `n`th bounce (1 the first) hits for this share of a throw. */
export function shuffleScale(n: number): number {
  return SHUFFLE_FALLOFF ** Math.max(0, n);
}

/** Backspin's fan: three discs, this far apart (radians). */
export const BACKSPIN_SPREAD = (8 * Math.PI) / 180;
export const BACKSPIN_DISCS = 3;

/** A cooldown rejection this close to the cooldown's end is forgiven (not a
 * strike), so a high-ping client predicting slightly early isn't punished. */
export const SKILL_COOLDOWN_GRACE_MS = 150;

export function isSkillId(value: unknown): value is SkillId {
  return (
    typeof value === "string" &&
    (SKILL_IDS as readonly string[]).includes(value)
  );
}

export function clampSkillLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(SKILL_MAX_LEVEL, Math.max(1, Math.floor(level)));
}

/** The skill's effect at `level`: linear from level 1 to SKILL_MAX_LEVEL. */
export function skillValue(id: SkillId, level: number): number {
  const [lo, hi] = SKILL_DEFS[id].value;
  const t = (clampSkillLevel(level) - 1) / (SKILL_MAX_LEVEL - 1);
  return lo + (hi - lo) * t;
}

export function describeSkill(id: SkillId, level: number): string {
  const v = skillValue(id, level);
  const count = SKILL_DEFS[id].count;
  const n = Math.round(v);
  const shown = count
    ? `${n} ${n === 1 ? count[0] : count[1]}`
    : `${Math.round(v * 100)}%`;
  // A skill without a value (Taunt) has no {v} to fill.
  return SKILL_DEFS[id].describe.replace("{v}", shown);
}

// --- Skill XP ---------------------------------------------------------------

/** XP to go from `level` to `level + 1`. About 2,500 XP from 1 to 10 in all;
 * a solid boss fight pays around 100, so a skill maxes in ~25 fights. */
export function skillXpForLevel(level: number): number {
  return Math.round(40 * level ** 1.2);
}

/** Total XP at which `level` is reached. */
export function skillTotalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < clampSkillLevel(level); l++) total += skillXpForLevel(l);
  return total;
}

export function skillLevelForXp(xp: number): number {
  let level = 1;
  while (level < SKILL_MAX_LEVEL && xp >= skillTotalXpForLevel(level + 1)) {
    level++;
  }
  return level;
}

export interface SkillProgress {
  level: number;
  /** Cumulative XP. */
  xp: number;
}

/** Adds XP; levels follow from the total. XP keeps counting at the cap. */
export function applySkillXp(
  progress: SkillProgress,
  gain: number,
): SkillProgress & { leveledUp: boolean } {
  const xp = Math.max(0, progress.xp + Math.max(0, Math.floor(gain)));
  const level = skillLevelForXp(xp);
  return { xp, level, leveledUp: level > progress.level };
}

/** 0..1 through the current level (1 at the cap). */
export function skillLevelProgress(progress: SkillProgress): number {
  if (progress.level >= SKILL_MAX_LEVEL) return 1;
  const from = skillTotalXpForLevel(progress.level);
  const need = skillXpForLevel(progress.level);
  return Math.min(1, Math.max(0, (progress.xp - from) / need));
}

/** XP earned for `units` of effect. */
export function skillXpFor(id: SkillId, units: number): number {
  return Math.max(0, units) * SKILL_DEFS[id].xpPerUnit;
}

// --- Buffs and mitigation ---------------------------------------------------

/** `cymbrella`: a dome of yours is up (on its caster, for the HUD; the
 * dome itself is judged by where it stands). `taunt`: the boss's eye (shown on whoever
 * holds it; no stat). `in_tune`: listening to what the boss hates, a class
 * bonus whose `kind` says what it does. `haste`: attacks this much faster
 * (0.3 = 30% more often). `shuffle`: thrown discs bounce on this many
 * times. */
export type BuffId =
  | "cymbrella"
  | "taunt"
  | "in_tune"
  | "rattled"
  | "haste"
  | "shuffle";

/** What an in-tune bonus does: less damage taken, stronger heals, harder
 * hits. */
export type BuffKind = "def" | "heal" | "damage";

export interface Buff {
  id: BuffId;
  /** Strength, e.g. 0.25 = 25% less damage, 1.25 = hits 25% harder. */
  value: number;
  /** Epoch ms. */
  until: number;
  kind?: BuffKind;
  /** Who put it there (a user id), when someone else's work: a Haste's
   * Bard is paid for what it adds. */
  by?: string;
}

/** Every damage reduction a buff list gives at `now`: an in-tune
 * Percussionist's. (A Cymbrella is a dome now: whoever stands in it takes
 * nothing; see DOME in combat.ts.) */
export function buffReductions(buffs: readonly Buff[], now: number): number[] {
  return activeBuffs(buffs, now)
    .filter((b) => b.id === "in_tune" && b.kind === "def")
    .map((b) => b.value);
}

/** A multiplier a buff list gives at `now` for `kind` (1 if none). */
export function buffMultiplier(
  buffs: readonly Buff[],
  kind: "heal" | "damage",
  now: number,
): number {
  let m = 1;
  for (const b of activeBuffs(buffs, now))
    if (b.id === "in_tune" && b.kind === kind) m *= b.value;
  return m;
}

/** Adds a buff under the no-stacking rule: one of each kind; the stronger
 * value and the later expiry win. */
export function applyBuff(buffs: readonly Buff[], next: Buff): Buff[] {
  const prev = buffs.find((b) => b.id === next.id);
  const rest = buffs.filter((b) => b.id !== next.id);
  if (!prev) return [...rest, next];
  return [
    ...rest,
    {
      id: next.id,
      value: Math.max(prev.value, next.value),
      until: Math.max(prev.until, next.until),
      ...(next.kind ? { kind: next.kind } : {}),
      // The one that's stronger (or, as strong, the newer) is whose.
      ...((next.value >= prev.value ? next.by : prev.by)
        ? { by: next.value >= prev.value ? next.by : prev.by }
        : {}),
    },
  ];
}

/** How much faster a buff list attacks at `now`: 1, or 1 + its Haste. */
export function attackSpeed(buffs: readonly Buff[], now: number): number {
  let haste = 0;
  for (const b of activeBuffs(buffs, now))
    if (b.id === "haste") haste = Math.max(haste, b.value);
  return 1 + haste;
}

/** How many times a thrown disc bounces on at `now`: its Shuffle's, or 0. */
export function shuffleOn(buffs: readonly Buff[], now: number): number {
  let n = 0;
  for (const b of activeBuffs(buffs, now))
    if (b.id === "shuffle") n = Math.max(n, Math.round(b.value));
  return n;
}

export function activeBuffs(buffs: readonly Buff[], now: number): Buff[] {
  return buffs.filter((b) => b.until > now);
}

/** The most damage reduction ever allowed, from every source together. */
export const MAX_DAMAGE_REDUCTION = 0.75;

/** Damage after reductions: they multiply (two 50% shields take 75% off,
 * not 100%), and the total is clamped at MAX_DAMAGE_REDUCTION. */
export function mitigate(
  damage: number,
  reductions: readonly number[],
): number {
  let kept = 1;
  for (const r of reductions) kept *= 1 - Math.min(1, Math.max(0, r));
  kept = Math.max(kept, 1 - MAX_DAMAGE_REDUCTION);
  return damage * kept;
}
