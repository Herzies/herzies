/**
 * A herzie's body as numbers: what its seed (its friend code) rolls, before
 * anything is built from it. A leaf with no imports, so the Town server can
 * hand the website a herzie's body without its friend code (see TownLook's
 * `body`) and without pulling in the renderer or the item catalog.
 */

export const CREATURE_PALETTE = [
  "#FFD700", // amber (original)
  "#FF6B6B", // coral red
  "#4ECDC4", // teal
  "#A8E6CF", // sage green
  "#C3A6FF", // soft violet
  "#FF9F43", // warm orange
  "#74B9FF", // sky blue
  "#FD79A8", // rose pink
  "#55EFC4", // mint
  "#FDCB6E", // golden yellow
];

// --- Seeded PRNG ---

export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rangeSeeded(min: number, max: number, rng: () => number): number {
  return min + rng() * (max - min);
}

function intSeeded(min: number, max: number, rng: () => number): number {
  return Math.floor(rangeSeeded(min, max + 1, rng));
}

// --- Creature parameters ---

export interface CreatureParams {
  bodyType: number;
  colorIndex: number;
  bodyScale: number;
  headRatio: number;
  eyeSpacing: number;
  eyeSize: number;
  eyeHeight: number;
  earCount: number;
  earAngle: number;
  earLength: number;
  armLength: number;
  legLength: number;
  textureType: number;
}

export const CREATURE_PARAM_BOUNDS = {
  // max is 4 ("boss") so the sandbox slider can reach it, but the seeded
  // generator deliberately stops at 3 — see generateCreatureParams.
  bodyType: { min: 0, max: 4, step: 1 },
  colorIndex: { min: 0, max: CREATURE_PALETTE.length - 1, step: 1 },
  bodyScale: { min: 0.85, max: 1.05, step: 0.01 },
  headRatio: { min: 0.65, max: 0.85, step: 0.01 },
  eyeSpacing: { min: 0.1, max: 0.18, step: 0.005 },
  eyeSize: { min: 0.09, max: 0.15, step: 0.005 },
  eyeHeight: { min: -0.25, max: -0.1, step: 0.005 },
  earCount: { min: 0, max: 2, step: 1 },
  earAngleDeg: { min: 25, max: 70, step: 1 },
  earLength: { min: 0.12, max: 0.28, step: 0.01 },
  armLength: { min: 0.25, max: 0.45, step: 0.01 },
  legLength: { min: 0.3, max: 0.55, step: 0.01 },
  textureType: { min: 0, max: 3, step: 1 },
} as const;

export function generateCreatureParams(userId: string): CreatureParams {
  const seed = simpleHash(userId);
  const rng = mulberry32(seed);

  return {
    // Hardcoded 3, NOT CREATURE_PARAM_BOUNDS.bodyType.max — "boss" is index 4
    // and must stay unreachable here. Widening this would consume the same
    // rng() call but remap bodyType for every existing seed, silently
    // changing what every herzie in the wild looks like. Bosses arrive only
    // via the creatureParams override prop.
    bodyType: intSeeded(0, 3, rng),
    colorIndex: intSeeded(0, CREATURE_PALETTE.length - 1, rng),
    bodyScale: rangeSeeded(
      CREATURE_PARAM_BOUNDS.bodyScale.min,
      CREATURE_PARAM_BOUNDS.bodyScale.max,
      rng,
    ),
    headRatio: rangeSeeded(
      CREATURE_PARAM_BOUNDS.headRatio.min,
      CREATURE_PARAM_BOUNDS.headRatio.max,
      rng,
    ),
    eyeSpacing: rangeSeeded(0.1, 0.18, rng),
    eyeSize: rangeSeeded(0.09, 0.15, rng),
    eyeHeight: rangeSeeded(-0.25, -0.1, rng),
    earCount: intSeeded(0, 2, rng),
    earAngle: rangeSeeded(25, 70, rng) * (Math.PI / 180),
    earLength: rangeSeeded(0.12, 0.28, rng),
    armLength: rangeSeeded(0.25, 0.45, rng),
    legLength: rangeSeeded(0.3, 0.55, rng),
    textureType: intSeeded(0, 3, rng),
  };
}
