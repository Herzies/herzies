/**
 * The camera swinging round behind you as a duel's countdown begins, so
 * "FIGHT!" finds your opponent in front of you. Pure: CameraRig drives it.
 */

/** How long the swing takes (ms): about the walk onto your mark. */
export const SWING_MS = 500;

/** The camera azimuth that sits behind a herzie at `from` looking at
 * `to` (camera-controls' convention: the camera on the target's +z side at
 * 0, so behind a herzie facing `heading` is `heading − π`). */
export function behindToward(
  from: { x: number; z: number },
  to: { x: number; z: number },
): number {
  return Math.atan2(to.x - from.x, to.z - from.z) - Math.PI;
}

/** The azimuth `t` (0–1) of the way from `from` to `to`, eased in and out,
 * the short way round (never a turn of more than half a circle). */
export function swingAzimuth(from: number, to: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const d = to - from;
  return from + Math.atan2(Math.sin(d), Math.cos(d)) * e;
}
