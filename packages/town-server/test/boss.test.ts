import { TOWN_WALK_SPEED } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import {
  BossEngine,
  type BossEvent,
  type BossPlayer,
  covers,
  MAX_HIT_FRACTION,
  MAX_TELEGRAPHS,
  MIN_WINDUP_MS,
  phaseFor,
  type Telegraph,
  TUNING,
} from "../src/boss";
import { PositionHistory } from "../src/history";

const STATS = { sonicPower: 0, critChance: 0, critDamage: 0 };
const T0 = 1_000_000;

/** A player who stays where they are. */
const still = (uid: string, x: number, z: number, maxHp = 200): BossPlayer => ({
  uid,
  alive: true,
  maxHp,
  posAt: () => ({ x, z }),
});

function engine(hp = 1000, maxHp = 1000, seed = 1) {
  return new BossEngine({ hp, maxHp, seed, now: T0 });
}

/** Run to `until` in 50ms steps, collecting events. */
function run(
  e: BossEngine,
  from: number,
  until: number,
  players: BossPlayer[],
): BossEvent[] {
  const out: BossEvent[] = [];
  for (let t = from; t <= until; t += 50) out.push(...e.update(t, players));
  return out;
}

const telegraphs = (ev: BossEvent[]) =>
  ev.flatMap((x) => (x.t === "telegraph" ? [x.telegraph] : []));

describe("tuning invariants", () => {
  it("every telegraph gives at least the minimum windup", () => {
    expect(TUNING.slam.windupMs).toBeGreaterThanOrEqual(MIN_WINDUP_MS);
    expect(TUNING.ring.windupMs).toBeGreaterThanOrEqual(MIN_WINDUP_MS);
  });

  it("no single hit takes more than the damage budget", () => {
    expect(TUNING.slam.fraction).toBeLessThanOrEqual(MAX_HIT_FRACTION);
    expect(TUNING.ring.fraction).toBeLessThanOrEqual(MAX_HIT_FRACTION);
  });

  it("a slam can be left on foot within its windup, with time to react", () => {
    const REACTION_MS = 600;
    const escape = (TUNING.slam.radius / TOWN_WALK_SPEED) * 1000;
    expect(escape + REACTION_MS).toBeLessThanOrEqual(TUNING.slam.windupMs);
  });

  it("the ring's safe middle can be reached from the far wall in its windup", () => {
    const REACTION_MS = 600;
    const { x, z } = TUNING.boss;
    // The farthest a herzie can stand from the boss inside the room.
    const farthest = Math.hypot(x, z) + TUNING.roomRadius;
    const walk = ((farthest - TUNING.ring.inner) / TOWN_WALK_SPEED) * 1000;
    expect(walk + REACTION_MS).toBeLessThanOrEqual(TUNING.ring.windupMs);
  });

  it("the ring's safe middle is wider than the boss", () => {
    expect(TUNING.ring.inner).toBeGreaterThan(TUNING.boss.radius + 1);
  });

  it("phases get busier, and shapes are capped", () => {
    expect(TUNING.phases[2].everyMs).toBeLessThan(TUNING.phases[1].everyMs);
    expect(TUNING.phases[3].everyMs).toBeLessThan(TUNING.phases[2].everyMs);
    expect(MAX_TELEGRAPHS).toBeLessThanOrEqual(4);
  });
});

describe("phases", () => {
  it("follow the boss's health", () => {
    expect(phaseFor(1000, 1000)).toBe(1);
    expect(phaseFor(660, 1000)).toBe(2);
    expect(phaseFor(330, 1000)).toBe(3);
    expect(phaseFor(1, 1000)).toBe(3);
  });
});

describe("covers", () => {
  const circle: Telegraph = {
    id: 1,
    kind: "circle",
    x: 0,
    z: 0,
    r: 3,
    inner: 0,
    at: 0,
    hitAt: 0,
    fraction: 0.2,
  };
  it("a circle covers its disc", () => {
    expect(covers(circle, 2.9, 0)).toBe(true);
    expect(covers(circle, 3.1, 0)).toBe(false);
  });
  it("a ring leaves its middle safe", () => {
    const ring = { ...circle, kind: "ring" as const, r: 15, inner: 6.5 };
    expect(covers(ring, 3, 0)).toBe(false);
    expect(covers(ring, 8, 0)).toBe(true);
  });
});

