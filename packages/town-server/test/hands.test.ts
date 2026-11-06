import { CAST_INTERVAL_MS, discCycleMs } from "@herzies/shared/combat";
import { describe, expect, it } from "vitest";
import { DiscHands, HAND_LENIENCY } from "../src/hands";

describe("a Slinger's two discs", () => {
  it("lets an honest pace through at any range", () => {
    for (const d of [3, 12, 18, 24]) {
      const h = new DiscHands();
      // The app's pace: the cast interval, and never before a disc is back.
      const back: [number, number] = [0, 0];
      let t = 1_000;
      for (let i = 0; i < 40; i++) {
        const k = back[0] <= back[1] ? 0 : 1;
        t = Math.max(t + CAST_INTERVAL_MS, back[k]);
        expect(h.take("a", t, d, 1), `at ${d} m, throw ${i}`).toBe(true);
        back[k] = t + discCycleMs(d);
      }
    }
  });

  it("refuses a third throw with both discs out", () => {
    const h = new DiscHands();
    expect(h.take("a", 1_000, 24, 1)).toBe(true);
    expect(h.take("a", 1_100, 24, 1)).toBe(true);
    expect(h.take("a", 1_200, 24, 1)).toBe(false);
    // Once the first is back (with the server's leniency), it may.
    expect(h.take("a", 1_000 + discCycleMs(24) * HAND_LENIENCY, 24, 1)).toBe(true);
  });

  it("each herzie has its own, and forgetting gives them back", () => {
    const h = new DiscHands();
    h.take("a", 0, null, 1);
    h.take("a", 0, null, 1);
    expect(h.take("b", 0, null, 1)).toBe(true);
    expect(h.take("a", 10, null, 1)).toBe(false);
    h.forget("a");
    expect(h.take("a", 10, null, 1)).toBe(true);
  });
});

describe("the server's disc pace, with Timing", () => {
  it("lets a Slinger with Timing throw as fast as its app flies the discs", async () => {
    const { BossEngine } = await import("../src/boss");
    const { timingAttackSpeed } = await import("@herzies/shared/stats");
    const T0 = 5_000_000;
    const e = new BossEngine({ hp: 1e9, maxHp: 1e9, seed: 1, now: T0 });
    const timing = 200;
    const quick = 1 + timingAttackSpeed(timing);
    const stats = { sonicPower: 0, critChance: 0, critDamage: 0, timing };
    // From 20 m off the boss's near side, straight at it.
    const from = { x: 0, z: -4 + 2.2 + 20 };
    const back: [number, number] = [0, 0];
    let t = T0 + 1_000;
    let refused = 0;
    for (let i = 0; i < 30; i++) {
      const k = back[0] <= back[1] ? 0 : 1;
      t = Math.max(t + CAST_INTERVAL_MS / quick, back[k]);
      const r = e.cast("a", from, Math.PI, 0, stats, t, "disc");
      if (r !== "hit") refused++;
      back[k] = t + discCycleMs(20, quick);
    }
    expect(refused).toBe(0);
  });
});
