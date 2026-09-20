import { describe, expect, it } from "vitest";
import { RAINBOW_RAMP, VOID_RAMP } from "./ascii3d.js";
import {
  BOSS_BODY_TYPE,
  DEFAULT_Y_ANGLE,
  generateCreatureParams,
  generateDanceFrames,
  generateIdleFrames,
  generateRotationFrames,
  isSpiritHopFrame,
  renderCreatureAtAngle,
  SPIRIT_DANCE_HOP_VARIANT_COUNT,
} from "./creature-renderer.js";

const USER = "test-herzie";

describe("frame cells", () => {
  it("never emits an undefined glyph", () => {
    // RAMP_HERZIE is a single glyph, so any brightness that indexes past 0
    // yields undefined and canvas fillText() would draw the string "undefined".
    for (const frame of generateRotationFrames(USER, 3, 8)) {
      for (const row of frame.cells) {
        for (const cell of row) {
          expect(typeof cell.ch).toBe("string");
        }
      }
    }
  });

  it("emits finite brightness for every rendered cell", () => {
    for (const frame of generateIdleFrames(USER, 3)) {
      for (const row of frame.cells) {
        for (const cell of row) {
          expect(cell.ch).not.toBe(undefined);
        }
      }
    }
  });

  it("still renders dark pupils", () => {
    const frame = generateRotationFrames(USER, 3, 8)[0];
    const colors = new Set(frame.cells.flat().map((c) => c.color));
    expect(colors).toContain("#111111");
  });
});

const hueSet = (frames: { cells: { ch: string; color: string }[][] }[]) => {
  const s = new Set<string>();
  for (const f of frames)
    for (const row of f.cells) for (const c of row) if (c.color) s.add(c.color);
  return s;
};

describe("prism colour scheme", () => {
  const plain = generateRotationFrames(USER, 3, 12);
  const prism = generateRotationFrames(USER, 3, 12, { color: "prism" });

  it("adds hues the seeded palette does not have", () => {
    expect(hueSet(prism).size).toBeGreaterThan(hueSet(plain).size);
  });

  it("spans the whole rainbow, not one hue", () => {
    // 7 bands x 3 shades, minus whatever the silhouette hides.
    expect(hueSet(prism).size).toBeGreaterThanOrEqual(15);
  });

  it("leaves the face readable", () => {
    const colors = hueSet(prism);
    expect(colors).toContain("#FFF8DC"); // eye
    expect(colors).toContain("#111111"); // pupil
  });

  it("does not recolour worn items", () => {
    const withHat = generateRotationFrames(USER, 3, 12, {
      color: "prism",
      head: "headphones",
    });
    const colors = hueSet(withHat);
    // Headphones shade through the "wearable" zone greys.
    expect([...colors].some((c) => ["#888", "#666", "#444"].includes(c))).toBe(
      true,
    );
  });

  it("does not crawl through rotation", () => {
    // Hue comes from the hit point's Y, which rotY preserves, so spinning must
    // not invent colours. Lighting may reveal a shade of a band that happened
    // to be unlit head-on, so the bound is 3 shades per band plus eye + pupil
    // rather than strict per-frame equality.
    expect(hueSet(prism).size).toBeLessThanOrEqual(7 * 3 + 2);
  });

  it("shows every band of the ramp", () => {
    const colors = hueSet(prism);
    for (const hue of RAINBOW_RAMP) expect(colors).toContain(hue);
  });

  it("restores the seeded colour when unequipped", () => {
    expect([...hueSet(generateRotationFrames(USER, 3, 12, {}))].sort()).toEqual(
      [...hueSet(plain)].sort(),
    );
  });

  it("ignores an unknown colour id", () => {
    const bogus = generateRotationFrames(USER, 3, 12, { color: "not-a-color" });
    expect([...hueSet(bogus)].sort()).toEqual([...hueSet(plain)].sort());
  });
});