describe("attacks", () => {
  it("waits out the opening, then telegraphs a slam on a player", () => {
    const e = engine();
    const p = still("a", 3, 4);
    expect(telegraphs(run(e, T0, T0 + TUNING.openingMs - 100, [p]))).toEqual([]);
    const tgs = telegraphs(run(e, T0 + TUNING.openingMs - 50, T0 + TUNING.openingMs + 100, [p]));
    expect(tgs).toHaveLength(1);
    expect(tgs[0]).toMatchObject({ kind: "circle", x: 3, z: 4 });
    expect(tgs[0].hitAt - tgs[0].at).toBeGreaterThanOrEqual(MIN_WINDUP_MS);
  });

  it("hits a player who stays put, for a fraction of their max HP", () => {
    const e = engine();
    const p = still("a", 0, 5, 300);
    const ev = run(e, T0, T0 + 6_000, [p]);
    const resolve = ev.find((x) => x.t === "resolve");
    expect(resolve).toBeTruthy();
    if (resolve?.t !== "resolve") return;
    expect(resolve.hits).toEqual([{ uid: "a", damage: 60 }]);
  });

  it("misses a player who walked out of the zone", () => {
    const e = engine();
    let leaving = false;
    const p: BossPlayer = {
      uid: "a",
      alive: true,
      maxHp: 200,
      posAt: (t) => ({ x: leaving && t > T0 + 3_300 ? 20 : 0, z: 5 }),
    };
    const ev: BossEvent[] = [];
    for (let t = T0; t <= T0 + 6_000; t += 50) {
      if (t > T0 + 3_200) leaving = true;
      ev.push(...e.update(t, [p]));
    }
    const resolve = ev.find((x) => x.t === "resolve");
    expect(resolve?.t === "resolve" && resolve.hits).toEqual([]);
  });

  it("favours the dodger: only inside a moment ago, not now, is no hit", () => {
    const e = engine();
    const p: BossPlayer = {
      uid: "a",
      alive: true,
      maxHp: 200,
      // Standing in the zone only at the instant it lands.
      posAt: (t) => ({ x: t >= T0 + TUNING.openingMs + TUNING.slam.windupMs - 10 ? 0 : 30, z: 5 }),
    };
    const ev = run(e, T0, T0 + 6_000, [p]);
    const resolve = ev.find((x) => x.t === "resolve");
    expect(resolve?.t === "resolve" && resolve.hits).toEqual([]);
  });

  it("doesn't chain hits: a hit herzie is safe for a moment", () => {
    const e = engine(300, 1000); // phase 3: busy
    const p = still("a", 0, 5, 1000);
    const ev = run(e, T0, T0 + 20_000, [p]);
    const hits = ev
      .flatMap((x) => (x.t === "resolve" ? x.hits : []))
      .filter((h) => h.uid === "a");
    expect(hits.length).toBeGreaterThan(1);
    const resolves = ev.filter((x) => x.t === "resolve");
    expect(resolves.length).toBeGreaterThanOrEqual(hits.length);
  });

  it("never targets or hurts someone who just arrived", () => {
    const e = engine();
    e.noteSpawn("a", T0 + 2_500);
    const p = still("a", 0, 5);
    const ev = run(e, T0 + 2_500, T0 + 4_400, [p]);
    expect(telegraphs(ev)).toEqual([]);
  });

  it("skips fallen players, and aims at nobody when empty", () => {
    const e = engine();
    const dead = { ...still("a", 0, 5), alive: false };
    expect(telegraphs(run(e, T0, T0 + 8_000, [dead]))).toEqual([]);
    expect(telegraphs(run(e, T0 + 8_050, T0 + 9_000, []))).toEqual([]);
  });

  it("keeps few shapes on the floor at once", () => {
    const e = engine(300, 1000);
    const players = Array.from({ length: 12 }, (_, i) =>
      still(`p${i}`, (i % 6) * 2 - 5, Math.floor(i / 6) * 4),
    );
    let max = 0;
    for (let t = T0; t < T0 + 30_000; t += 50) {
      e.update(t, players);
      max = Math.max(max, e.active.length);
    }
    expect(max).toBeLessThanOrEqual(MAX_TELEGRAPHS);
  });

  it("is deterministic for a seed", () => {
    const run1 = run(engine(500, 1000, 7), T0, T0 + 30_000, [still("a", 1, 1), still("b", -3, 5)]);
    const run2 = run(engine(500, 1000, 7), T0, T0 + 30_000, [still("a", 1, 1), still("b", -3, 5)]);
    expect(run1).toEqual(run2);
  });
});

