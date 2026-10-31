import { cellAt, type TownMap, terrainAt } from "./map";

// Prints in the snow: each herzie walking through it leaves a trail (its
// own Trail), dropped into one shared pool that's drawn in one go (see
// Particles). Each print stays a second, then fades.

/** Ground covered between prints, in world units. */
export const FOOTPRINT_EVERY = 0.42;
/** How long a print stays, fading out over its second half. */
export const FOOTPRINT_LIFE = 2.4;
/** Further than this in one step is a jump (a respawn, a portal): no
 * prints in between. */
const TELEPORT = 2;
/** Less snow than this lying, and there's nothing to press into. */
const ENOUGH_SNOW = 0.3;

export type Footprint = {
  x: number;
  y: number;
  z: number;
  /** Which way it points (radians about y). */
  yaw: number;
  /** A hop's print is bigger than a foot's. */
  size: number;
  /** How deep: how much snow there was. */
  depth: number;
  born: number;
};

/** The prints, a ring of them: the oldest go first. */
export class Footprints {
  readonly prints: Footprint[] = [];
  /** Bumped with every print, so the drawing knows to catch up. */
  version = 0;
  private next = 0;
  constructor(readonly capacity: number) {}

  add(p: Footprint) {
    if (this.prints.length < this.capacity) this.prints.push(p);
    else this.prints[this.next] = p;
    this.next = (this.next + 1) % this.capacity;
    this.version++;
  }

  /** Those still to be seen at time `t`. */
  live(t: number): Footprint[] {
    return this.prints.filter((p) => t - p.born < FOOTPRINT_LIFE);
  }
}

/** One herzie's way through the snow. */
export class Trail {
  private last: { x: number; z: number } | null = null;
  private foot = 1;
  /** How far either side of its path its feet come down (see HerzieModel's
   * footSpread): two lines of prints, left foot, right foot. 0: it hops,
   * leaving one line of bigger prints down the middle. */
  constructor(public spread: number) {}

  /** Where it is now: drops a print into `prints` every so far walked,
   * where there's `snow` lying (0–1) on grass or a path. */
  step(
    map: TownMap,
    prints: Footprints,
    x: number,
    y: number,
    z: number,
    snow: number,
    t: number,
  ) {
    const last = this.last;
    if (!last || snow < ENOUGH_SNOW) {
      this.last = { x, z };
      return;
    }
    const moved = Math.hypot(x - last.x, z - last.z);
    if (moved > TELEPORT) {
      this.last = { x, z };
      return;
    }
    if (moved < FOOTPRINT_EVERY) return;
    const dx = (x - last.x) / moved;
    const dz = (z - last.z) / moved;
    // Every print along the way since the last (more than one in a slow
    // frame), so they stay evenly spaced.
    let along = FOOTPRINT_EVERY;
    for (; along <= moved; along += FOOTPRINT_EVERY) {
      this.foot = -this.foot;
      const side = this.foot * this.spread;
      // Off to the side of the way it's going.
      const px = last.x + dx * along - dz * side;
      const pz = last.z + dz * along + dx * side;
      const ground = terrainAt(map, ...cellAt(map, px, pz));
      if (ground !== "." && ground !== "g") continue;
      prints.add({
        x: px,
        y,
        z: pz,
        yaw: Math.atan2(dx, dz),
        size: this.spread > 0 ? 1 : 2,
        depth: Math.min(1, snow),
        born: t,
      });
    }
    along -= FOOTPRINT_EVERY;
    this.last = { x: last.x + dx * along, z: last.z + dz * along };
  }
}

/** Every print in the snow on the island you're on. */
export const footprints = new Footprints(160);
