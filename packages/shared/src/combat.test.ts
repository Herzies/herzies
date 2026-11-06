import { describe, expect, it } from "vitest";
import { basicAttack, hasInstrument, instrumentOf } from "./classes.js";
import {
  aimDirection,
  BOSS_STAND,
  CAST_INTERVAL_MS,
  bossReaches,
  CONTRIBUTION_SUPPORT_WEIGHT,
  contributionOf,
  DISC_RANGE,
  DOME,
  discChain,
  discCycleMs,
  domeRadiusAt,
  healTarget,
  insideDome,
  MELEE_REACH,
  meleeReaches,
  nextInChain,
  pushOutOfDomes,
  stunMs,
  TAUNT_CONTRIBUTION_WEIGHT,
  TAUNT_FIGHT_SECONDS,
  tauntPointsPerSecond,
  type Vec3,
  WAVE_HAND_HEIGHT,
  WAVE_RANGE,
} from "./combat.js";

describe("melee", () => {
  const target = { x: 0, z: 0, radius: 1 };
  // Facing +z is yaw 0; the target is ahead of a herzie south of it.
  const from = { x: 0, z: -2 };

  it("reaches what's ahead, up close", () => {
    expect(meleeReaches(from, 0, target)).toBe(true);
    expect(meleeReaches({ x: 0, z: -1 - MELEE_REACH - 0.1 }, 0, target)).toBe(
      false,
    );
  });

  it("misses what's behind it, or well off to the side", () => {
    expect(meleeReaches(from, Math.PI, target)).toBe(false);
    expect(meleeReaches(from, Math.PI / 2 + 0.6, target)).toBe(false);
    // A little off still counts.
    expect(meleeReaches(from, 0.8, target)).toBe(true);
  });

  it("needs the class's instrument for the class's attack", () => {
    const at = (cls: string | null | undefined, stage: number, hand?: string) =>
      basicAttack({ cls, stage, mainHand: hand });
    expect(at("bard", 2, "lute")).toEqual({ style: "wave", blow: "bump" });
    expect(at("record_slinger", 2, "compact-discs").style).toBe("disc");
    expect(at("percussionist", 3, "worn-stick")).toEqual({
      style: "melee",
      blow: "strike",
    });
    // Without it: a body slam at stage 2, a punch from stage 3.
    expect(at("bard", 2)).toEqual({ style: "melee", blow: "bump" });
    expect(at("bard", 3)).toEqual({ style: "melee", blow: "punch" });
    expect(at("percussionist", 3, "lute")).toEqual({
      style: "melee",
      blow: "punch",
    });
    expect(at(null, 1)).toEqual({ style: "melee", blow: "bump" });
    // Someone else's herzie (class unknown): the instrument tells.
    expect(at(undefined, 2, "lute").style).toBe("wave");
    expect(at(undefined, 3, "old-cymbal")).toEqual({
      style: "melee",
      blow: "punch",
    });
  });

  it("knows each class's instrument", () => {
    expect(instrumentOf("bard")).toBe("lute");
    expect(instrumentOf("percussionist")).toBe("worn-stick");
    expect(instrumentOf(null)).toBeNull();
    expect(hasInstrument("record_slinger", "compact-discs")).toBe(true);
    expect(hasInstrument("bard", null)).toBe(false);
  });
});

describe("heal bolts", () => {
  const from: Vec3 = [0, WAVE_HAND_HEIGHT, 0];
  const ahead = aimDirection(0, 0);
  it("lock onto the ally nearest the aim, within the cone and range", () => {
    const allies = [
      { id: "wide", x: 4, z: 6 },
      { id: "on", x: 0.3, z: 10 },
      { id: "behind", x: 0, z: -5 },
    ];
    expect(healTarget(from, ahead, allies)?.ally.id).toBe("on");
    expect(healTarget(from, ahead, [allies[0], allies[2]])).toBeNull();
    expect(
      healTarget(from, ahead, [{ id: "far", x: 0, z: WAVE_RANGE + 2 }]),
    ).toBeNull();
  });
  it("forgive more for an ally up close (it's wide)", () => {
    // The same angle off the aim: near, locked; far, not.
    expect(healTarget(from, ahead, [{ x: 0.9, z: 3 }])).not.toBeNull();
    expect(healTarget(from, ahead, [{ x: 3.6, z: 12 }])).toBeNull();
  });
});

