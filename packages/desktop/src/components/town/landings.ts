// A puff of dust where a herzie lands from a jump (see Particles'
// LandingDust): each landing dropped into one shared pool, drawn in one
// go. Each puff is a ring of specks skimming out low and fading.

/** How many puffs can be in the air at once; the oldest goes first. */
export const LAND_PUFFS = 8;
/** Specks to a puff, and how long a puff lasts (s). */
export const SPECKS = 10;
export const PUFF_LIFE = 0.55;

export type Puff = { x: number; y: number; z: number; born: number };

export const landings = {
  puffs: Array.from(
    { length: LAND_PUFFS },
    (): Puff => ({
      x: 0,
      y: 0,
      z: 0,
      born: Number.NEGATIVE_INFINITY,
    }),
  ),
  next: 0,
};

/** A herzie's feet just hit the ground here, at `t` (the Town's clock). */
export function landed(x: number, y: number, z: number, t: number) {
  const p = landings.puffs[landings.next];
  p.x = x;
  p.y = y;
  p.z = z;
  p.born = t;
  landings.next = (landings.next + 1) % LAND_PUFFS;
}
