/**
 * How far aiming turns the view per pixel of mouse movement, as a multiple
 * of the default (1 = as shipped, which is a quarter of the walking
 * camera's drag speed). Chosen in Settings, remembered.
 */
const KEY = "town.aim.sensitivity.v2";

export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 3;

const clamp = (v: number) =>
  Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, v));

let value = (() => {
  try {
    const n = Number(localStorage.getItem(KEY));
    return n > 0 ? clamp(n) : 1;
  } catch {
    return 1;
  }
})();

export function aimSensitivity(): number {
  return value;
}

export function setAimSensitivity(v: number): void {
  value = clamp(v);
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // Not remembered, then.
  }
}