describe("casting at the boss", () => {
  // Pressed against its south side, facing north (yaw π), as the collider
  // lets a herzie stand.
  const close: Vec3 = [BOSS_STAND.x, WAVE_HAND_HEIGHT, BOSS_STAND.z + 2.6];
  const far: Vec3 = [BOSS_STAND.x, WAVE_HAND_HEIGHT, BOSS_STAND.z + 12];

  it("hits up close wherever the aim is on its body", () => {
    // Low at its feet, high on its face, and off to one side.
    for (const [yaw, pitch] of [
      [Math.PI, -0.9],
      [Math.PI, 1.2],
      [Math.PI + 0.9, 0],
      [Math.PI - 0.9, -0.5],
    ]) {
      expect(bossReaches(close, aimDirection(yaw, pitch), DISC_RANGE)).not.toBe(
        null,
      );
    }
  });

  it("misses up close what's aimed away, or into the floor", () => {
    expect(bossReaches(close, aimDirection(0, 0))).toBe(null);
    expect(bossReaches(close, aimDirection(Math.PI / 2 - 0.2, 0))).toBe(null);
    expect(bossReaches(close, aimDirection(Math.PI, -1.45))).toBe(null);
  });

  it("from afar, still wants the aim on it", () => {
    expect(bossReaches(far, aimDirection(Math.PI, 0.1))).not.toBe(null);
    expect(bossReaches(far, aimDirection(Math.PI + 0.5, 0.1))).toBe(null);
    expect(bossReaches(far, aimDirection(Math.PI, 0.8))).toBe(null);
  });

  it("is as far as the near side, and minds the range", () => {
    const d = bossReaches(far, aimDirection(Math.PI, 0)) ?? 0;
    expect(d).toBeGreaterThan(12 - BOSS_STAND.radius - 0.5);
    expect(d).toBeLessThan(12);
    expect(bossReaches(far, aimDirection(Math.PI, 0), 5)).toBe(null);
  });
});

describe("contribution", () => {
  it("counts healing and blocking ten times over", () => {
    expect(CONTRIBUTION_SUPPORT_WEIGHT).toBe(10);
    expect(contributionOf({ damage: 300, healing: 80, blocked: 0 })).toBe(1100);
    expect(contributionOf({ damage: 0, healing: 0, blocked: 50 })).toBe(500);
    // A healer can outrank a bigger hitter.
    expect(
      contributionOf({ damage: 300, healing: 80, blocked: 0 }),
    ).toBeGreaterThan(contributionOf({ damage: 1000, healing: 0, blocked: 0 }));
  });

  it("counts a taunt's points as they are", () => {
    expect(
      contributionOf({ damage: 100, healing: 0, blocked: 0, taunt: 250 }),
    ).toBe(350);
  });

  it("pays a taunt second as a share of an average herzie's damage a second", () => {
    // Five herzies against 553k: one fight-length's worth each, over the
    // target fight, times the weight.
    expect(tauntPointsPerSecond(553_371, 5)).toBeCloseTo(
      (TAUNT_CONTRIBUTION_WEIGHT * 553_371) / 5 / TAUNT_FIGHT_SECONDS,
    );
    // A bigger boss pays more; nothing for no boss or a junk roster.
    expect(tauntPointsPerSecond(1_000_000, 5)).toBeGreaterThan(
      tauntPointsPerSecond(500_000, 5),
    );
    expect(tauntPointsPerSecond(0, 5)).toBe(0);
    expect(tauntPointsPerSecond(100_000, 0)).toBe(
      tauntPointsPerSecond(100_000, 1),
    );
  });
});

describe("disc chains (Shuffle)", () => {
  const body = (ref: string, x: number, z = 0) => ({ ref, x, z, radius: 0.5 });
  const row = [body("a", 0), body("b", 3), body("c", 6), body("d", 20)];

  it("goes on to the nearest not yet struck, to its surface", () => {
    const next = nextInChain({ x: 0, z: 0 }, row, ["a"], 8);
    expect(next?.body.ref).toBe("b");
    expect(next?.dist).toBeCloseTo(2.5);
  });

  it("chains in order, never back, and stops out of reach", () => {
    const chain = discChain("a", { x: 0, z: 0 }, row, 5, 8);
    expect(chain.map((c) => c.body.ref)).toEqual(["b", "c"]);
  });

  it("bounces no more than it may", () => {
    expect(discChain("a", { x: 0, z: 0 }, row, 1, 8)).toHaveLength(1);
    expect(discChain("a", { x: 0, z: 0 }, row, 0, 8)).toHaveLength(0);
  });

  it("with nothing else near, a lone target is all it hits", () => {
    expect(discChain("a", { x: 0, z: 0 }, [body("a", 0)], 5, 8)).toEqual([]);
  });

  it("from something not in the list (the boss), every body may follow", () => {
    const chain = discChain(null, { x: -2, z: 0 }, row, 5, 8);
    expect(chain.map((c) => c.body.ref)).toEqual(["a", "b", "c"]);
  });
});