describe("casts", () => {
  /** Aim from (x, z) at the boss. */
  const aim = (x: number, z: number) => ({
    yaw: Math.atan2(TUNING.boss.x - x, TUNING.boss.z - z),
    // From the hand's height to the boss's chest.
    pitch: Math.atan2(
      TUNING.boss.chest - 1.2,
      Math.hypot(TUNING.boss.x - x, TUNING.boss.z - z),
    ),
  });

  it("lands a cast on the boss after the wave's flight", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    expect(e.cast("a", { x: 0, z: 8 }, yaw, pitch, STATS, T0)).toBe("hit");
    expect(e.update(T0 + 10, []).filter((x) => x.t === "hit")).toEqual([]);
    const ev = e.update(T0 + 1_000, []);
    const hit = ev.find((x) => x.t === "hit");
    expect(hit?.t === "hit" && hit.damage).toBeGreaterThan(80);
    expect(e.hp).toBeLessThan(1000);
  });

  it("misses when aimed away", () => {
    const e = engine();
    const { pitch } = aim(0, 8);
    expect(e.cast("a", { x: 0, z: 8 }, 0, pitch, STATS, T0)).toBe("miss");
  });

  it("allows a short burst, then holds to the pace; a miss costs a cast too", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    const at = { x: 0, z: 8 };
    expect(e.cast("a", at, 0, pitch, STATS, T0)).toBe("miss");
    expect(e.cast("a", at, yaw, pitch, STATS, T0 + 10)).toBe("hit");
    expect(e.cast("a", at, yaw, pitch, STATS, T0 + 20)).toBe("cooldown");
    // The pace refills: one more cast every 300 ms.
    expect(
      e.cast("a", at, yaw, pitch, STATS, T0 + 20 + TUNING.castEveryMs),
    ).toBe("hit");
  });

  it("never drops a cast at the client's own pace, even with jitter", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    const at = { x: 0, z: 8 };
    let t = T0;
    for (let i = 0; i < 200; i++) {
      // The client casts every 340 ms; the network adds up to 120 ms of
      // jitter either way.
      t += 340 + (i % 3 === 0 ? 120 : i % 3 === 1 ? -120 : 0);
      expect(e.cast("a", at, yaw, pitch, STATS, t), `cast ${i}`).not.toBe(
        "cooldown",
      );
    }
  });

  it("forgives a little aim, as the client's assist does", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 8);
    expect(e.cast("a", { x: 0, z: 8 }, yaw + 0.03, pitch, STATS, T0)).toBe("hit");
  });

  it("is out of reach past the range", () => {
    const e = engine();
    const { yaw, pitch } = aim(0, 60);
    expect(e.cast("a", { x: 0, z: 60 }, yaw, pitch, STATS, T0)).toBe("miss");
  });

  it("kills once, announces it once, and stops attacking", () => {
    const e = engine(50, 1000);
    const { yaw, pitch } = aim(0, 8);
    e.cast("a", { x: 0, z: 8 }, yaw, pitch, { ...STATS, sonicPower: 100 }, T0);
    e.cast("b", { x: 0, z: 8 }, yaw, pitch, STATS, T0);
    const ev = e.update(T0 + 1_500, [still("a", 0, 8)]);
    expect(ev.filter((x) => x.t === "killed")).toHaveLength(1);
    expect(e.dead).toBe(true);
    expect(e.hp).toBe(0);
    expect(e.cast("c", { x: 0, z: 8 }, yaw, pitch, STATS, T0 + 2_000)).toBe("dead");
    expect(telegraphs(run(e, T0 + 2_000, T0 + 10_000, [still("a", 0, 8)]))).toEqual([]);
  });

  it("announces a change of phase and gives a breather", () => {
    const e = engine(670, 1000);
    const { yaw, pitch } = aim(0, 8);
    e.cast("a", { x: 0, z: 8 }, yaw, pitch, { ...STATS, sonicPower: 200 }, T0);
    const ev = e.update(T0 + 1_500, []);
    expect(ev.some((x) => x.t === "phase" && x.phase === 2)).toBe(true);
  });
});

describe("position history", () => {
  it("interpolates and forgets", () => {
    const h = new PositionHistory();
    h.record("a", 0, 0, 0);
    h.record("a", 100, 10, 0);
    expect(h.at("a", 50)).toEqual({ x: 5, z: 0 });
    expect(h.at("a", 500)).toEqual({ x: 10, z: 0 });
    expect(h.at("a", -50)).toEqual({ x: 0, z: 0 });
    expect(h.at("nobody", 0)).toBeNull();
    for (let t = 200; t <= 5_000; t += 100) h.record("a", t, t, 0);
    expect(h.at("a", 3_000)?.x).toBeGreaterThan(2_000);
    h.forget("a");
    expect(h.at("a", 0)).toBeNull();
  });
});
