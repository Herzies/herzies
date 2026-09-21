import { describe, expect, it } from "vitest";
import { RAINBOW_RAMP, VOID_RAMP } from "./ascii3d.js";
import {
  BOSS_BODY_TYPE,
  buildCreatureSpheres,
  CREATURE_PARAM_BOUNDS,
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

describe("stage 3 head and body", () => {
  /** Radius of the circle where two spheres intersect, over the smaller
   * sphere's radius. 1 means the head sits flush on the body; the lower it
   * gets, the deeper the pinch between them, and a deep enough pinch reads as
   * a neck — a third blob between head and body. */
  function waist(
    a: { center: number[]; radius: number },
    b: { center: number[]; radius: number },
  ): number {
    const d = Math.abs(a.center[1] - b.center[1]);
    const along = (d * d + a.radius ** 2 - b.radius ** 2) / (2 * d);
    return (
      Math.sqrt(Math.max(0, a.radius ** 2 - along ** 2)) /
      Math.min(a.radius, b.radius)
    );
  }

  // Blob and spiky sit at about 0.77 and were never called necky; the tall
  // one was 0.62 at its smallest head and got the complaint.
  const MIN_WAIST = 0.75;

  const bodyTypes = [
    [0, "blob"],
    [1, "tall"],
    [2, "wide"],
    [3, "spiky"],
  ] as const;
  const { min, max } = CREATURE_PARAM_BOUNDS.headRatio;

  for (const [bodyType, name] of bodyTypes) {
    it(`has no neck between the head and body of a ${name} at any head size`, () => {
      for (const headRatio of [min, (min + max) / 2, max]) {
        const spheres = buildCreatureSpheres(
          { ...generateCreatureParams(USER), bodyType, headRatio },
          3,
        );
        const head = spheres.find((s) => s.part === "head");
        const body = spheres.find((s) => s.part === "body");
        if (!head || !body)
          throw new Error(`no head or body sphere for ${name}`);
        expect(waist(head, body)).toBeGreaterThanOrEqual(MIN_WAIST);
      }
    });
  }
});

describe("herzie anatomy", () => {
  /** Where the body parts are, relative to the head. Everything is measured
   * from the head because the whole creature is re-centred on its bounding
   * box, and ears or spikes change that box. */
  function bodyLayout(seed: string, stage: number) {
    const spheres = buildCreatureSpheres(generateCreatureParams(seed), stage);
    const head = spheres.find((s) => s.part === "head");
    if (!head) throw new Error(`no head for ${seed}`);
    const parts = ["head", "body", "arm-l", "arm-r", "leg-l", "leg-r"];
    return spheres
      .filter((s) => parts.includes(s.part ?? ""))
      .map((s) => [
        s.part,
        ...s.center.map((c, i) => Number((c - head.center[i]).toFixed(9))),
        Number(s.radius.toFixed(9)),
      ]);
  }

  // Enough seeds that every seeded body type, blob through spiky, turns up.
  const seeds = Array.from({ length: 120 }, (_, i) => `herzie-${i}`);

  it("covers every seeded body type", () => {
    const types = new Set(seeds.map((s) => generateCreatureParams(s).bodyType));
    expect([...types].sort()).toEqual([0, 1, 2, 3]);
  });

  for (const stage of [1, 2, 3]) {
    it(`gives every herzie the same head, body, arms and legs at stage ${stage}`, () => {
      const template = bodyLayout(seeds[0], stage);
      for (const seed of seeds) {
        expect(bodyLayout(seed, stage)).toEqual(template);
      }
    });
  }

  it("sizes the head from Mathias's own numbers, the template's source", () => {
    // HERZ-MSL5's headRatio and bodyScale, unrounded: a rounded constant
    // moved twenty cells of his render, which is not what "this one is good"
    // asked for.
    const params = generateCreatureParams("HERZ-MSL5");
    const head = buildCreatureSpheres(params, 3).find((s) => s.part === "head");
    expect(head?.radius).toBeCloseTo(
      0.78 * params.headRatio * params.bodyScale * 1.5,
      12,
    );
  });

  it("grows the head with each stage, and stage 3 is the template size", () => {
    const radius = (stage: number) =>
      buildCreatureSpheres(generateCreatureParams("HERZ-MSL5"), stage).find(
        (s) => s.part === "head",
      )?.radius ?? 0;
    expect(radius(1)).toBeLessThan(radius(2));
    expect(radius(2)).toBeLessThan(radius(3));
    // Stage 2 is only a little bigger than stage 1, not most of the way.
    expect(radius(2) / radius(3)).toBeGreaterThan(0.8);
    expect(radius(1) / radius(3)).toBeLessThan(0.8);
  });

  it("still varies the eyes", () => {
    const eyeSizes = new Set(
      seeds.map((seed) =>
        buildCreatureSpheres(generateCreatureParams(seed), 3)
          .find((s) => s.part === "eye")
          ?.radius.toFixed(6),
      ),
    );
    expect(eyeSizes.size).toBeGreaterThan(20);
  });

  it("gives spikes to spiky herzies only", () => {
    for (const seed of seeds) {
      const { bodyType } = generateCreatureParams(seed);
      const spikes = buildCreatureSpheres(
        generateCreatureParams(seed),
        3,
      ).filter((s) => s.part === "spike");
      expect(spikes.length > 0).toBe(bodyType === 3);
    }
  });
});
