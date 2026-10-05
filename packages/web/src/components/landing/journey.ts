import { DEFAULT_Y_ANGLE, type Equipped, SH } from "@herzies/shared";

// "Your herzie": the one that grows up in Listen, follows you down into
// Collect to be dressed, and turns up again among friends in Discover.

/** Its seed, shared by every section that draws it. */
export const OUR_SEED = "landing-listen";

/** The three cards placed in Collect, in order, and the slot each one fills
 * on the herzie. Body items need a stage 3 herzie, which this one is by
 * then. */
export const PICKS = [
  { id: "headphones", slot: "head" },
  { id: "gold-chain", slot: "body" },
  { id: "boombox", slot: "ground_left" },
] as const;

/** What the herzie is wearing once the first `count` cards are placed. */
export function outfitFor(count: number): Equipped {
  return Object.fromEntries(
    PICKS.slice(0, count).map((pick) => [pick.slot, pick.id]),
  );
}

/** Wide enough for the boombox standing beside it. */
export const OUR_COLS = 72;

/** Herzie3D's canvas size for a given cell size and width (mirrors its own
 * metrics), so a placeholder can hold exactly the room a herzie takes. */
export function canvasSize(size: number, cols: number) {
  return {
    width: Math.ceil(cols * size * 0.6),
    height: Math.ceil(SH * size * 1.35),
  };
}

/** The size your herzie stands at beside Orphiez and the boss. */
export function companionSize(wide: boolean) {
  return wide ? 4.5 : 3;
}

/** How far your herzie turns (radians) to face the visitor it stands
 * beside: Orphiez on its right, the boss on its left. Herzie3D adds its
 * usual three-quarter turn (DEFAULT_Y_ANGLE) to any angle, so that's taken
 * off first: these are measured from square-on. A negative angle turns it
 * to its right (the viewer's right). */
const TURN = 0.4;
export const FACE_RIGHT = -DEFAULT_Y_ANGLE - TURN;
export const FACE_LEFT = -DEFAULT_Y_ANGLE + TURN;
