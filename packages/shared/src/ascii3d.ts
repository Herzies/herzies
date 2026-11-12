/**
 * Shared 3D math, types, and constants for ASCII renderers.
 */

export type V3 = [number, number, number];
export type V2 = [number, number];

export function rotX(p: V3, a: number): V3 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

export function rotY(p: V3, a: number): V3 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function rotZ(p: V3, a: number): V3 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

export function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normV(v: V3): V3 {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function col(hex: string, ch: string): string {
  return `<span style="color:${hex}">${ch}</span>`;
}

export const RAMP_HERZIE = "▓";
export const RAMP_ITEM = " .·:;=+*#%@█";
export const LIGHT = normV([0.4, -0.6, -0.8]);
export const CHAR_ASPECT = 2.1;

/**
 * Canonical rainbow ramp. Shared by the Prism colour scheme, its inventory
 * card, and the Rainbow Headband so all three show the same seven hues.
 */
export const RAINBOW_RAMP = [
  "#FF6B6B",
  "#FFA94D",
  "#FFD43B",
  "#69DB7C",
  "#4DABF7",
  "#9775FA",
  "#F783AC",
] as const;

/**
 * Ocean-blue ramp for the Poseidon's Gift colour scheme, shared by the
 * creature renderer's colour scheme and this item's inventory card.
 */
export const OCEAN_RAMP = [
  "#BFEFFF",
  "#7EC8E3",
  "#4AA8D8",
  "#2E86C1",
  "#1B5FA8",
  "#123F7A",
] as const;

/**
 * Violet ramp for the Purple Dane colour scheme. Built around
 * CREATURE_PALETTE's "soft violet" (#C3A6FF) — the skin exists to paint a
 * herzie a colour it could already have hatched with, so the ramp keeps that
 * exact hue (259.6°) and only walks lightness across OCEAN_RAMP's span,
 * easing saturation down at the dark end so shadows don't read as neon.
 */
export const VIOLET_RAMP = [
  "#DDCCFF",
  "#B28EFC",
  "#8953F7",
  "#601BEF",
  "#4812B8",
  "#320F7B",
] as const;

/**
 * Pink ramp for FF Pink, Fabulous Fabian's skin, around the brand's pink
 * (#FF5FA8, hue 331°). The skin is also see-through (TRANSLUCENT_SKINS in
 * creature-renderer.ts): the 3D view draws the body as pink glass.
 */
export const FF_PINK_RAMP = [
  "#FFD1E6",
  "#FFA3CD",
  "#FF77B6",
  "#FF4FA0",
  "#E0337F",
  "#A8205C",
] as const;

/**
 * Teal ramp for the Thanks for all the fish! colour scheme. Same construction
 * as VIOLET_RAMP, around CREATURE_PALETTE's "teal" (#4ECDC4, hue 175.7°).
 */
export const TEAL_RAMP = [
  "#6ED6CF",
  "#54CBC3",
  "#3DBCB3",
  "#379E96",
  "#2F807A",
  "#27635F",
] as const;

/**
 * Pumpkin ramp for the Pumpkin Spice colour scheme (Halloween): a lit
 * pumpkin's orange walking down to a near-black rind, so a herzie reads as
 * carved and candle-lit rather than as the palette's warm-orange hatch.
 */
export const PUMPKIN_RAMP = [
  "#FFD08A",
  "#FFA53D",
  "#F27B13",
  "#C4570A",
  "#7A3307",
  "#2B1405",
] as const;

/**
 * Latte ramp for the Latte skin (the Streetsmart set): milk foam on top,
 * walking down through a light, milky coffee brown. Kept light on purpose:
 * a latte, not an espresso.
 */
export const LATTE_RAMP = [
  "#F4E7D3",
  "#E6CBA8",
  "#D6AE82",
  "#C49468",
  "#AE7D53",
  "#8F6340",
] as const;

/**
 * Gold ramp for Good ol' George, the rich (and slightly sleazy) merchant NPC.
 * Like VOID_RAMP it is not built around a CREATURE_PALETTE hue and no item
 * grants it: polished highlights down to a deep bronze, so he reads as
 * solid gold rather than as the palette's amber herzie.
 */
export const GOLD_RAMP = [
  "#FFF4B8",
  "#FFE066",
  "#F5C518",
  "#D4A017",
  "#A67C00",
  "#6E5200",
] as const;

/**
 * Nandor the Treatless, the Halloween vampire NPC. Like GOLD_RAMP no item
 * grants it: a deathly pale face that drains down into a blood-red cloak and
 * then nearly black, so he reads as a vampire rather than as a red herzie.
 */
export const NANDOR_RAMP = [
  "#F2E9EE",
  "#D3C2CC",
  "#A8344A",
  "#7A1426",
  "#4A0A16",
  "#1E0308",
] as const;

/**
 * Boboku, the instrument seller who's always in Town. Like GOLD_RAMP no item
 * grants it: one solid tangerine, top to toe (every step the same, so no
 * bands), unlike the striped Pumpkin Spice skin.
 */
export const BOBOKU_RAMP = [
  "#F5922F",
  "#F5922F",
  "#F5922F",
  "#F5922F",
  "#F5922F",
  "#F5922F",
] as const;

/**
 * The Tower Guard, who stands by the Tower and doubts you. No item grants
 * it: a navy uniform, darkening toward the boots, so his steel helm stands
 * out against it.
 */
export const TOWER_GUARD_RAMP = [
  "#4A6191",
  "#455B8A",
  "#3F5482",
  "#3A4D78",
  "#34456C",
  "#2E3D60",
] as const;

/**
 * Pip, a stage 1 herzie who's just getting into music. No item grants it:
 * a fresh mint green fading to a deep pine, young and a little green.
 */
export const PIP_RAMP = [
  "#9CF2C0",
  "#74E0A4",
  "#4FC487",
  "#36A06C",
  "#247A52",
  "#15523A",
] as const;

/**
 * Nakata, an old man who talks to cats. No item grants it: soft greys with
 * a little warmth in them, pale at the crown, darker at his feet.
 */
export const NAKATA_RAMP = [
  "#D9D4CC",
  "#BFB9AF",
  "#A39D93",
  "#878279",
  "#6B6660",
  "#4F4B46",
] as const;

/**
 * Medea, who sells sweets and potions and is always in Town. No item grants
 * it: candy pink at the crown sinking through orchid and violet into a plum
 * that's nearly black at her feet — sweet on top, darker underneath.
 */
export const MEDEA_RAMP = [
  "#FF8FD0",
  "#E05AB8",
  "#A23CA8",
  "#6A2486",
  "#3C1456",
  "#1A0828",
] as const;

/**
 * Boss ramp — the only ramp that is not built around a CREATURE_PALETTE hue,
 * because a boss is deliberately not a colour a herzie could hatch with.
 *
 * Runs ember-red at the top to near-black at the bottom, which is the inverse
 * of every other ramp here: those brighten downward, this one swallows the
 * legs. RAMP_HERZIE is a single glyph, so the sink into black is the only way
 * the silhouette can lose its own feet.
 */
export const VOID_RAMP = [
  "#C8341B",
  "#93220F",
  "#63150A",
  "#3D0C06",
  "#220604",
  "#0E0202",
] as const;