describe("the Cymbrella's dome", () => {
  const dome = { x: 0, z: 0, from: 1_000, until: 5_000 };

  it("grows from round its caster to its full size, then stands", () => {
    expect(domeRadiusAt(dome, 999)).toBe(0);
    expect(domeRadiusAt(dome, 1_000)).toBeCloseTo(DOME.startRadius);
    const mid = domeRadiusAt(dome, 1_000 + DOME.growMs / 2);
    expect(mid).toBeGreaterThan(DOME.startRadius);
    expect(mid).toBeLessThan(DOME.radius);
    expect(domeRadiusAt(dome, 1_000 + DOME.growMs)).toBeCloseTo(DOME.radius);
    expect(domeRadiusAt(dome, 4_999)).toBeCloseTo(DOME.radius);
    expect(domeRadiusAt(dome, 5_000)).toBe(0);
  });

  it("shelters what's inside it while it stands", () => {
    const t = 2_000;
    expect(insideDome([dome], 3, 0, t)).toBe(dome);
    expect(insideDome([dome], DOME.radius + 0.1, 0, t)).toBeNull();
    expect(insideDome([dome], 3, 0, 6_000)).toBeNull();
  });

  it("pushes a body out past its edge, straight from the centre", () => {
    const p = pushOutOfDomes([dome], 1, 0, 0.5, 2_000);
    expect(p.z).toBeCloseTo(0);
    expect(p.x).toBeGreaterThanOrEqual(DOME.radius + 0.5);
    // Already outside: left alone.
    expect(pushOutOfDomes([dome], 9, 0, 0.5, 2_000)).toEqual({ x: 9, z: 0 });
  });

  it("pushes out of overlapping domes, out of both", () => {
    const other = { ...dome, x: 6 };
    const p = pushOutOfDomes([dome, other], 3, 0, 0.5, 2_000);
    for (const d of [dome, other])
      expect(Math.hypot(p.x - d.x, p.z - d.z)).toBeGreaterThanOrEqual(
        DOME.radius + 0.5 - 1e-6,
      );
  });

  it("at a wall, the dome wins: round its edge to a spot in bounds", () => {
    // A wall at x = 5: nothing may stand past it.
    const wall = (q: { x: number; z: number }) => ({
      x: Math.min(q.x, 5),
      z: q.z,
    });
    const p = pushOutOfDomes([{ ...dome, x: 3 }], 4.5, 0, 0.5, 2_000, wall);
    expect(p.x).toBeLessThanOrEqual(5 + 1e-6);
    expect(Math.hypot(p.x - 3, p.z)).toBeGreaterThanOrEqual(DOME.radius + 0.5);
    // Settles there: pushed again, it stays.
    const again = pushOutOfDomes(
      [{ ...dome, x: 3 }],
      p.x,
      p.z,
      0.5,
      2_000,
      wall,
    );
    expect(again.x).toBeCloseTo(p.x);
    expect(again.z).toBeCloseTo(p.z);
  });
});

describe("stuns", () => {
  it("halve each time within the window", () => {
    expect(stunMs(2_000, 0)).toBe(2_000);
    expect(stunMs(2_000, 1)).toBe(1_000);
    expect(stunMs(2_000, 2)).toBe(500);
  });
});

describe("a disc's time out of the hand", () => {
  // Two hands at the cast pace: a hand must be back within two casts.
  const full = 2 * CAST_INTERVAL_MS;
  const pace = (d: number) => Math.min(1, full / discCycleMs(d));

  it("keeps a Slinger's full pace out to most of its reach", () => {
    for (const d of [2, 8, 14, 18]) expect(pace(d)).toBe(1);
  });

  it("eases off at the far end, without a cliff", () => {
    expect(pace(24)).toBeGreaterThan(0.8);
    expect(pace(24)).toBeLessThan(0.9);
    // Smooth: no step bigger than a few percent a metre.
    for (let d = 14; d < 24; d++)
      expect(pace(d) - pace(d + 1)).toBeLessThan(0.04);
  });

  it("comes back quicker when hasted, and a miss is out longest", () => {
    expect(discCycleMs(20, 1.4)).toBeLessThan(discCycleMs(20));
    expect(discCycleMs(null)).toBeGreaterThan(discCycleMs(DISC_RANGE));
  });
});
