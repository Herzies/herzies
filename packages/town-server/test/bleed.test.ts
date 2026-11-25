import { WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import {
  bleedEveryMs,
  FORBIDDEN_FREQUENCY,
  SILENCIO,
  SKILL_DEFS,
} from "@herzies/shared/skills";
import { MOB } from "@herzies/shared/tower";
import { TOWN_MAPS } from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import { BossEngine, type BossEvent, TUNING } from "../src/boss";
import { Bleeds } from "../src/bleed";
import { TowerEngine, type TowerEvent } from "../src/tower";

const T0 = 3_000_000;
const STATS = { sonicPower: 0, critChance: 100, critDamage: 50 };
const LASTS = SKILL_DEFS["forbidden-frequency"].durationMs ?? 0;
const disc = (at: number, by = "a", level = 1) => ({
  at,
  by,
  key: "t",
  level,
  stats: STATS,
});

describe("Forbidden Frequency's bleeds", () => {
  it("stack to three on a target, each hit starting the time over", () => {
    const b = new Bleeds(LASTS);
    for (let i = 0; i < 5; i++) {
      const bleed = b.stack(disc(T0 + i * 1_000), T0 + i * 1_000);
      expect(bleed.stacks).toBe(Math.min(i + 1, FORBIDDEN_FREQUENCY.maxStacks));
      expect(bleed.until).toBe(T0 + i * 1_000 + LASTS);
    }
  });

  it("are the newest thrower's, at the stronger level", () => {
    const b = new Bleeds(LASTS);
    b.stack(disc(T0, "a", 9), T0);
    const bleed = b.stack(disc(T0 + 500, "b", 2), T0 + 500);
    expect(bleed).toMatchObject({ by: "b", level: 9, stacks: 2 });
  });

  it("hit once a tickMs on one stack while they run, then end", () => {
    const b = new Bleeds(LASTS);
    b.stack(disc(T0), T0);
    const ticks = b.ticks(T0 + LASTS + 5_000);
    expect(ticks.map((t) => t.at)).toEqual(
      Array.from(
        { length: LASTS / FORBIDDEN_FREQUENCY.tickMs },
        (_, i) => T0 + (i + 1) * FORBIDDEN_FREQUENCY.tickMs,
      ),
    );
    expect(b.keys()).toEqual([]);
  });

  it("hit faster with each stack, not harder", () => {
    const count = (stacks: number) => {
      const b = new Bleeds(LASTS);
      for (let i = 0; i < stacks; i++) b.stack(disc(T0), T0);
      return b.ticks(T0 + 10_000).length;
    };
    expect(count(1)).toBe(10);
    expect(count(2)).toBe(20);
    // A third of a second each: 30 in 10 s, give or take the last.
    expect(Math.abs(count(3) - 30)).toBeLessThanOrEqual(1);
  });

  it("land after their flight, and a fallen target's goes", () => {
    const b = new Bleeds(LASTS);
    b.throw(disc(T0 + 300));
    expect(b.landed(T0 + 200)).toEqual([]);
    expect(b.landed(T0 + 300)).toHaveLength(1);
    b.stack(disc(T0 + 300), T0 + 300);
    expect(b.end("t")).toBeDefined();
    expect(b.ticks(T0 + 5_000)).toEqual([]);
  });
});

describe("Forbidden Frequency on the boss", () => {
  it("bleeds the boss: its ticks hit without a crit, credited to the thrower", () => {
    const e = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    const boss = e.position;
    const dist = TUNING.boss.radius + 5;
    const from = { x: boss.x, z: boss.z + dist };
    const pitch = Math.atan2(TUNING.boss.chest - WAVE_HAND_HEIGHT, dist);
    expect(e.forbiddenFrequency("dj", from, Math.PI, pitch, STATS, 5, T0)).toBe(true);
    const events: BossEvent[] = [];
    for (let t = T0 + 50; t <= T0 + 3_500; t += 50) events.push(...e.update(t, []));
    const bleeds = events.filter((x) => x.t === "bleed");
    expect(bleeds).toHaveLength(1);
    expect(bleeds[0]).toMatchObject({ uid: "dj", stacks: 1 });
    expect(bleeds[0]).not.toHaveProperty("mob");
    const hits = events.filter((x) => x.t === "hit");
    expect(hits).toHaveLength(3);
    for (const h of hits)
      expect(h).toMatchObject({ uid: "dj", crit: false, skill: "forbidden-frequency" });
  });
});

describe("Forbidden Frequency in the Tower", () => {
  it("bleeds a mob, and the bleed ends (stacks 0) when it falls", () => {
    const e = new TowerEngine(
      { floor: 1, level: 99, seed: 3, now: T0 },
      { radius: TOWN_MAPS.tower.radius, entry: TOWN_MAPS.tower.spawn },
    );
    const mob = e.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 3 };
    const strong = { sonicPower: 5_000, critChance: 0, critDamage: 0 };
    expect(e.forbiddenFrequency("dj", from, 0, 0, strong, 10, T0)).toBe(true);
    const events: TowerEvent[] = [];
    for (let t = T0 + 50; t <= T0 + LASTS; t += 50) events.push(...e.update(t, []));
    const bleeds = events.filter((x) => x.t === "bleed");
    expect(bleeds[0]).toMatchObject({ uid: "dj", mob: mob.id, stacks: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({ t: "hit", mob: mob.id, skill: "forbidden-frequency" }),
    );
    // It fell to its bleed: the bleed is over.
    expect(events).toContainEqual(expect.objectContaining({ t: "mobDown", mob: mob.id }));
    expect(bleeds.at(-1)).toMatchObject({ mob: mob.id, stacks: 0 });
  });
});

describe("Silencio", () => {
  const SILENCIO_LASTS = SKILL_DEFS.silencio.durationMs ?? 0;
  const tower = () =>
    new TowerEngine(
      { floor: 1, level: 1, seed: 3, now: T0 },
      { radius: TOWN_MAPS.tower.radius, entry: TOWN_MAPS.tower.spawn },
    );

  it("bleeds hold one stack, a new one starting the time over", () => {
    const b = new Bleeds(SILENCIO_LASTS, 1);
    for (let i = 0; i < 3; i++) {
      const bleed = b.stack(disc(T0 + i * 1_000), T0 + i * 1_000);
      expect(bleed.stacks).toBe(1);
      expect(bleed.until).toBe(T0 + i * 1_000 + SILENCIO_LASTS);
    }
    // One stack hits once a tickMs.
    expect(b.ticks(T0 + 2_000 + 3_000)).toHaveLength(3 + 2);
  });

  it("bleeds the boss in reach, tagged as its own, but never moves it", () => {
    const e = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    const same = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    const boss = e.position;
    const at = { x: boss.x, z: boss.z + TUNING.boss.radius + SILENCIO.radius - 0.5 };
    expect(e.silencio("bard", at, STATS, 5, T0)).toBe(1);
    const events: BossEvent[] = [];
    for (let t = T0 + 50; t <= T0 + 450; t += 50) {
      events.push(...e.update(t, []));
      same.update(t, []);
      // Where it would have been without the wave.
      expect(e.position).toEqual(same.position);
    }
    for (let t = T0 + 500; t <= T0 + 3_500; t += 50) events.push(...e.update(t, []));
    const bleeds = events.filter((x) => x.t === "bleed");
    expect(bleeds).toEqual([
      { t: "bleed", uid: "bard", skill: "silencio", stacks: 1, until: T0 + 50 + SILENCIO_LASTS },
    ]);
    const hits = events.filter((x) => x.t === "hit");
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(h).toMatchObject({ uid: "bard", crit: false, skill: "silencio" });
  });

  it("misses a boss out of its reach", () => {
    const e = new BossEngine({ hp: 1e6, maxHp: 1e6, seed: 1, now: T0 });
    const boss = e.position;
    const at = { x: boss.x, z: boss.z + TUNING.boss.radius + SILENCIO.radius + 1 };
    expect(e.silencio("bard", at, STATS, 5, T0)).toBe(0);
    const events: BossEvent[] = [];
    for (let t = T0 + 50; t <= T0 + 2_000; t += 50) events.push(...e.update(t, []));
    expect(events.filter((x) => x.t === "bleed" || x.t === "hit")).toEqual([]);
  });

  it("flings every mob in reach out past its wave, leaves the rest, and bleeds those it caught", () => {
    const e = tower();
    const same = tower();
    const mobs = e.wireMobs();
    expect(mobs.every((m) => !m.e)).toBe(true);
    const at = { x: mobs[0].x + 0.4, z: mobs[0].z - 0.3 };
    const reach = SILENCIO.radius + MOB.radius;
    const dist = (m: { x: number; z: number }) => Math.hypot(m.x - at.x, m.z - at.z);
    const inside = mobs.filter((m) => dist(m) <= reach);
    // Past the slack a hit allows: the wave can't reach them.
    const outside = mobs.filter((m) => dist(m) > reach + 0.5);
    expect(inside.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    const caught = e.silencio("bard", at, STATS, 5, T0);
    expect(caught).toBeGreaterThanOrEqual(inside.length);
    const events: TowerEvent[] = [];
    // Grown to its full size, a moment before it's gone.
    for (let t = T0 + 50; t <= T0 + 450; t += 50) {
      events.push(...e.update(t, []));
      same.update(t, []);
    }
    const now = new Map(e.wireMobs().map((m) => [m.id, m]));
    const was = new Map(same.wireMobs().map((m) => [m.id, m]));
    for (const m of inside) {
      const p = now.get(m.id);
      if (!p) throw new Error("gone");
      // Wire positions are rounded to the centimetre.
      expect(dist(p)).toBeGreaterThanOrEqual(reach - 0.01);
    }
    for (const m of outside) {
      expect(now.get(m.id)?.x).toBe(was.get(m.id)?.x);
      expect(now.get(m.id)?.z).toBe(was.get(m.id)?.z);
    }
    for (let t = T0 + 500; t <= T0 + 2_500; t += 50) events.push(...e.update(t, []));
    const bled = events.filter((x) => x.t === "bleed");
    expect(bled).toHaveLength(caught);
    for (const b of bled) expect(b).toMatchObject({ uid: "bard", skill: "silencio", stacks: 1 });
    for (const m of inside) {
      expect(bled).toContainEqual(expect.objectContaining({ mob: m.id }));
      expect(events).toContainEqual(
        expect.objectContaining({ t: "hit", mob: m.id, skill: "silencio" }),
      );
    }
    for (const m of outside)
      expect(events).not.toContainEqual(expect.objectContaining({ t: "hit", mob: m.id }));
  });

  it("beside a Forbidden Frequency bleed, each runs as its own", () => {
    const e = tower();
    const mob = e.wireMobs()[0];
    const from = { x: mob.x, z: mob.z - 3 };
    expect(e.forbiddenFrequency("dj", from, 0, 0, STATS, 5, T0)).toBe(true);
    expect(e.silencio("bard", from, STATS, 5, T0)).toBeGreaterThan(0);
    const events: TowerEvent[] = [];
    for (let t = T0 + 50; t <= T0 + 2_500; t += 50) events.push(...e.update(t, []));
    const on = events.filter((x) => x.t === "bleed" && x.mob === mob.id);
    expect(on).toContainEqual(expect.objectContaining({ uid: "dj", stacks: 1 }));
    expect(on.find((x) => x.t === "bleed" && x.uid === "dj")).not.toHaveProperty("skill");
    expect(on).toContainEqual(expect.objectContaining({ uid: "bard", skill: "silencio" }));
    const tags = new Set(
      events.filter((x) => x.t === "hit" && x.mob === mob.id).map((x) => x.t === "hit" && x.skill),
    );
    expect(tags).toEqual(new Set(["forbidden-frequency", "silencio"]));
  });
});
