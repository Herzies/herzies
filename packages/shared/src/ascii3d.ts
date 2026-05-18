/**
 * Shared 3D math, types, and constants for ASCII renderers.
 */

export type V3 = [number, number, number];
export type V2 = [number, number];

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
