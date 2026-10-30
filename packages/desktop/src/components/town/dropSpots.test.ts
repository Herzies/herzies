import { describe, expect, it } from "vitest";
import { HOME_DROPS, placeDrop, seenAtHome, type Vec2 } from "./dropSpots";

/** A seeded random, so the tests are the same every run. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MAGNET = 1.7;

describe("placeDrop", () => {
  const player = { x: 5, z: -3 };
  const away = 0.8;

  it("lands beyond walk-up pickup, off to a side of the herzie", () => {
    const random = seeded(1);
    for (let i = 0; i < 200; i++) {
      const p = placeDrop({ player, away, taken: [], ok: () => true, random });
      expect(p).not.toBeNull();
      if (!p) continue;
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      expect(d).toBeGreaterThan(MAGNET + 0.5);
      expect(d).toBeLessThanOrEqual(HOME_DROPS.far + 1e-9);
      // Never hidden right behind the herzie.
      let off = Math.atan2(p.x - player.x, p.z - player.z) - away;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      expect(Math.abs(off)).toBeGreaterThanOrEqual(HOME_DROPS.minAside - 1e-9);
      expect(seenAtHome(p, player, away)).toBe(true);
    }
  });

  it("keeps ten apart, the ground's whole cap", () => {
    const random = seeded(7);
    const taken: Vec2[] = [];
    for (let i = 0; i < 10; i++) {
      const p = placeDrop({ player, away, taken, ok: () => true, random });
      expect(p).not.toBeNull();
      if (p) taken.push(p);
    }
    for (let i = 0; i < taken.length; i++)
      for (let j = i + 1; j < taken.length; j++)
        expect(
          Math.hypot(taken[i].x - taken[j].x, taken[i].z - taken[j].z),
        ).toBeGreaterThanOrEqual(HOME_DROPS.spacing * 0.75 - 1e-9);
  });

  it("never lands where the ground can't hold it", () => {
    const random = seeded(3);
    // Water everywhere east of the herzie.
    const ok = (x: number) => x < player.x;
    for (let i = 0; i < 50; i++) {
      const p = placeDrop({ player, away, taken: [], ok, random });
      if (p) expect(p.x).toBeLessThan(player.x);
    }
  });

  it("gives up (to try again later) with nowhere to go", () => {
    expect(
      placeDrop({
        player,
        away,
        taken: [],
        ok: () => false,
        random: seeded(2),
      }),
    ).toBeNull();
  });
});

describe("seenAtHome", () => {
  it("is false far off or out to the sides", () => {
    const player = { x: 0, z: 0 };
    expect(seenAtHome({ x: 0, z: 3 }, player, 0)).toBe(true);
    expect(seenAtHome({ x: 0, z: 30 }, player, 0)).toBe(false);
    // Behind the camera.
    expect(seenAtHome({ x: 0, z: -3 }, player, 0)).toBe(false);
  });
});
