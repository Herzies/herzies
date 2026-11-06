import {
  TOWN_MAPS,
  TOWN_SPRINT_SPEED,
  type TownTicketPayload,
} from "@herzies/shared/town-net";
import { describe, expect, it } from "vitest";
import type { Telegraph } from "../src/boss";
import { MAX_MOVE_SPEED } from "@herzies/shared";
import {
  edgeDistance,
  FairPlay,
  FASTEST,
  FLAGS,
  quantile,
  SHORT_WARNING_MS,
} from "../src/fairplay";
import { FightRuntime, REJOIN_PIN_MS } from "../src/fight";
import { armed } from "./arms";

const T0 = 5_000_000;
const FRAME = 1000 / 15;

/** A seeded stand-in for Math.random, so a "person" is the same each run. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function circle(id: number, at: number, warnMs: number): Telegraph {
  return {
    id,
    kind: "circle",
    x: 0,
    z: 0,
    r: 1.7,
    inner: 0,
    at,
    hitAt: at + warnMs,
    damage: 10,
  };
}

/** A herzie standing in the middle of a warning at `at` that walks out
 * east, starting `react` ms after it appears, and is hit unless it gets
 * out in time. */
function dodge(
  f: FairPlay,
  id: number,
  at: number,
  react: number,
  warnMs = 900,
) {
  const tg = circle(id, at, warnMs);
  f.frame("u", at, 0, 0);
  f.telegraph(tg, [{ uid: "u", x: 0, z: 0 }]);
  let x = 0;
  let t = at;
  while (t < tg.hitAt) {
    t += FRAME;
    if (t - at > react) x += 6 * (FRAME / 1000);
    f.frame("u", t, x, 0);
  }
  f.resolved(id, new Set(x > tg.r ? [] : ["u"]), tg.hitAt);
  // Walk back to the middle for the next one, in honest steps.
  while (x > 0) {
    t += FRAME;
    x = Math.max(0, x - 6 * (FRAME / 1000));
    f.frame("u", t, x, 0);
  }
  return t;
}

