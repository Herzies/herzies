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

export const SKILL_IDS = ["soothing-drones", "backspin", "cymbrella"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export const SKILL_MAX_LEVEL = 10;

export type SkillKind = "heal" | "buff" | "attack";

export interface SkillDef {
  id: SkillId;
  name: string;
  kind: SkillKind;
  /** Short description; `{v}` is replaced with the level's value. */
  describe: string;
  /** Effect value at level 1 and level 10; linear in between. A fraction:
   * 0.2 is 20% (of max HP healed, of damage reduced, of a normal hit). */
  value: readonly [number, number];
  cooldownMs: number;
  /** Buffs only: how long the buff lasts. */
  durationMs?: number;
  /** Heals: who is in reach, metres from the caster. */
  radius?: number;
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
    cooldownMs: 20_000,
    radius: 8,
    xpPerUnit: 1 / 6,
  },
  backspin: {
    id: "backspin",
    name: "Backspin",
    kind: "attack",
    describe: "Flings three spinning discs, each hitting for {v} of a wave.",
    value: [0.6, 1.2],
    cooldownMs: 12_000,
    xpPerUnit: 1 / 40,
  },
  cymbrella: {
    id: "cymbrella",
    name: "Cymbrella",
    kind: "buff",
    describe: "A giant cymbal overhead: {v} less damage, and the boss's eye.",
    value: [0.1, 0.4],
    cooldownMs: 20_000,
    durationMs: 6_000,
    // A Cymbrella only absorbs a few HP a hit (10-40% of a slam or a
    // buster), so each one pays more. Uncalibrated, like the others.
    xpPerUnit: 4,
  },
};

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
  const pct = `${Math.round(skillValue(id, level) * 100)}%`;
  return SKILL_DEFS[id].describe.replace("{v}", pct);
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

export type BuffId = "cymbrella";

export interface Buff {
  id: BuffId;
  /** Strength, e.g. 0.25 = 25% less damage. */
  value: number;
  /** Epoch ms. */
  until: number;
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
    },
  ];
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
