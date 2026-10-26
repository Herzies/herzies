/**
 * Classes: the audio holy trinity a herzie picks, once, on reaching stage 2.
 *
 * Mirrored in SQL by 00106_classes.sql — the class check on herzies.class
 * and items.required_class — and by choose_class's skills per class
 * (00122_boss_revamp.sql). A new class needs both.
 */
import type { SkillId } from "./skills.js";

export const CLASS_IDS = ["bard", "record_slinger", "percussionist"] as const;
export type HerzieClass = (typeof CLASS_IDS)[number];

export type ClassRole = "support" | "dps" | "tank";

/** A class's basic attack: a sonic wave from the hand, a disc thrown that
 * comes back, or a blow up close (a classless herzie's, too). */
export type AttackStyle = "wave" | "disc" | "melee";

export interface ClassDef {
  id: HerzieClass;
  name: string;
  emoji: string;
  role: ClassRole;
  /** Item ids handed over, already worn, when the class is chosen. */
  equipment: string[];
  /** The skill every herzie of this class starts with. */
  starterSkill: SkillId;
  /** Every skill the class has, the starter first (hotbar order). Mirrored
   * by choose_class (00122_boss_revamp.sql). */
  skills: readonly SkillId[];
  /** Its basic attack. */
  attack: AttackStyle;
}

/** The stage at which a herzie picks its class. */
export const CLASS_STAGE = 2;

export const CLASS_DEFS: Record<HerzieClass, ClassDef> = {
  bard: {
    id: "bard",
    name: "Bard",
    emoji: "💓",
    role: "support",
    equipment: ["lute"],
    starterSkill: "soothing-drones",
    skills: ["soothing-drones", "resurrect"],
    attack: "wave",
  },
  record_slinger: {
    id: "record_slinger",
    name: "Record Slinger",
    emoji: "📀",
    role: "dps",
    equipment: ["compact-discs"],
    starterSkill: "backspin",
    skills: ["backspin"],
    attack: "disc",
  },
  percussionist: {
    id: "percussionist",
    name: "Percussionist",
    emoji: "🥁",
    role: "tank",
    equipment: ["worn-stick", "old-cymbal"],
    starterSkill: "cymbrella",
    skills: ["cymbrella", "taunt"],
    attack: "melee",
  },
};

export const CLASS_ROLE_LABELS: Record<ClassRole, string> = {
  support: "Support",
  dps: "DPS",
  tank: "Tank",
};

export function isHerzieClass(value: unknown): value is HerzieClass {
  return (
    typeof value === "string" &&
    (CLASS_IDS as readonly string[]).includes(value)
  );
}

/** The basic attack of a herzie of class `cls`: without one, it bumps
 * into things (melee). */
export function attackStyle(cls: string | null | undefined): AttackStyle {
  return isHerzieClass(cls) ? CLASS_DEFS[cls].attack : "melee";
}

/** The basic attack that goes with the gear in a herzie's main hand: what
 * someone else's herzie is seen to do, where its class isn't known. */
export function attackStyleOfGear(
  mainHand: string | null | undefined,
): AttackStyle {
  if (!mainHand) return "melee";
  for (const def of Object.values(CLASS_DEFS))
    if (def.equipment[0] === mainHand) return def.attack;
  return "wave";
}

/** Whether a herzie should be asked to pick a class now. */
export function needsClassChoice(herzie: {
  stage: number;
  class?: HerzieClass | null;
}): boolean {
  return herzie.stage >= CLASS_STAGE && !herzie.class;
}