describe("fair play", () => {
  it("knows the fastest a herzie runs", () => {
    expect(FASTEST).toBe(TOWN_SPRINT_SPEED * (1 + MAX_MOVE_SPEED / 100));
  });

  it("measures the way out of a shape", () => {
    const c = circle(1, T0, 600);
    expect(edgeDistance(c, 0, 0)).toBeCloseTo(1.7);
    expect(edgeDistance(c, 1, 0)).toBeCloseTo(0.7);
    const ring = { ...c, r: 6, inner: 3 };
    expect(edgeDistance(ring, 4, 0)).toBeCloseTo(1);
    expect(edgeDistance(ring, 5.5, 0)).toBeCloseTo(0.5);
  });

  it("takes quantiles", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });

  describe("blinks", () => {
    it("sees none in sprinting, in packets bunched up, or in a held-up client", () => {
      const f = new FairPlay(() => {});
      let x = 0;
      let t = T0;
      // Sprinting with the fastest gear, 15 frames a second.
      for (let i = 0; i < 60; i++) {
        x += 7.5 * (FRAME / 1000);
        t += FRAME;
        f.frame("u", t, x, 0);
      }
      // Ten frames held up by the network, arriving all at once.
      for (let i = 0; i < 10; i++) {
        x += 7.5 * (FRAME / 1000);
        f.frame("u", t + 900 + i, x, 0);
      }
      t += 1_000;
      // A hidden window: no frame for 2 s, then one 2 m on.
      t += 2_000;
      x += 2;
      f.frame("u", t, x, 0);
      expect(f.summary("u").blinks).toBe(0);
      expect(f.summary("u").flags).not.toContain("blinks");
    });

    it("sees a step no herzie can take in one frame", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 0, 0);
      f.frame("u", T0 + FRAME, 0.4, 0);
      // Out of a warning in one frame: 3 m.
      f.frame("u", T0 + 2 * FRAME, 3.4, 0);
      const s = f.summary("u");
      expect(s.blinks).toBe(1);
      expect(s.max_step).toBe(3);
      expect(s.flags).toContain("blinks");
    });

    it("doesn't count the game's own jump back to the start, once", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 10, 0);
      // On to the next floor; frames from the far portal still arrive...
      f.moved("u", T0 + 10, 5_000);
      f.frame("u", T0 + FRAME, 10.3, 0);
      f.frame("u", T0 + 2 * FRAME, 10.6, 0);
      // ...then the jump to the start, ~30 m in a frame (as live).
      f.frame("u", T0 + 3 * FRAME, -12.5, 0.5);
      expect(f.summary("u").blinks).toBe(0);
      // A second one isn't the game's.
      f.frame("u", T0 + 4 * FRAME, -9, 0.5);
      expect(f.summary("u").blinks).toBe(1);
    });

    it("counts a jump long after the game's allowance lapsed", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 10, 0);
      f.moved("u", T0, 5_000);
      f.frame("u", T0 + 6_000, 10, 0);
      f.frame("u", T0 + 6_000 + FRAME, 0, 0);
      expect(f.summary("u").blinks).toBe(1);
    });
  });

  describe("dodges", () => {
    it("flags getting out of nearly every short warning", () => {
      const f = new FairPlay(() => {});
      const r = rand(1);
      let t = T0;
      // A program: moving on the first frame a 600 ms warning arrives (its
      // time here is the network's: ~40-80 ms, give or take).
      for (let i = 0; i < 70; i++)
        t = dodge(f, i, t + 500, 40 + r() * 40, 600);
      const s = f.summary("u");
      expect(s.dodge.run.short_stood_in).toBe(70);
      expect(s.dodge.run.short_escape_rate).toBe(1);
      // The walk out from the middle takes 1.7 / FASTEST: what's left is
      // its reaction (and the frames' spacing).
      expect(s.dodge.react_ms.p50 ?? 0).toBeLessThan(150);
      expect(s.flags).toContain("dodges");
    });

    it("doesn't flag a person, who's slower and caught now and then", () => {
      const f = new FairPlay(() => {});
      const r = rand(2);
      let t = T0;
      // Reactions of 200-500 ms to a 600 ms warning: most get out, the
      // slow ones are hit.
      for (let i = 0; i < 70; i++)
        t = dodge(f, i, t + 500, 200 + r() * 300, 600);
      const s = f.summary("u");
      expect(s.dodge.run.short_stood_in).toBe(70);
      expect(s.dodge.run.short_escape_rate ?? 1).toBeLessThan(
        FLAGS.dodgeEscape,
      );
      expect(s.dodge.react_ms.p50 ?? 0).toBeGreaterThan(200);
      expect(s.flags).not.toContain("dodges");
    });

    it("needs enough short warnings to say anything", () => {
      const f = new FairPlay(() => {});
      let t = T0;
      for (let i = 0; i < FLAGS.dodgeMin - 1; i++)
        t = dodge(f, i, t + 500, 40, 600);
      // Long warnings don't count towards it.
      for (let i = 0; i < 10; i++) t = dodge(f, 100 + i, t + 500, 40, 1_200);
      expect(f.summary("u").flags).not.toContain("dodges");
    });

    it("counts a lane of circles as one dodge, struck if any circle struck", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 0, 0);
      // Three circles of one lunger's dash, landing together; the herzie
      // stands in the second only.
      const lane = [-2, 0, 2].map((x, i) => ({
        ...circle(10 + i, T0, 600),
        x,
        r: 1.15,
        mob: 7,
      }));
      for (const tg of lane) f.telegraph(tg, [{ uid: "u", x: 0, z: 0 }]);
      f.frame("u", T0 + 300, 0, 0);
      f.resolved(10, new Set(), T0 + 600);
      expect(f.summary("u").dodge.stood_in).toBe(0);
      f.resolved(11, new Set(["u"]), T0 + 600);
      f.resolved(12, new Set(), T0 + 600);
      const s = f.summary("u");
      expect(s.dodge.stood_in).toBe(1);
      expect(s.dodge.escaped).toBe(0);
    });

    it("doesn't count an attack called off before it lands", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 0, 0);
      f.telegraph(circle(1, T0, 600), [{ uid: "u", x: 0, z: 0 }]);
      // Its mob stunned (a Rimshot) or down: resolved early, on nobody.
      f.resolved(1, new Set(), T0 + 200);
      expect(f.summary("u").dodge.stood_in).toBe(0);
    });

    it("keeps the run's dodges across floors, and each floor's apart", () => {
      const f = new FairPlay(() => {});
      let t = dodge(f, 1, T0, 40, 600);
      f.report("u", { floor: 1 });
      t = dodge(f, 2, t + 500, 40, 600);
      const s = f.summary("u");
      expect(s.dodge.short_stood_in).toBe(1);
      expect(s.dodge.run.short_stood_in).toBe(2);
    });

    it("counts leaving just before a blow as no dodge, and flags doing it again", () => {
      const f = new FairPlay(() => {});
      for (let i = 0; i < FLAGS.leaves; i++) {
        const at = T0 + i * 5_000;
        f.frame("u", at, 0, 0);
        f.telegraph(circle(i, at, 600), [{ uid: "u", x: 0, z: 0 }]);
        // Gone 200 ms before it lands; it resolves on nobody.
        f.left("u", at + 400);
        f.resolved(i, new Set(), at + 600);
      }
      const s = f.summary("u");
      expect(s.dodge.stood_in).toBe(0);
      expect(s.dodge.run.left_mid_attack).toBe(FLAGS.leaves);
      expect(s.flags).toContain("leaves");
    });

    it("doesn't count leaving with nothing about to land", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 0, 0);
      f.telegraph(circle(1, T0, 3_000), [{ uid: "u", x: 0, z: 0 }]);
      f.left("u", T0 + 100);
      expect(f.summary("u").dodge.left_mid_attack).toBe(0);
    });

    it("counts short warnings apart", () => {
      const f = new FairPlay(() => {});
      dodge(f, 1, T0, 50, SHORT_WARNING_MS - 100);
      dodge(f, 2, T0 + 5_000, 50, SHORT_WARNING_MS + 300);
      const s = f.summary("u");
      expect(s.dodge.short_stood_in).toBe(1);
      expect(s.dodge.short_escaped).toBe(1);
    });

    it("only watches who a warning covers, and never a buster", () => {
      const f = new FairPlay(() => {});
      f.frame("u", T0, 5, 5);
      f.frame("v", T0, 0, 0);
      f.telegraph(circle(1, T0, 900), [
        { uid: "u", x: 5, z: 5 },
        { uid: "v", x: 0, z: 0 },
      ]);
      f.telegraph({ ...circle(2, T0, 900), kind: "buster", target: "u" }, [
        { uid: "u", x: 0, z: 0 },
      ]);
      f.resolved(1, new Set(), T0 + 900);
      f.resolved(2, new Set(["u"]), T0 + 900);
      expect(f.summary("u").dodge.stood_in).toBe(0);
      expect(f.summary("v").dodge.stood_in).toBe(1);
    });
  });

  describe("aim", () => {
    it("flags casts that land in the middle, over the floors of a run", () => {
      const f = new FairPlay(() => {});
      const r = rand(3);
      // ~25 a floor, as the autopilot cast them live: none flags alone.
      for (let floor = 0; floor < 3; floor++) {
        f.frame("u", T0 + floor * 60_000, 0, 0);
        for (let i = 0; i < 25; i++) f.aimed("u", r() * 0.012, 0.1);
        const s = f.summary("u");
        expect(s.aim.casts).toBe(25);
        if (floor < 2) expect(s.flags).not.toContain("aim");
        else {
          expect(s.aim.run.casts).toBe(75);
          expect(s.flags).toContain("aim");
        }
        f.report("u", { floor });
      }
    });

    it("doesn't flag aim spread over the body", () => {
      const f = new FairPlay(() => {});
      const r = rand(4);
      for (let i = 0; i < 80; i++) f.aimed("u", (r() - 0.5) * 0.2, 0.1);
      const s = f.summary("u");
      expect(s.aim.run.casts).toBe(80);
      expect(s.aim.run.p50 ?? 0).toBeGreaterThan(FLAGS.aimP50);
      expect(s.flags).not.toContain("aim");
    });

    it("needs enough casts to say anything", () => {
      const f = new FairPlay(() => {});
      for (let i = 0; i < FLAGS.aimMin - 1; i++) f.aimed("u", 0, 0.1);
      expect(f.summary("u").flags).not.toContain("aim");
    });
  });

  describe("skills", () => {
    it("flags every skill used the moment it's ready", () => {
      const f = new FairPlay(() => {});
      let t = T0;
      f.skill("u", "backspin", t, t + 12_000);
      for (let i = 0; i < 10; i++) {
        t += 12_000 + 17;
        f.skill("u", "backspin", t, t + 12_000);
      }
      const s = f.summary("u");
      expect(s.skills.used).toBe(10);
      expect(s.skills.p50_ms).toBe(17);
      expect(s.flags).toContain("skills");
    });

    it("doesn't flag a person's timing, nor count a skill left for long", () => {
      const f = new FairPlay(() => {});
      const r = rand(5);
      let t = T0;
      f.skill("u", "backspin", t, t + 12_000);
      for (let i = 0; i < 10; i++) {
        t += 12_000 + 150 + r() * 1_500;
        f.skill("u", "backspin", t, t + 12_000);
      }
      // Ten seconds after it was ready: not timing.
      t += 22_000;
      f.skill("u", "backspin", t, t + 12_000);
      const s = f.summary("u");
      expect(s.skills.used).toBe(10);
      expect(s.flags).not.toContain("skills");
    });
  });

  it("reports one JSON line and starts the next floor afresh", () => {
    const lines: string[] = [];
    const f = new FairPlay((l) => lines.push(l));
    expect(f.report("u", { floor: 1 })).toBeNull();
    f.frame("u", T0, 0, 0);
    f.frame("u", T0 + FRAME, 3, 0);
    f.skill("u", "backspin", T0, T0 + 12_000);
    const r = f.report("u", { floor: 1, why: "cleared" });
    expect(r?.blinks).toBe(1);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({
      fairplay: 1,
      uid: "u",
      floor: 1,
      why: "cleared",
      blinks: 1,
    });
    // Counted afresh, but where it stood and its cooldowns carry over.
    f.frame("u", T0 + 2 * FRAME, 3.3, 0);
    f.skill("u", "backspin", T0 + 12_020, T0 + 24_020);
    const s = f.summary("u");
    expect(s.frames).toBe(1);
    expect(s.blinks).toBe(0);
    expect(s.skills.used).toBe(1);
  });
});

