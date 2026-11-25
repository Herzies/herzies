import { WAVE_HAND_HEIGHT } from "@herzies/shared/combat";
import {
  bleedEveryMs,
  FORBIDDEN_FREQUENCY,
  SKILL_DEFS,
} from "@herzies/shared/skills";
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
