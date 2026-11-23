/**
 * A ship's way across the sky, seen from above: from one berth to the
 * other, leaving and arriving along each berth's heading, turning as gently
 * as the two allow.
 *
 * The turns come from a Dubins path — the shortest way between two headed
 * points that never turns tighter than a radius R: an arc, a straight, an
 * arc. A Dubins path's curvature steps where an arc meets a straight, and
 * a ship's bank follows its curvature, so it's then smoothed into a cubic
 * B-spline (C2: the curvature, and so the bank, flows). The radius is
 * picked for the gentlest turning: a leg takes a fixed time, so a longer
 * way round means a faster ship, and what the eye reads is the turn rate,
 * speed over radius.
 *
 * Headings here are the Town's (forward is (sin ψ, cos ψ)); the Dubins
 * maths uses the usual angle from +x, φ = π/2 − ψ.
 */

export type PathPoint = { x: number; z: number };

/** A path walkable by distance along it. */
export type Path = {
  length: number;
  /** The point `s` along it and its unit tangent (s clamped to the path). */
  at(s: number, point: number[], tangent: number[]): void;
};

const TAU = Math.PI * 2;
const mod = (a: number) => ((a % TAU) + TAU) % TAU;

type Word = {
  kind: "LSL" | "RSR" | "LSR" | "RSL";
  t: number;
  p: number;
  q: number;
};

/** The CSC Dubins words that exist between the two (normalised to R = 1),
 * each as its first turn t, straight p and last turn q. */
function words(alpha: number, beta: number, d: number): Word[] {
  const sa = Math.sin(alpha);
  const sb = Math.sin(beta);
  const ca = Math.cos(alpha);
  const cb = Math.cos(beta);
  const cab = Math.cos(alpha - beta);
  const out: Word[] = [];
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, d + sa - sb);
      out.push({
        kind: "LSL",
        t: mod(-alpha + tmp),
        p: Math.sqrt(p2),
        q: mod(beta - tmp),
      });
    }
  }
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, d - sa + sb);
      out.push({
        kind: "RSR",
        t: mod(alpha - tmp),
        p: Math.sqrt(p2),
        q: mod(-beta + tmp),
      });
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      out.push({
        kind: "LSR",
        t: mod(-alpha + tmp),
        p,
        q: mod(-mod(beta) + tmp),
      });
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      out.push({ kind: "RSL", t: mod(alpha - tmp), p, q: mod(beta - tmp) });
    }
  }
  return out;
}

/** The shortest arc-straight-arc way from one headed point to another
 * turning no tighter than `r`, as points `step` apart (both ends exact),
 * and how much it turns all told (radians). Null if there's none. */
export function dubins(
  a: PathPoint & { yaw: number },
  b: PathPoint & { yaw: number },
  r: number,
  step: number,
): { length: number; turn: number; points: PathPoint[] } | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const th = Math.atan2(dz, dx);
  const phiA = Math.PI / 2 - a.yaw;
  const phiB = Math.PI / 2 - b.yaw;
  const all = words(mod(phiA - th), mod(phiB - th), Math.hypot(dx, dz) / r);
  if (all.length === 0) return null;
  const w = all.reduce((x, y) => (y.t + y.p + y.q < x.t + x.p + x.q ? y : x));
  const length = (w.t + w.p + w.q) * r;
  // Walk it: each piece in small steps, sampled every `step`.
  const turns = [w.kind[0], "S", w.kind[2]] as const;
  const lens = [w.t * r, w.p * r, w.q * r];
  let x = a.x;
  let z = a.z;
  let phi = phiA;
  const points: PathPoint[] = [{ x, z }];
  let since = 0;
  const ds = Math.min(step / 8, 0.25);
  for (let k = 0; k < 3; k++) {
    const turn = turns[k];
    let left = lens[k];
    while (left > 1e-9) {
      const h = Math.min(ds, left);
      left -= h;
      if (turn === "S") {
        x += Math.cos(phi) * h;
        z += Math.sin(phi) * h;
      } else {
        // Along the arc exactly: rotate about its centre.
        const sign = turn === "L" ? 1 : -1;
        const cx = x - Math.sin(phi) * r * sign;
        const cz = z + Math.cos(phi) * r * sign;
        phi += (sign * h) / r;
        x = cx + Math.sin(phi) * r * sign;
        z = cz - Math.cos(phi) * r * sign;
      }
      since += h;
      if (since >= step) {
        since = 0;
        points.push({ x, z });
      }
    }
  }
  // The walk ends where b is (to rounding); make the end exact.
  const last = points[points.length - 1];
  if (Math.hypot(last.x - x, last.z - z) < step * 0.5) points.pop();
  points.push({ x: b.x, z: b.z });
  return { length, turn: w.t + w.q, points };
}