describe("fair play in the Tower", () => {
  const ARENA = { radius: TOWN_MAPS.tower.radius, entry: TOWN_MAPS.tower.spawn };
  const claim = { event: "tower-1", until: (T0 + 3_600_000) / 1000, floor: 3 };
  const ticket = (): TownTicketPayload =>
    armed({
      uid: "u",
      name: "u",
      look: { seed: "s", stage: 2 },
      cls: "bard",
      exp: 9e9,
      hp: { hp: 500, maxHp: 500, down: false },
      st: [0, 0, 0, 0],
      lv: 5,
    });

  it("watches the warnings over the herzie and logs the floor on leaving", () => {
    const lines: string[] = [];
    const f = FightRuntime.tower(claim, "u", 5, ARENA, T0, 3);
    f.fair = new FairPlay((l) => lines.push(l));
    f.join("u", 1, ticket(), ARENA.entry, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    // Stand still where the mobs come, so warnings land on the herzie.
    let t = T0;
    for (; t < T0 + 30_000; t += 50) {
      f.onState("u", ARENA.entry.x, ARENA.entry.z, t);
      f.step(t);
    }
    f.leave("u", t);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line.fairplay).toBe(1);
    expect(line.map).toBe("tower");
    expect(line.floor).toBe(3);
    // Until it was knocked out (it never moved), so it says why.
    expect(line.frames).toBeGreaterThan(100);
    expect(line.why).toBe("down");
    expect(line.blinks).toBe(0);
    // It stood in them and never moved: none got out.
    expect(line.dodge.stood_in).toBeGreaterThan(0);
    expect(line.dodge.escaped).toBe(0);
  });

  it("brings a herzie back quickly where it left, not where its client says", () => {
    const f = FightRuntime.tower(claim, "u", 5, ARENA, T0, 3);
    f.fair = new FairPlay(() => {});
    f.join("u", 1, ticket(), ARENA.entry, T0);
    const there = { x: 6, z: -4 };
    f.onState("u", there.x, there.z, T0 + 100);
    f.leave("u", T0 + 200);
    expect(f.rejoinAt("u", T0 + 5_000)).toEqual(there);
    // Gone a while: it starts where its client says, as ever.
    expect(f.rejoinAt("u", T0 + 200 + REJOIN_PIN_MS + 1)).toBeNull();
  });

  it("keeps the floor's counts over a reconnect", () => {
    const lines: string[] = [];
    const f = FightRuntime.tower(claim, "u", 5, ARENA, T0, 3);
    f.fair = new FairPlay((l) => lines.push(l));
    f.join("u", 1, ticket(), ARENA.entry, T0);
    for (let t = T0; t < T0 + 1_000; t += 50)
      f.onState("u", ARENA.entry.x, ARENA.entry.z, t);
    f.leave("u", T0 + 1_000);
    f.join("u", 1, ticket(), ARENA.entry, T0 + 1_500);
    for (let t = T0 + 1_500; t < T0 + 2_500; t += 50)
      f.onState("u", ARENA.entry.x, ARENA.entry.z, t);
    f.leave("u", T0 + 2_500);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).frames).toBe(JSON.parse(lines[0]).frames * 2);
  });

  it("measures aim on a cast that finds its mob", () => {
    const lines: string[] = [];
    const f = FightRuntime.tower(claim, "u", 5, ARENA, T0, 3);
    f.fair = new FairPlay((l) => lines.push(l));
    f.join("u", 1, ticket(), { x: 0, z: 0 }, T0);
    const tw = f.tower;
    if (!tw) throw new Error("not a tower");
    let t = T0;
    let aimed = 0;
    for (let i = 0; i < 12; i++) {
      const mob = tw.wireMobs()[0];
      const from = { x: mob.x - 4, z: mob.z };
      for (let k = 0; k < 4; k++) {
        f.onState("u", from.x, from.z, t);
        t += 50;
      }
      // Straight at its middle, as the herzie saw it.
      if (f.cast("u", Math.PI / 2, 0, t) === "hit") aimed++;
      t += 600;
      f.step(t);
    }
    f.leave("u", t);
    const line = JSON.parse(lines[0]);
    expect(aimed).toBeGreaterThan(0);
    expect(line.aim.casts).toBe(aimed);
    expect(line.aim.p50).toBeLessThan(0.5);
  });
});
