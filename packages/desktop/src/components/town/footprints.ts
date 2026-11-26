import { SNOW_DEPTH, SNOW_DEPTH_TRODDEN, snowCovers } from "./ambient";
import { cellAt, groundBlend, type TownMap, terrainAt } from "./map";

// Prints in the snow: each herzie walking through it leaves a trail (its
// own Trail), dropped into one shared pool that's drawn in one go (see
// Particles). Each print stays a second, then fades.

/** Ground covered between a walker's prints, in world units. */
export const FOOTPRINT_EVERY = 0.42;
/** How long a print stays, fading out over its second half. */
export const FOOTPRINT_LIFE = 2.4;
/** Further than this in one step is a jump (a respawn, a portal): no
 * prints in between. */
const TELEPORT = 2;

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

/** Whether `snow` (0–1, as uSnow) is drawn lying at (x, z) on the ground:
 * on grass or a path, not water, and in one of the drifts rather than a
 * bare patch between (see `inSeason`, trodden: a path's snow is thinner
 * and patchier than the grass's). */
function snowUnderfoot(
  map: TownMap,
  x: number,
  z: number,
  snow: number,
): boolean {
  const ground = terrainAt(map, ...cellAt(map, x, z));
  if (ground !== "." && ground !== "g") return false;
  // The ground's colour, as its mesh paints it (Ground's groundPoint): gravel
  // where it's most of the dry ground, earth down the banks; the shader only
  // lays the grass's deeper snow on what's green.
  const { grass, gravel, wet } = groundBlend(map, x, z);
  const green = gravel > grass || wet > 0.45 ? 0 : 1;
  const depth =
    snow * (SNOW_DEPTH_TRODDEN + (SNOW_DEPTH - SNOW_DEPTH_TRODDEN) * green);
  return snowCovers(x, z, depth);
}

/** One herzie's way through the snow. */
export class Trail {
  private last: { x: number; z: number } | null = null;
  /** Where its walk cycle was at `last` (see HerzieModel's anim). */
  private lastPhase = 0;
  private yaw = 0;
  private foot = 1;
  /** How far either side of its path its feet come down (see HerzieModel's
   * footSpread): two lines of prints, left foot, right foot. 0: it hops,
   * leaving one bigger print down the middle where each hop lands. */
  constructor(public spread: number) {}

  /** Where it is now and how far through its walk cycle (`phase`, 0–1,
   * HerzieModel's anim.walkPhase): a walker drops a print into `prints`
   * every so far walked, a hopper one each time it lands (twice a cycle,
   * see HerzieModel's animateBody); either only where snow's lying, as
   * deep as `snow` (0–1). */
  step(
    map: TownMap,
    prints: Footprints,
    x: number,
    y: number,
    z: number,
    snow: number,
    t: number,
    phase: number,
  ) {
    const last = this.last;
    const lastPhase = this.lastPhase;
    this.lastPhase = phase;
    if (!last || snow <= 0) {
      this.last = { x, z };
      return;
    }
    const moved = Math.hypot(x - last.x, z - last.z);
    if (moved > TELEPORT) {
      this.last = { x, z };
      return;
    }
    const print = (px: number, pz: number, size: number) => {
      if (!snowUnderfoot(map, px, pz, snow)) return;
      prints.add({
        x: px,
        y,
        z: pz,
        yaw: this.yaw,
        size,
        depth: Math.min(1, snow),
        born: t,
      });
    };
    if (this.spread === 0) {
      // Hopping: a print each time the cycle passes a landing (0 or ½),
      // where along this frame's way it was then.
      if (moved > 1e-4) this.yaw = Math.atan2(x - last.x, z - last.z);
      const ran = (((phase - lastPhase) % 1) + 1) % 1;
      if (ran > 0) {
        const first = Math.floor(lastPhase * 2) + 1;
        const end = Math.floor((lastPhase + ran) * 2);
        for (let k = first; k <= end; k++) {
          const f = (k / 2 - lastPhase) / ran;
          print(last.x + (x - last.x) * f, last.z + (z - last.z) * f, 2);
        }
      }
      this.last = { x, z };
      return;
    }
    if (moved < FOOTPRINT_EVERY) return;
    const dx = (x - last.x) / moved;
    const dz = (z - last.z) / moved;
    this.yaw = Math.atan2(dx, dz);
    // Every print along the way since the last (more than one in a slow
    // frame), so they stay evenly spaced.
    let along = FOOTPRINT_EVERY;
    for (; along <= moved; along += FOOTPRINT_EVERY) {
      this.foot = -this.foot;
      const side = this.foot * this.spread;
      // Off to the side of the way it's going.
      print(
        last.x + dx * along - dz * side,
        last.z + dz * along + dx * side,
        1,
      );
    }
    along -= FOOTPRINT_EVERY;
    this.last = { x: last.x + dx * along, z: last.z + dz * along };
  }
}

/** Every print in the snow on the island you're on. */
export const footprints = new Footprints(160);
