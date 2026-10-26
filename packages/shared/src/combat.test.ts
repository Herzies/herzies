import { describe, expect, it } from "vitest";
import { basicAttack, hasInstrument, instrumentOf } from "./classes.js";
import {
  aimDirection,
  BOSS_STAND,
  bossReaches,
  CONTRIBUTION_SUPPORT_WEIGHT,
  contributionOf,
  DISC_RANGE,
  healTarget,
  MELEE_REACH,
  meleeReaches,
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
});
