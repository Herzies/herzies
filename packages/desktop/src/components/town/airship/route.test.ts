import { shipState, WILDS_LEG_MS, type WildsService } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { islandRadius } from "../map";
import { mapById } from "../maps";
import { berthOf } from "./berth";
import { routeOf } from "./fleet";
import {
  emptyPose,
  type Leg,
  PLANK_IN_BY_S,
  PLANK_LAID_UP_S,
  PLANK_MOVE_S,
  runAlong,
  sampleLeg,
  shipPose,
} from "./route";

const route = routeOf();
const DEG = 180 / Math.PI;

function peaks(leg: Leg) {
  let turn = 0;
  let roll = 0;
  let pitch = 0;
  let accel = 0;
  for (let i = 0; i < leg.n; i++) {
    turn = Math.max(turn, Math.abs(leg.turn[i]));
    roll = Math.max(roll, Math.abs(leg.roll[i]));
    pitch = Math.max(pitch, Math.abs(leg.pitch[i]));
    accel = Math.max(accel, Math.abs(leg.accel[i]));
  }
  return { turn: turn * DEG, roll: roll * DEG, pitch: pitch * DEG, accel };
}

describe("the speed profile", () => {
  it("starts and ends at rest and covers the path", () => {
    const T = 30;
    expect(runAlong(0, T, 9, 5)).toEqual({ s: 0, v: 0, a: 0 });
    expect(runAlong(T, T, 9, 5).s).toBeCloseTo(5 * (T - 9));
    // Continuous where the ramps meet the cruise.
    for (const t of [9, T - 9]) {
      const a = runAlong(t - 1e-6, T, 9, 5);
      const b = runAlong(t + 1e-6, T, 9, 5);
      expect(Math.abs(a.s - b.s)).toBeLessThan(1e-4);
      expect(Math.abs(a.v - b.v)).toBeLessThan(1e-4);
      expect(Math.abs(a.a - b.a)).toBeLessThan(1e-3);
    }
  });
});

describe("the route between the Sky Docks", () => {
  for (const name of ["out", "back"] as const) {
    const leg = route[name];
    it(`${name}: leaves one berth and lies at the other`, () => {
      const p = emptyPose();
      sampleLeg(leg, 0, p);
      expect(p.x).toBeCloseTo(leg.from.x, 6);
      expect(p.y).toBeCloseTo(leg.from.y, 6);
      expect(p.z).toBeCloseTo(leg.from.z, 6);
      sampleLeg(leg, WILDS_LEG_MS / 1000, p);
      expect(p.x).toBeCloseTo(leg.to.x, 6);
      expect(p.y).toBeCloseTo(leg.to.y, 6);
      expect(p.z).toBeCloseTo(leg.to.z, 6);
      const turned = Math.atan2(
        Math.sin(p.yaw - leg.to.yaw),
        Math.cos(p.yaw - leg.to.yaw),
      );
      expect(Math.abs(turned)).toBeLessThan(1e-6);
      expect(Math.abs(p.roll) + Math.abs(p.pitch)).toBeLessThan(1e-6);
    });

    it(`${name}: turns, banks and pitches like a big ship`, () => {
      const pk = peaks(leg);
      // Logged for tuning; the bounds are what reads as heavy and calm.
      console.info(
        `${name}: ${leg.length.toFixed(0)} u at ${leg.cruise.toFixed(1)} u/s; peak turn ${pk.turn.toFixed(1)}°/s, bank ${pk.roll.toFixed(1)}°, pitch ${pk.pitch.toFixed(1)}°, accel ${pk.accel.toFixed(2)} u/s²`,
      );
      expect(leg.cruise).toBeLessThan(11);
      expect(pk.turn).toBeLessThan(13);
      // The pendulum swings a touch past the 9° it's aimed at.
      expect(pk.roll).toBeLessThan(10);
      expect(pk.pitch).toBeLessThan(8);
      expect(pk.accel).toBeLessThan(2);
    });

    it(`${name}: keeps clear of both islands' rock`, () => {
      for (const id of ["home", "wilds"]) {
        const m = mapById(id);
        const [ox, , oz] = m.origin;
        let nearest = Number.POSITIVE_INFINITY;
        for (let i = 0; i < leg.n; i++) {
          const d = Math.hypot(leg.pos[i * 3] - ox, leg.pos[i * 3 + 2] - oz);
          nearest = Math.min(nearest, d);
        }
        // The hull's half-beam past the rock, at the very least.
        expect(nearest).toBeGreaterThan(islandRadius(m) + 4.9);
      }
    });

    it(`${name}: moves smoothly sample to sample`, () => {
      const a = emptyPose();
      const b = emptyPose();
      let worst = 0;
      for (let t = 0; t < WILDS_LEG_MS / 1000; t += 1 / 240) {
        sampleLeg(leg, t, a);
        sampleLeg(leg, t + 1 / 240, b);
        const v = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 240;
        worst = Math.max(worst, v);
      }
      expect(worst).toBeLessThan(leg.cruise * 1.3);
    });
  }
});

describe("shipPose", () => {
  const S = Date.UTC(2026, 10, 21, 18);
  const service: WildsService = {
    startsAt: S,
    endsAt: S + 3_600_000,
    departEveryMs: 120_000,
  };
  /** Its first run from home: half an interval less a leg in. */
  const departs = S + 60_000 - WILDS_LEG_MS;
  it("lies at each berth when docked, and never jumps", () => {
    const a = emptyPose();
    const b = emptyPose();
    for (let t = S - 5000; t < S + 300_000; t += 50) {
      shipPose(route, service, 0, t, a);
      shipPose(route, service, 0, t + 50, b);
      const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      expect(step).toBeLessThan(0.75);
    }
  });
  it("runs its gangplank out only while tied up", () => {
    const p = emptyPose();
    shipPose(route, service, 0, S + 3000, p);
    expect(p.gangplank).toBe(1);
    shipPose(route, service, 0, departs - 500, p);
    expect(p.gangplank).toBeLessThan(1);
    shipPose(route, service, 0, departs + 5000, p);
    expect(p.gangplank).toBe(0);
  });
  it("keeps its gangplank in while it's laid up, but to see passengers off", () => {
    const p = emptyPose();
    shipPose(route, null, 0, S, p);
    expect(p.gangplank).toBe(0);
    shipPose(route, service, 0, S - 1000, p);
    expect(p.gangplank).toBe(0);
    // Home from its last run: out for its passengers, then in.
    const back = shipState(service, 0, service.endsAt + 120_000);
    if (back.kind !== "docked" || back.until !== null) throw back;
    shipPose(route, service, 0, back.since + 10_000, p);
    expect(p.gangplank).toBe(1);
    shipPose(
      route,
      service,
      0,
      back.since + (PLANK_LAID_UP_S + PLANK_MOVE_S) * 1000,
      p,
    );
    expect(p.gangplank).toBe(0);
  });
  it("has its gangplank in before the last seconds are counted down", () => {
    const p = emptyPose();
    shipPose(route, service, 0, departs - PLANK_IN_BY_S * 1000 - 1600, p);
    expect(p.gangplank).toBe(1);
    shipPose(route, service, 0, departs - PLANK_IN_BY_S * 1000, p);
    expect(p.gangplank).toBe(0);
  });
  it("sits beside the dock's pier", () => {
    const home = berthOf(mapById("home"));
    expect(home).not.toBeNull();
    const p = emptyPose();
    shipPose(route, null, 0, S, p);
    expect(p.x).toBeCloseTo(home?.ship.x ?? 0, 6);
    expect(p.z).toBeCloseTo(home?.ship.z ?? 0, 6);
  });
});