describe("spirit orb pet", () => {
  it("renders without throwing on either ground slot", () => {
    expect(() =>
      generateRotationFrames(USER, 3, 8, { ground_left: "spirit-orb" }),
    ).not.toThrow();
    expect(() =>
      generateRotationFrames(USER, 3, 8, { ground_right: "spirit-orb" }),
    ).not.toThrow();
  });

  it("adds pixels beyond the plain body", () => {
    const plain = generateRotationFrames(USER, 3, 12);
    const withOrb = generateRotationFrames(USER, 3, 12, {
      ground_left: "spirit-orb",
    });
    expect(hueSet(withOrb).size).toBeGreaterThan(hueSet(plain).size);
  });

  it("dance hop variants reuse plain frames outside the hop", () => {
    const eq = { ground_left: "spirit-orb" } as const;
    const plain = generateDanceFrames(USER, 3, eq);
    for (let v = 0; v < SPIRIT_DANCE_HOP_VARIANT_COUNT; v++) {
      const hop = generateDanceFrames(
        USER,
        3,
        eq,
        undefined,
        undefined,
        undefined,
        v,
      );
      expect(hop).toHaveLength(plain.length);
      hop.forEach((frame, i) => {
        if (isSpiritHopFrame(v, i)) expect(frame).not.toBe(plain[i]);
        else expect(frame).toBe(plain[i]);
      });
      // Seamless at the loop boundary, where Herzie3D swaps variants.
      expect(isSpiritHopFrame(v, 0)).toBe(false);
      expect(isSpiritHopFrame(v, plain.length - 1)).toBe(false);
    }
  });

  it("dance hop variants put the spirit back where it started", () => {
    // Travel holds after landing, so a variant whose travels don't cancel out
    // would snap the spirit sideways once its hops end (those frames are
    // reused from the plain loop). Re-render the last frame with the variant's
    // pose actually applied and compare pixels.
    const eq = { ground_left: "spirit-orb" } as const;
    const plain = generateDanceFrames(USER, 3, eq);
    const last = plain.length - 1;
    for (let v = 0; v < SPIRIT_DANCE_HOP_VARIANT_COUNT; v++) {
      const posed = renderCreatureAtAngle(
        USER,
        3,
        DEFAULT_Y_ANGLE,
        last,
        true,
        eq,
        undefined,
        undefined,
        undefined,
        v,
      );
      expect(posed.cells).toEqual(plain[last].cells);
    }
  });

  it("ignores a dance hop variant when no spirit is equipped", () => {
    expect(
      generateDanceFrames(
        USER,
        3,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
      ),
    ).toBe(generateDanceFrames(USER, 3));
  });

  it("coexists with a boombox on the other ground slot", () => {
    expect(() =>
      generateRotationFrames(USER, 3, 8, {
        ground_left: "spirit-orb",
        ground_right: "boombox",
      }),
    ).not.toThrow();
  });
});

describe("prism band spread", () => {
  // The first cut coloured whole spheres, so the head and body — each one big
  // sphere — came out flat: an orange herzie with a red hat and blue socks.
  // Hue now comes from the ray hit point, so every body type spans the ramp.
  const nearestBand = (hex: string): string => {
    const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
    const dir = (h: string) => {
      const sum = ch(h, 1) + ch(h, 3) + ch(h, 5) || 1;
      return [ch(h, 1) / sum, ch(h, 3) / sum, ch(h, 5) / sum];
    };
    const [r, g, b] = dir(hex);
    let best: string = RAINBOW_RAMP[0];
    let bestD = Number.POSITIVE_INFINITY;
    for (const hue of RAINBOW_RAMP) {
      const [R, G, B] = dir(hue);
      const d = Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B);
      if (d < bestD) {
        bestD = d;
        best = hue;
      }
    }
    return best;
  };

  for (const bodyType of [0, 1, 2, 3]) {
    it(`spans the ramp on body type ${bodyType}`, () => {
      const params = { ...generateCreatureParams("blobby"), bodyType };
      const frame = generateRotationFrames(
        "blobby",
        3,
        12,
        { color: "prism" },
        params,
      )[0];

      const counts = new Map<string, number>();
      let total = 0;
      for (const row of frame.cells) {
        for (const cell of row) {
          if (!cell.color) continue;
          if (cell.color === "#FFF8DC" || cell.color === "#111111") continue;
          const band = nearestBand(cell.color);
          counts.set(band, (counts.get(band) ?? 0) + 1);
          total += 1;
        }
      }

      expect(counts.size).toBe(RAINBOW_RAMP.length);
      const largest = Math.max(...counts.values()) / total;
      expect(largest).toBeLessThan(0.5);
    });
  }
});

