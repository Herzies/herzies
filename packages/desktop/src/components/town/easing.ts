/** Shared easing helpers for the town's effects and animations. */

/** Cubic ease-out. Not clamped: callers that can pass t outside 0..1 want
 * `easeOutClamped`. */
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Cubic ease-out with t held to 0..1. */
export const easeOutClamped = (t: number) =>
  1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Smoothstep of v between a and b. */
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
