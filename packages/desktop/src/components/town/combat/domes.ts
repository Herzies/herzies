import { skillValue } from "@herzies/shared";
import {
  DOME,
  type Dome,
  domeRadiusAt,
  insideDome,
} from "@herzies/shared/combat";
import { drawDelayMs } from "./drawDelay";

/**
 * Cymbrella domes as this client shows them: where each stands, whose it
 * is, and the hits it turned away (for the ripples). Times are
 * performance.now() ms. The server judges the dome; this only draws it,
 * from the same numbers (DOME), so its edge is where the shove is.
 */

/** A dome on screen: its growth starts at `from` (a beat after it was
 * cast, `castAt`: see {@link DOME_SHOW_DELAY_MS}). */
export type ShownDome = Dome & {
  by: number;
  castAt: number;
  /** Hits it turned away: where they came from, and when. */
  hits: { x: number; z: number; at: number }[];
};

/** How long after a cast a dome starts to grow here, at the least: about
 * how far behind the server mobs are drawn (drawDelayMs), so its edge
 * reaches each mob just as that mob's shove is drawn. Until then it's a
 * small shell round its caster, so the press is felt at once. */
export const DOME_SHOW_DELAY_MS = 150;
/** How long a dome takes to fade once it's down. */
export const DOME_FADE_MS = 220;

export const domes: ShownDome[] = [];

/** A Cymbrella went up at (x, z) at `at`, by entity `by`, at `level`. */
export function addDome(cast: {
  by: number;
  x: number;
  z: number;
  level: number;
  at: number;
}): void {
  const from = cast.at + Math.max(DOME_SHOW_DELAY_MS, drawDelayMs());
  const ms = Math.round(skillValue("cymbrella", cast.level) * 1000);
  // One per caster: a new one replaces theirs.
  for (let i = domes.length - 1; i >= 0; i--)
    if (domes[i].by === cast.by) domes.splice(i, 1);
  domes.push({
    x: cast.x,
    z: cast.z,
    from,
    until: from + ms,
    by: cast.by,
    castAt: cast.at,
    hits: [],
  });
  prune(cast.at);
}

/** Takes down entity `by`'s dome (one the server refused). */
export function removeDome(by: number): void {
  for (let i = domes.length - 1; i >= 0; i--)
    if (domes[i].by === by) domes.splice(i, 1);
}

/** The dome (still standing) over (x, z) at `now`, if any. */
export function domeOver(x: number, z: number, now: number): ShownDome | null {
  return insideDome(domes, x, z, now);
}

/** Something was turned away from whoever stands at (x, z): a ripple on
 * the dome over them, spreading from the side it came from (fx, fz). */
export function noteDomeHit(
  x: number,
  z: number,
  fx: number,
  fz: number,
  now: number,
): ShownDome | null {
  const d = domeOver(x, z, now) ?? nearest(x, z, now);
  if (!d) return null;
  d.hits.push({ x: fx, z: fz, at: now });
  if (d.hits.length > 4) d.hits.shift();
  return d;
}

/** How big a dome is drawn at `now`: a shell round its caster until it
 * grows, a touch past its size as it lands (then settling), and shrinking
 * away once it's down. */
export function shownRadius(d: ShownDome, now: number): number {
  if (now < d.from) {
    const u = Math.min(1, (now - d.castAt) / 90);
    return DOME.startRadius * (1 - (1 - u) ** 2);
  }
  if (now >= d.until) {
    const u = Math.min(1, (now - d.until) / DOME_FADE_MS);
    return DOME.radius * (1 - u * u * 0.35);
  }
  const u = Math.min(1, (now - d.from) / DOME.growMs);
  if (u >= 1) return DOME.radius;
  // The server's ease, with a small overshoot on top that settles by the
  // end of the growth: the shove reads as weight, the edge as solid.
  const settle = Math.sin(u * Math.PI) * 0.06 * u;
  return domeRadiusAt(d, now) * (1 + settle);
}

/** Forgets domes long gone. */
export function prune(now: number): void {
  for (let i = domes.length - 1; i >= 0; i--)
    if (now > domes[i].until + DOME_FADE_MS) domes.splice(i, 1);
}

/** Everything gone at once (leaving the room). */
export function clearDomes(): void {
  domes.length = 0;
}

function nearest(x: number, z: number, now: number): ShownDome | null {
  let best: ShownDome | null = null;
  let bestD = DOME.radius + 1.5;
  for (const d of domes) {
    if (now < d.castAt || now >= d.until) continue;
    const dist = Math.hypot(x - d.x, z - d.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}