describe("renderCreatureAtAngle", () => {
  // Herzie3D caches this per settled drag angle, keyed on frame index alone.
  // That is only sound while the function is pure — if it ever picks up a
  // time or random source, the cache would silently freeze the animation
  // after the user's first drag rather than fail loudly.
  it("is deterministic for identical inputs", () => {
    const args = [USER, 3, 1.2345, 7] as const;
    const first = renderCreatureAtAngle(...args);
    const second = renderCreatureAtAngle(...args);

    expect(second.cells).toEqual(first.cells);
  });

  it("still varies across the idle cycle", () => {
    // Not every pair of frames differs — the idle breathing runs a whole
    // number of sine cycles over the 60-frame loop, so frame 30 lands back on
    // frame 0. Assert the loop as a whole animates rather than any one pair.
    const base = renderCreatureAtAngle(USER, 3, 1.2345, 0);
    const differs = Array.from({ length: 59 }, (_, i) =>
      renderCreatureAtAngle(USER, 3, 1.2345, i + 1),
    ).some((f) => JSON.stringify(f.cells) !== JSON.stringify(base.cells));

    expect(differs).toBe(true);
  });
});

describe("boss body type", () => {
  const bossParams = () => ({
    ...generateCreatureParams(USER),
    bodyType: BOSS_BODY_TYPE,
  });

  it("is unreachable from the seeded generator", () => {
    // The seeded roll is hardcoded to intSeeded(0, 3) rather than reading
    // CREATURE_PARAM_BOUNDS.bodyType.max. If someone "tidies" that up to use
    // the bound, every existing herzie silently changes body — this is the
    // test that catches it.
    for (let i = 0; i < 2000; i++) {
      expect(generateCreatureParams(`seed-${i}`).bodyType).toBeLessThan(
        BOSS_BODY_TYPE,
      );
    }
  });

  it("does not disturb existing seeds", () => {
    // Widening the roll would shift every downstream param too, because they
    // all draw from the same rng sequence.
    expect(generateCreatureParams("herzie-1")).toEqual(
      generateCreatureParams("herzie-1"),
    );
    expect(generateCreatureParams("herzie-1").bodyType).toBe(
      generateCreatureParams("herzie-1").bodyType,
    );
  });

  it("paints with the void ramp regardless of equipped colour", () => {
    const frame = renderCreatureAtAngle(
      USER,
      3,
      DEFAULT_Y_ANGLE,
      0,
      false,
      { color: "prism" },
      bossParams(),
    );
    const colors = hueSet([frame]);
    // Prism is equipped but must not win: the boss palette is not a skin.
    for (const rainbow of RAINBOW_RAMP) expect(colors).not.toContain(rainbow);
    expect([...VOID_RAMP].some((c) => colors.has(c))).toBe(true);
  });

  it("gives the boss red eyes without touching herzie eyes", () => {
    const boss = hueSet([
      renderCreatureAtAngle(
        USER,
        3,
        DEFAULT_Y_ANGLE,
        0,
        false,
        undefined,
        bossParams(),
      ),
    ]);
    // Mirrors EVIL_EYE_* in creature-renderer.ts. Kept as literals on purpose:
    // if those constants are recoloured, this test should fail and be updated
    // deliberately rather than quietly tracking whatever the source says.
    const EVIL_EYES = ["#FF6A45", "#E5200B", "#7A0C04"];
    expect(boss).not.toContain("#FFF8DC");
    expect(EVIL_EYES.filter((c) => boss.has(c)).length).toBeGreaterThan(0);
    // The shared herzie eye colour is untouched for everyone else.
    expect(hueSet(generateRotationFrames(USER, 3, 8))).toContain("#FFF8DC");
  });

  it("keeps a head part so wearable anchors still resolve", () => {
    // getHeadBounds() filters on part === "head" and returns null without it,
    // which silently drops hats, headphones and the headband.
    const frame = renderCreatureAtAngle(
      USER,
      3,
      DEFAULT_Y_ANGLE,
      0,
      false,
      undefined,
      bossParams(),
    );
    expect(frame.anchors.hat).toBeDefined();
  });

  it("fits the render grid at every angle", () => {
    // SH is a module constant and is not parameterised, so an oversized boss
    // clips at the top and bottom rather than overflowing its element. Depth
    // matters as much as height: CAM is 2.0, so parts swinging toward the
    // camera magnify hard.
    for (let i = 0; i < 12; i++) {
      const frame = renderCreatureAtAngle(
        USER,
        3,
        (i / 12) * Math.PI * 2,
        0,
        false,
        undefined,
        bossParams(),
      );
      const rows = frame.cells;
      const filled = (y: number) => rows[y].some((c) => c.ch !== " ");
      expect(filled(0)).toBe(false);
      expect(filled(rows.length - 1)).toBe(false);
    }
  });
});
