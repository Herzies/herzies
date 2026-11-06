/**
 * The Tower, headless, one class at a time: a herzie of each class at the
 * same level clears the same floors with the real runtime, playing as the
 * class is meant to (a Percussionist wades in with its stick and Rimshot;
 * a Record Slinger keeps its distance on its two discs, with Backspin and
 * Shuffle; a Bard casts from afar and keeps itself up). It checks the
 * classes' roles hold here too: the Slinger deals the most and takes the
 * most, the Percussionist takes the least and deals clearly less.
 */
import {
  CAST_INTERVAL_MS,
  DISC_RANGE,
  discCycleMs,
  MELEE_REACH,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import { attackSpeed, RIMSHOT, SKILL_DEFS } from "@herzies/shared/skills";
import { classDef } from "@herzies/shared/boss-fight";
import { defReduction } from "@herzies/shared/stats";
import { MOB } from "@herzies/shared/tower";
import { TOWN_MAPS, TOWN_SPRINT_SPEED } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import { FightRuntime } from "../src/fight";
import type { TowerEngine } from "../src/tower";
import { type Role, realTicket } from "./herzies";

const STEP = 50;
const T0 = 20_000_000;
const LOG = false;
const ARENA = { radius: TOWN_MAPS.tower.radius, entry: TOWN_MAPS.tower.spawn };

type Run = { dps: number; takenPerS: number; ms: number; cleared: boolean; downed: boolean };

function floorRun(role: Role, level: number, floor: number, seed: number, limitMs = 180_000): Run {
  const uid = `${role}-1`;
  const f = FightRuntime.tower(
    { event: "sim", until: (T0 + 3_600_000) / 1000, floor },
    uid,
    level,
    ARENA,
    T0,
    seed,
  );
  const me = { x: ARENA.entry.x, z: ARENA.entry.z };
  f.join(uid, 1, realTicket(uid, role, level), me, T0);
  f.tune(uid, true, T0);
  const tower = f.tower as TowerEngine;
  const floorHp = tower.wireMobs().reduce((n, m) => n + m.hp, 0);
  let nextCast = 0;
  const hands: [number, number] = [0, 0];
  let rootedUntil = 0;
  let taken = 0;
  let hpWas = f.player(uid)?.hp ?? 0;
  let t = T0;
  let downed = false;
  while (t - T0 < limitMs && !tower.isCleared) {
    t += STEP;
    const p = f.player(uid);
    if (!p || p.down) {
      downed = true;
      break;
    }
    const mobs = tower.wireMobs();
    let near = mobs[0];
    let nd = Number.POSITIVE_INFINITY;
    for (const m of mobs) {
      const d = Math.hypot(m.x - me.x, m.z - me.z);
      if (d < nd) {
        nd = d;
        near = m;
      }
    }
    // Move: a tank in its face; the others at their range, backing off.
    if (near && t >= rootedUntil) {
      const want =
        role === "percussionist" ? MOB.radius + MELEE_REACH * 0.6 : role === "record_slinger" ? 10 : 14;
      const dx = near.x - me.x;
      const dz = near.z - me.z;
      const gap = nd - want;
      const step = Math.min(Math.abs(gap), (TOWN_SPRINT_SPEED * STEP) / 1000);
      if (Math.abs(gap) > 0.3) {
        me.x += (dx / nd) * step * Math.sign(gap);
        me.z += (dz / nd) * step * Math.sign(gap);
      }
      const r = Math.hypot(me.x, me.z);
      if (r > ARENA.radius - 0.6) {
        me.x *= (ARENA.radius - 0.6) / r;
        me.z *= (ARENA.radius - 0.6) / r;
      }
    }
    f.onState(uid, me.x, me.z, t);
    if (near) {
      const dx = near.x - me.x;
      const dz = near.z - me.z;
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(MOB.chest - WAVE_HAND_HEIGHT, Math.hypot(dx, dz));
      // Skills.
      if (role === "percussionist") {
        const inRing = mobs.some((m) => Math.hypot(m.x - me.x, m.z - me.z) <= RIMSHOT.radius + MOB.radius);
        if (inRing && t >= rootedUntil && f.skill(uid, "rimshot", yaw, 0, t).result === "used")
          rootedUntil = t + (SKILL_DEFS.rimshot.castMs ?? 0) + STEP;
        if (p.hp / p.maxHp < 0.5) f.skill(uid, "cymbrella", yaw, 0, t);
      } else if (role === "record_slinger") {
        if (nd <= DISC_RANGE) f.skill(uid, "backspin", yaw, pitch, t);
        if (mobs.length >= 2) f.skill(uid, "shuffle", yaw, pitch, t);
      } else if (role === "bard" && p.hp / p.maxHp < 0.7) {
        f.skill(uid, "soothing-drones", 0, 0, t);
      }
      // The basic attack, at the app's pace.
      const quick = attackSpeed(f.engine.buffsOf(uid, t), t);
      const hand = hands[0] <= hands[1] ? 0 : 1;
      const ready =
        t >= nextCast && t >= rootedUntil && (role !== "record_slinger" || hands[hand] <= t);
      const inRange =
        role === "percussionist" ? nd <= MOB.radius + MELEE_REACH : role === "record_slinger" ? nd <= DISC_RANGE : nd <= 40;
      if (ready && inRange) {
        nextCast = t + CAST_INTERVAL_MS / quick;
        if (role === "record_slinger")
          hands[hand] = t + discCycleMs(Math.max(0, nd - MOB.radius), quick);
        f.cast(uid, yaw, pitch, t);
      }
    }
    f.step(t);
    const now = f.player(uid);
    if (now) {
      if (now.hp < hpWas) taken += hpWas - now.hp;
      hpWas = now.hp;
    }
  }
  const secs = Math.max(1, (t - T0) / 1000);
  const left = tower.wireMobs().reduce((n, m) => n + m.hp, 0);
  const run = {
    dps: (floorHp - left) / secs,
    takenPerS: taken / secs,
    ms: t - T0,
    cleared: tower.isCleared,
    downed,
  };
  if (LOG)
    console.log(
      `TOWER ${role} L${level} F${floor} s${seed}: dps=${Math.round(run.dps)} taken/s=${run.takenPerS.toFixed(1)} ${Math.round(run.ms / 1000)}s cleared=${run.cleared} downed=${downed}`,
    );
  return run;
}

function mean(role: Role, level: number, floors: number[], seeds: number[]) {
  const runs = floors.flatMap((fl) => seeds.map((sd) => floorRun(role, level, fl, sd)));
  const avg = (k: "dps" | "takenPerS") => runs.reduce((n, r) => n + r[k], 0) / runs.length;
  return { dps: avg("dps"), taken: avg("takenPerS"), downs: runs.filter((r) => r.downed).length };
}

describe("the Tower, simulated by class", () => {
  it("the Slinger deals the most and takes the most; the Percussionist the reverse", () => {
    const level = 30;
    const floors = [15, 22];
    const seeds = [1, 2, 3];
    const slinger = mean("record_slinger", level, floors, seeds);
    const tank = mean("percussionist", level, floors, seeds);
    const bard = mean("bard", level, floors, seeds);
    if (LOG) console.log("TOWER MEAN", JSON.stringify({ slinger, tank, bard }));
    expect(slinger.dps).toBeGreaterThan(tank.dps);
    expect(tank.dps / slinger.dps).toBeLessThan(0.8);
    expect(bard.dps).toBeLessThan(slinger.dps);
  }, 120_000);
});

describe("how much each class can take", () => {
  /** Effective health: how much raw damage a herzie soaks before it's
   * down, through its Def (a Percussionist's counting more). */
  const ehp = (role: Role, level: number) => {
    const t = realTicket("x", role, level);
    const def = classDef(t.cls, t.st?.[5] ?? 0);
    return (t.hp?.maxHp ?? 0) / (1 - defReduction(def));
  };

  it("a Percussionist takes far more than a Slinger; a Bard about as much as a Slinger", () => {
    for (const level of [10, 20, 30]) {
      const slinger = ehp("record_slinger", level);
      const tank = ehp("percussionist", level);
      const bard = ehp("bard", level);
      if (LOG) console.log(`EHP L${level}`, { slinger, tank, bard });
      expect(tank / slinger, `level ${level}`).toBeGreaterThan(1.5);
      expect(Math.abs(bard / slinger - 1), `level ${level}`).toBeLessThan(0.15);
    }
  });
});
