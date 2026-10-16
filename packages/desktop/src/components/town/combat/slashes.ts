import { CAST, limbSide } from "@herzies/shared";
import { MELEE_ARC, MELEE_REACH } from "@herzies/shared/combat";
import {
  CAST_RELEASE_SECONDS,
  CAST_SECONDS,
  type HerzieModel,
} from "@herzies/shared/gl";
import { Vector3 } from "three";

/**
 * A Percussionist's strikes, as the eye sees them: a swipe over the ground
 * exactly as wide and as far as the blow reaches (MELEE_REACH, MELEE_ARC) —
 * so each swing shows how close you need to be — and the stick's own trail
 * through the air above it. A pool, stepped by the frame loop, drawn by
 * vfx/SlashVFX; nothing allocates once the pool is made.
 */

export const SLASH = {
  /** How far it reaches from the herzie's middle, and either way of where
   * it faces: the blow's own reach. */
  reach: MELEE_REACH,
  arc: MELEE_ARC,
  /** Its leading edge sweeps from one end to the other between these
   * (seconds into the strike): from just after the wind-up, all of it
   * drawn a couple of frames after the blow lands — the hit is judged
   * over the whole arc at once. */
  sweepFrom: CAST_SECONDS * CAST.drawn * 1.15,
  sweepTo: CAST_RELEASE_SECONDS + 0.035,
  /** Then it burns away, from the inside out: the edge (the reach) goes
   * last. */
  fadeFrom: CAST_RELEASE_SECONDS + 0.07,
  fadeTo: CAST_RELEASE_SECONDS + 0.27,
  /** The trail: swept at the chest (a share of the herzie's height)… */
  height: 0.55,
  /** …out past the stick's tip, bigger than life, so it clears the
   * herzie's outline (a share of its height, and at most a share of the
   * reach)… */
  trailReach: 0.62,
  trailMax: 1,
  /** …and tilted along the swing, its start (the arm's side) higher, so
   * it's no thin line edge-on to the camera behind (radians). */
  tilt: 0.55,
  /** It runs where the stick went: from cocked out beside and behind its
   * shoulder (radians round from straight ahead, toward the arm's side) —
   * nearer the camera than the herzie, so the swing's start is seen whole,
   * not only through its body — round the front to the reach's far end. */
  trailFrom: 2.5,
  trailTo: MELEE_ARC,
  /** Its leading edge goes with the stick: cocked at sweepFrom, across the
   * front as the blow lands, at the far end this long after. */
  trailOn: 0.05,
} as const;

/** How far round its sweep a trail's leading edge is, `age` seconds into
 * the strike: as the stick goes. */
function trailHead(age: number): number {
  // Where straight ahead falls along it.
  const front = SLASH.trailFrom / (SLASH.trailFrom + SLASH.trailTo);
  if (age <= SLASH.sweepFrom) return 0;
  if (age < CAST_RELEASE_SECONDS) {
    const t =
      (age - SLASH.sweepFrom) / (CAST_RELEASE_SECONDS - SLASH.sweepFrom);
    // Gathering speed into the blow, as the hand does.
    return front * t * t;
  }
  const t = clamp01((age - CAST_RELEASE_SECONDS) / SLASH.trailOn);
  return front + (1 - front) * (1 - (1 - t) ** 2);
}

/** Most slashes drawn at once. */
export const MAX_SLASHES = 12;

export type Slash = {
  alive: boolean;
  herzie: HerzieModel | null;
  /** Seconds since the strike began, not counting hit stop. */
  age: number;
  /** Which side it sweeps from (see limbSide): its swinging arm's. */
  side: -1 | 1;
  /** Your own (drawn through what's in front of it), or someone else's. */
  mine: boolean;
  /** Where it's centred and which way it faces (the herzie's middle and
   * heading): followed until the blow lands, then left where it was. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Where its feet are (world height): the ground under it. */
  ground: number;
  /** How far out the trail runs (world units). */
  trail: number;
  /** 0..1: how far the swipe's leading edge has swept, and the trail's;
   * and how far they've burnt away. */
  head: number;
  trailHead: number;
  fade: number;
};

const _at = new Vector3();

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export class SlashField {
  readonly slashes: Slash[] = Array.from({ length: MAX_SLASHES }, () => ({
    alive: false,
    herzie: null,
    age: 0,
    side: 1,
    mine: false,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    ground: 0,
    trail: 1,
    head: 0,
    trailHead: 0,
    fade: 0,
  }));

  /** `herzie` strikes (call as its cast begins): a slash from its
   * swinging arm's side; `mine` if it's yours. Takes over the oldest if
   * all are in use. */
  strike(herzie: HerzieModel, mine: boolean): void {
    let slot = this.slashes.find((s) => !s.alive);
    if (!slot) {
      slot = this.slashes.reduce((a, b) => (b.age > a.age ? b : a));
    }
    slot.alive = true;
    slot.herzie = herzie;
    slot.age = 0;
    slot.side = limbSide(herzie.castingArm);
    slot.mine = mine;
    slot.head = 0;
    slot.trailHead = 0;
    slot.fade = 0;
    this.place(slot);
  }

  /** Moves every slash on by `dt` seconds. A herzie held still on its blow
   * (hit stop) holds its slash still with it. */
  step(dt: number): void {
    for (const s of this.slashes) {
      if (!s.alive) continue;
      if (!s.herzie?.stopped) s.age += dt;
      if (s.age >= SLASH.fadeTo) {
        s.alive = false;
        s.herzie = null;
        continue;
      }
      if (s.age < CAST_RELEASE_SECONDS) this.place(s);
      s.head = smooth(SLASH.sweepFrom, SLASH.sweepTo, s.age);
      s.trailHead = trailHead(s.age);
      s.fade = smooth(SLASH.fadeFrom, SLASH.fadeTo, s.age);
    }
  }

  /** Stops drawing `herzie`'s slashes (it's gone). */
  forget(herzie: HerzieModel): void {
    for (const s of this.slashes) {
      if (s.herzie === herzie) {
        s.alive = false;
        s.herzie = null;
      }
    }
  }

  private place(s: Slash) {
    const h = s.herzie;
    if (!h) return;
    const at = h.root.getWorldPosition(_at);
    s.x = at.x;
    s.y = at.y + h.height * SLASH.height;
    s.z = at.z;
    s.yaw = h.heading;
    s.ground = at.y;
    s.trail = Math.min(
      SLASH.reach * SLASH.trailMax,
      h.height * SLASH.trailReach,
    );
  }
}

export const slashField = new SlashField();
