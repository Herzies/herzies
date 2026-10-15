import { describe, expect, it } from "vitest";
import { attackStyle, attackStyleOfGear } from "./classes.js";
import { MELEE_REACH, meleeReaches } from "./combat.js";

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