/** A uniform cubic B-spline through `points` as its control polygon, its
 * ends pinned (a phantom point past each end mirrors its neighbour, so it
 * starts and ends exactly there, along the first and last legs, straight),
 * walkable by distance. */
export function bspline(points: PathPoint[]): Path {
  const n = points.length;
  const c: PathPoint[] = [
    { x: 2 * points[0].x - points[1].x, z: 2 * points[0].z - points[1].z },
    ...points,
    {
      x: 2 * points[n - 1].x - points[n - 2].x,
      z: 2 * points[n - 1].z - points[n - 2].z,
    },
  ];
  const segs = n - 1;
  const evalAt = (u: number, p: number[], d: number[]) => {
    const i = Math.min(segs - 1, Math.max(0, Math.floor(u)));
    const t = u - i;
    const [p0, p1, p2, p3] = [c[i], c[i + 1], c[i + 2], c[i + 3]];
    const v = 1 - t;
    const b0 = (v * v * v) / 6;
    const b1 = (3 * t * t * t - 6 * t * t + 4) / 6;
    const b2 = (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6;
    const b3 = (t * t * t) / 6;
    p[0] = b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x;
    p[1] = b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z;
    const d0 = -(v * v) / 2;
    const d1 = (3 * t * t - 4 * t) / 2;
    const d2 = (-3 * t * t + 2 * t + 1) / 2;
    const d3 = (t * t) / 2;
    d[0] = d0 * p0.x + d1 * p1.x + d2 * p2.x + d3 * p3.x;
    d[1] = d0 * p0.z + d1 * p1.z + d2 * p2.z + d3 * p3.z;
  };
  // Distance along it, finely, to walk it at an even pace.
  const PER = 64;
  const steps = segs * PER;
  const lens = new Float64Array(steps + 1);
  const p = [0, 0];
  const d = [0, 0];
  evalAt(0, p, d);
  let px = p[0];
  let pz = p[1];
  for (let k = 1; k <= steps; k++) {
    evalAt(k / PER, p, d);
    lens[k] = lens[k - 1] + Math.hypot(p[0] - px, p[1] - pz);
    px = p[0];
    pz = p[1];
  }
  const length = lens[steps];
  const uAt = (s: number) => {
    if (s <= 0) return 0;
    if (s >= length) return segs;
    let lo = 0;
    let hi = steps;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lens[mid] < s) lo = mid;
      else hi = mid;
    }
    return (lo + (s - lens[lo]) / (lens[hi] - lens[lo])) / PER;
  };
  return {
    length,
    at(s, point, tangent) {
      evalAt(uAt(s), point, d);
      const l = Math.hypot(d[0], d[1]) || 1;
      tangent[0] = d[0] / l;
      tangent[1] = d[1] / l;
    },
  };
}

/** Control points this far apart along the Dubins path: wide enough to
 * smooth its curvature steps over a few seconds of flight, close enough to
 * follow it within a fraction of a unit. */
const SPACING = 6;
/** The turning radii tried, and the fastest a leg may cruise. */
const R_MIN = 14;
const R_MAX = 90;
const R_STEP = 0.5;

/** The way from one berth to the other: the Dubins path with the gentlest
 * turn rate whose cruise stays under `maxCruise` (given the time the leg
 * has to cover it, `runTime`), smoothed. */
export function legPath(
  a: PathPoint & { yaw: number },
  b: PathPoint & { yaw: number },
  runTime: number,
  maxCruise: number,
  /** Round things to keep out of (the islands' rock, widened by the
   * hull's half-beam). The berths lie just outside theirs. */
  avoid: readonly { x: number; z: number; r: number }[] = [],
): Path {
  const clear = (path: Path) => {
    const p = [0, 0];
    const t = [0, 0];
    for (let s = 0; s <= path.length; s += 1) {
      path.at(s, p, t);
      for (const o of avoid) {
        if (Math.hypot(p[0] - o.x, p[1] - o.z) < o.r) return false;
      }
    }
    return true;
  };
  let best: { cost: number; path: Path } | null = null;
  for (let r = R_MIN; r <= R_MAX; r += R_STEP) {
    const d = dubins(a, b, r, SPACING);
    if (!d || d.length / runTime > maxCruise) continue;
    // Turn rate ∝ speed / radius ∝ length / radius; and a turn the wrong
    // way first (to swing round the other way) costs extra: it banks one
    // way and then the other, for no better a view.
    const net = Math.abs(
      Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)),
    );
    const cost = d.length / r + (1.5 * (d.turn - net)) / Math.PI;
    if (best && cost >= best.cost) continue;
    const path = bspline(d.points);
    if (clear(path)) best = { cost, path };
  }
  if (best) return best.path;
  // Nothing that slow and clear: the tightest turn (shortest way) will
  // have to do.
  const d = dubins(a, b, R_MIN, SPACING);
  if (!d) throw new Error("airship: no way between the docks");
  return bspline(d.points);
}
