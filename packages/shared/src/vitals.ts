/**
 * Herzie health: how much there is, how it comes back, and what a respawn
 * gives. Pure and free of React and the DOM, so the Worker, the Deno edge
 * functions and the desktop all read it the same way. The SQL in
 * `00101_herzie_health.sql` mirrors {@link effectiveHp}; keep them in step.
 *
 * Health is stored lazily: the row holds the HP at the moment it was last
 * written (`hp`, `hpAt`) and everything after that is computed, so regen
 * costs nothing and works while the app is closed. `hp === null` means full.
 */
import { STAT_TUNING } from "./stats.js";

/** Max HP at a given level, with this many points in Stamina. Mirrors
 * `herzie_max_hp` in `00108_stat_points.sql`. */
export function maxHp(level: number, stamina = 0): number {
  const l = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  const s = Number.isFinite(stamina) ? Math.max(0, Math.floor(stamina)) : 0;
  return 100 + 5 * l + STAT_TUNING.hpPerStamina * s;
}

/** No regen for this long after the last write (damage), so a fight never
 * heals you between hits. */
export const HP_REGEN_DELAY_MS = 5_000;
/** Out of combat, anywhere: a full bar takes about five minutes. */
export const HP_REGEN_FRACTION_PER_SEC = 1 / 300;
/** Seated on a bench: a full bar takes about ninety seconds. */
export const BENCH_REGEN_MULT = 300 / 90;
/** A respawn brings you back with half your health. */
export const RESPAWN_FRACTION = 0.5;
/** Under this fraction the cave asks you to confirm before going in. */
export const LOW_HP_FRACTION = 0.5;

/** The stored side of a herzie's health. */
export type VitalsRow = {
  /** HP when last written, or `null` for full. */
  hp: number | null;
  /** When `hp` was written (ms since the epoch). */
  hpAt: number | null;
  /** Knocked out: no regen until a respawn. */
  down: boolean;
};

/** HP right now: the stored value plus regen since the last write. */
export function effectiveHp(row: VitalsRow, max: number, now: number): number {
  if (row.down) return 0;
  if (row.hp === null || row.hpAt === null) return max;
  const quietMs = now - row.hpAt - HP_REGEN_DELAY_MS;
  if (quietMs <= 0) return Math.min(max, Math.max(0, row.hp));
  const regen = (quietMs / 1000) * max * HP_REGEN_FRACTION_PER_SEC;
  return Math.min(max, Math.max(0, row.hp) + regen);
}

/** What a respawn restores. */
export function respawnHp(max: number): number {
  return Math.ceil(max * RESPAWN_FRACTION);
}

/** Extra HP from resting on a bench for `seconds` (the base regen is
 * already counted by {@link effectiveHp}). */
export function benchBonusHp(max: number, seconds: number): number {
  return (
    Math.max(0, seconds) *
    max *
    HP_REGEN_FRACTION_PER_SEC *
    (BENCH_REGEN_MULT - 1)
  );
}

/** The vitals a client or the Town server is handed (a ticket claim and the
 * `town-vitals` reply). `hpAt` is ms since the epoch. */
export type Vitals = {
  hp: number;
  maxHp: number;
  /** Stored HP and its stamp, so a client can keep counting regen itself. */
  stored: number | null;
  hpAt: number | null;
  down: boolean;
};

/** Build {@link Vitals} from a row at `now`. */
export function vitalsOf(
  row: VitalsRow,
  level: number,
  stamina: number,
  now: number,
): Vitals {
  const max = maxHp(level, stamina);
  return {
    hp: effectiveHp(row, max, now),
    maxHp: max,
    stored: row.hp,
    hpAt: row.hpAt,
    down: row.down,
  };
}

/** A client's live HP from the vitals it was last given. */
export function liveHp(v: Vitals, now: number): number {
  return effectiveHp(
    { hp: v.stored, hpAt: v.hpAt, down: v.down },
    v.maxHp,
    now,
  );
}
