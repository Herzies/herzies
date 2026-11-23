import { type Building, turned } from "./map";

/**
 * The Tower on the home island: a round stone tower so tall that nobody
 * sees its top. The camera's frame cuts it off near the door. From across
 * the island it fades into the sky as it rises, through rings of cloud,
 * and the fade is done before the frame would reach the end (see
 * `towerFadeAt`). This file has the parts that are only numbers: its size,
 * where it stands, where its door is, how fast it fades. The drawing is in
 * Tower.tsx.
 *
 * Built for a 5×5 patch of `I` cells. A patch of another size scales the
 * whole tower (door included), so it still fits its cells. The door faces
 * the way `buildingsOf` put it, turned with the building.
 */

/** The patch the tower is built for, in cells across. */
export const TOWER_CELLS = 5;

/** The height fade: the colour has gone halfway to the sky at `hm` above
 * the tower's floor, over a scale of `s`. From `ditherFrom` on, the last
 * stretch is screen-door holes (see `towerFadeAt`). */
export const TOWER_FADE = { hm: 40, s: 9, ditherFrom: 0.9 } as const;
/** The windows and the cloud collar fade this much higher: a few lights
 * and clouds still show through the haze, leading the eye on up. */
export const TOWER_FADE_LATE = 6;

/** Where the geometry stops. The fade is complete (every pixel a hole) by
 * about 61, and this leaves room to spare. */
export const TOWER_TOP = 68;

/** The drum's radius at its foot (corner to corner of its 12 sides). */
export const TOWER_RADIUS = 2.4;
/** The plinth it stands on, and the collider round it. */
export const TOWER_PLINTH = 2.65;
/** How tall the plinth stands above the ground: two steps up to the door. */
export const TOWER_PLINTH_HEIGHT = 0.3;
/** The face of the entrance's porch, out from the axis: the door is set in
 * it, level with the edge of the tower's cells. */
export const TOWER_DOOR_FACE = 2.5;
/** How far out from the door its E-to-enter spot is (see portalsOf). */
export const TOWER_DOOR_OUT = 0.9;
/** The top of the ground storey, where the first floor's band runs. */
export const TOWER_GROUND_STOREY = 6.2;

/** Floors above the ground storey: the first this tall, each one a little
 * shorter than the one below it. Forced perspective, gentle enough that
 * the camera can orbit it: more floors seem to be there than are built. */
const FLOOR_HEIGHT = 4;
const FLOOR_SHRINK = 0.975;

/**
 * How far the tower has faded into the sky at height `h` above its floor,
 * 0–1. The curve is 1 − 2^(−e^((h − hm)/s)). It has a long, slow tail, so
 * there's no line where the fade begins, and it finishes quickly, so the
 * geometry can stop soon after. It's the transmittance through haze whose
 * density grows exponentially with height: 0.02 at 10, 0.2 at 30, 0.5 at
 * 40, 0.9 at 51, all but 1 by 61.
 */
export function towerFadeAt(
  h: number,
  hm: number = TOWER_FADE.hm,
  s: number = TOWER_FADE.s,
): number {
  return 1 - 2 ** -Math.exp((h - hm) / s);
}

/** The drum's radius at height `y`: tapering gently as it rises, like a
 * spire seen from far off. */
export function towerRadiusAt(y: number): number {
  return TOWER_RADIUS * (0.62 + 0.38 * Math.exp(-Math.max(0, y) / 60));
}

/** One storey above the ground storey: where it starts, how tall it is,
 * and which it is (0 the first). */
export type TowerFloor = { n: number; y: number; h: number };

/** Every floor from the ground storey's top to TOWER_TOP. */
export function towerFloors(): TowerFloor[] {
  const out: TowerFloor[] = [];
  let y = TOWER_GROUND_STOREY;
  for (let n = 0; y < TOWER_TOP; n++) {
    const h = FLOOR_HEIGHT * FLOOR_SHRINK ** n;
    out.push({ n, y, h });
    y += h;
  }
  return out;
}

/** The repeating beats up the tower. Every floor gets a band and windows.
 * Every second floor gets a balcony. Every fourth gets a cornice with
 * banners. Two of the largest beat show before the fade sets in, so the
 * eye reads it as a pattern that carries on. */
export const hasBalcony = (n: number) => n % 2 === 1;
export const hasCornice = (n: number) => n % 4 === 3;

const DOOR_YAW = { n: Math.PI, s: 0, w: -Math.PI / 2, e: Math.PI / 2 };

/** Where a tower building stands: its axis (x, z), the way its door faces
 * (`yaw`; forward is (sin, cos)), and how much it's scaled to its cells. */
export function towerPlace(b: Building): {
  x: number;
  z: number;
  yaw: number;
  scale: number;
} {
  const r = b.rects[0];
  const [x, z] = turned(b, r.x0 + r.w / 2, r.z0 + r.h / 2);
  return {
    x,
    z,
    yaw: DOOR_YAW[b.door?.side ?? "s"] + b.turn,
    scale: Math.min(r.w, r.h) / TOWER_CELLS,
  };
}

/** The spot in front of a tower's door where E reaches it: just off its
 * porch, facing out. */
export function towerDoorSpot(b: Building): {
  x: number;
  z: number;
  yaw: number;
} {
  const p = towerPlace(b);
  const out = (TOWER_DOOR_FACE + TOWER_DOOR_OUT) * p.scale;
  return {
    x: p.x + Math.sin(p.yaw) * out,
    z: p.z + Math.cos(p.yaw) * out,
    yaw: p.yaw,
  };
}

/** The ground storey's windows, as angles round the axis from the door
 * (the door's at 0, its porch spanning the faces either side, banners on
 * the next): two each side, on every other face from there. */
export const GROUND_WINDOWS = [-5, -3, 3, 5].map((k) => (k * Math.PI) / 6);
/** The banners flanking the porch, likewise. */
export const GROUND_BANNERS = [-2, 2].map((k) => (k * Math.PI) / 6);
/** The ground windows' middles' height. */
export const GROUND_WINDOW_Y = 2.6;
/** How far out from the wall a window's glass is. */
export const TOWER_GLASS_OUT = 0.06;

/** The ground storey's lit windows, for the pools of light they throw at
 * night (see windowLightsOf): on the glass, at its middle, and the way it
 * looks out. */
export function towerWindowLights(
  b: Building,
): { at: [number, number, number]; out: [number, number] }[] {
  const p = towerPlace(b);
  const r =
    (towerRadiusAt(GROUND_WINDOW_Y) * Math.cos(Math.PI / 12) +
      TOWER_GLASS_OUT) *
    p.scale;
  return GROUND_WINDOWS.map((a) => {
    const yaw = a + p.yaw;
    return {
      at: [
        p.x + Math.sin(yaw) * r,
        b.y + GROUND_WINDOW_Y * p.scale,
        p.z + Math.cos(yaw) * r,
      ],
      out: [Math.sin(yaw), Math.cos(yaw)],
    };
  });
}
