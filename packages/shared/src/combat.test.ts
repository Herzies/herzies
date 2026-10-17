import { describe, expect, it } from "vitest";
import { attackStyle, attackStyleOfGear } from "./classes.js";
import {
  aimDirection,
  BOSS_STAND,
  bossReaches,
  CONTRIBUTION_SUPPORT_WEIGHT,
  contributionOf,
  DISC_RANGE,
  MELEE_REACH,
  meleeReaches,
  type Vec3,
  WAVE_HAND_HEIGHT,
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

  it("is the attack of a Percussionist, and of a herzie without a class", () => {
    expect(attackStyle("percussionist")).toBe("melee");
    expect(attackStyle(null)).toBe("melee");
    expect(attackStyle("bard")).toBe("wave");
    expect(attackStyle("record_slinger")).toBe("disc");
    expect(attackStyleOfGear(undefined)).toBe("melee");
    expect(attackStyleOfGear("worn-stick")).toBe("melee");
    expect(attackStyleOfGear("lute")).toBe("wave");
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
