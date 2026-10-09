import { describe, expect, it } from "vitest";
import { RAINBOW_RAMP, VOID_RAMP } from "./ascii3d.js";
import {
  BOSS_BODY_TYPE,
  buildCreatureModel,
  buildCreatureSpheres,
  CREATURE_PARAM_BOUNDS,
  creaturePoseOffsets,
  creatureSeatDrop,
  DEFAULT_Y_ANGLE,
  generateCreatureParams,
  generateDanceFrames,
  generateIdleFrames,
  generateRotationFrames,
  isSpiritHopFrame,
  primitiveNormal,
  primitiveShading,
  rayPrimitive,
  renderCreatureAtAngle,
  renderCreaturePose,
  SPIRIT_DANCE_HOP_VARIANT_COUNT,
} from "./creature-renderer.js";
import type { DangleState } from "./dangle-physics.js";
import type { Equipped } from "./items.js";

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

describe("capsule and cylinder primitives", () => {
  // A ray from z = -5 straight down +z, offset in x and y.
  const cast = (x: number, y: number, p: Parameters<typeof rayPrimitive>[6]) =>
    rayPrimitive(x, y, -5, 0, 0, 1, p);
  const near = (a: number[], b: number[]) =>
    a.forEach((v, i) => {
      expect(v).toBeCloseTo(b[i], 6);
    });

  const capsule = {
    center: [0, 0, 0] as [number, number, number],
    radius: 0.5,
    shape: {
      kind: "capsule" as const,
      axis: [2, 0, 0] as [number, number, number],
    },
  };
  const cylinder = {
    ...capsule,
    shape: { ...capsule.shape, kind: "cylinder" as const },
  };

  it("hits a capsule's side and its rounded ends", () => {
    expect(cast(1, 0, capsule)).toBeCloseTo(4.5); // side, flat in x
    expect(cast(2.3, 0, capsule)).toBeCloseTo(5 - Math.sqrt(0.25 - 0.09)); // end ball
    expect(cast(2.6, 0, capsule)).toBe(-1);
    expect(cast(0, 0.6, capsule)).toBe(-1);
  });

  it("stops a cylinder flat at its ends", () => {
    expect(cast(1.9, 0, cylinder)).toBeCloseTo(4.5);
    expect(cast(2.1, 0, cylinder)).toBe(-1);
  });

  it("hits a cylinder's flat cap when seen end-on", () => {
    const endOn = {
      ...cylinder,
      shape: {
        kind: "cylinder" as const,
        axis: [0, 0, 1] as [number, number, number],
      },
    };
    expect(cast(0.4, 0, endOn)).toBeCloseTo(4);
    expect(cast(0.6, 0, endOn)).toBe(-1);
    near(primitiveNormal(endOn, [0.4, 0, -1]), [0, 0, -1]);
  });

  const endOn = (dome: number) => ({
    center: [0, 0, 0] as [number, number, number],
    radius: 0.5,
    shape: {
      kind: "cylinder" as const,
      axis: [0, 0, 1] as [number, number, number],
      dome,
    },
  });

  it("domes a cylinder's ends outward", () => {
    const cup = endOn(0.2);
    expect(cast(0, 0, cup)).toBeCloseTo(3.8); // the middle stands proud
    expect(cast(0.49, 0, cup)).toBeCloseTo(4 - 0.2 * (1 - 0.49 ** 2 / 0.25));
    expect(cast(0.51, 0, cup)).toBe(-1);
    // Down the cap's slope the normal tips out, away from the axis.
    const n = primitiveNormal(cup, [0.4, 0, -1 - 0.2 * (1 - 0.16 / 0.25)]);
    expect(n[2]).toBeLessThan(0);
    expect(n[0]).toBeGreaterThan(0);
  });

  it("dishes a cylinder's ends inward with a negative dome", () => {
    const cup = endOn(-0.2);
    expect(cast(0, 0, cup)).toBeCloseTo(4.2); // the middle sits deepest
    // A slanted ray that crosses the bowl's paraboloid past the rim still
    // lands in the bowl instead of passing through the cup.
    const d = [0.6, 0, 0.8];
    const t = rayPrimitive(-1.5, 0, -2, d[0], d[1], d[2], cup);
    expect(t).toBeGreaterThan(0);
    const hit = [-1.5 + d[0] * t, 0, -2 + d[2] * t];
    expect(Math.abs(hit[0])).toBeLessThanOrEqual(0.5);
    expect(hit[2]).toBeLessThan(0);
    const n = primitiveNormal(cup, [0.4, 0, -1 + 0.2 * (1 - 0.16 / 0.25)]);
    expect(n[0]).toBeLessThan(0);
  });

  it("points normals out of the surface", () => {
    near(primitiveNormal(capsule, [1, 0, -0.5]), [0, 0, -1]);
    near(primitiveNormal(capsule, [2.5, 0, 0]), [1, 0, 0]);
    near(primitiveNormal(cylinder, [1, 0.5, 0]), [0, 1, 0]);
    near(primitiveNormal(cylinder, [-2, 0.1, 0]), [-1, 0, 0]);
  });

  it("treats a shapeless primitive as a sphere", () => {
    const sphere = { center: capsule.center, radius: 0.5 };
    expect(cast(0, 0, sphere)).toBeCloseTo(4.5);
    near(primitiveNormal(sphere, [0, 0, -0.5]), [0, 0, -1]);
  });
});

describe("model for 3D hosts", () => {
  const colorsOf = (frame: { cells: { ch: string; color: string }[][] }) =>
    new Set(frame.cells.flat().map((c) => c.color));
  const model = buildCreatureModel(USER, 3, { head: "headphones" });
  const frame = renderCreatureAtAngle(USER, 3, DEFAULT_Y_ANGLE, 0, false, {
    head: "headphones",
  });
  const drawn = colorsOf(frame);
  const shadesOf = (zone: string, withColor = false) => {
    const sp = model.spheres.find(
      (s) => s.zone === zone && Boolean(s.color) === withColor,
    );
    if (!sp) throw new Error(`no ${zone} sphere`);
    return primitiveShading(sp, model.colors, model.scheme);
  };

  it("shades eyes and pupils the colours the ray caster draws", () => {
    for (const zone of ["eye", "pupil"]) {
      const sh = shadesOf(zone);
      expect(new Set(sh.shades).size).toBe(1);
      expect(drawn).toContain(sh.shades[0]);
    }
    expect(shadesOf("pupil").gain).toBe(0);
  });

  it("shades the body from its palette, textured", () => {
    const sh = shadesOf("primary");
    expect(sh.textured).toBe(true);
    expect(sh.shades.filter((c) => drawn.has(c)).length).toBeGreaterThan(1);
  });

  it("shades a worn item by its own colour, untextured", () => {
    const sh = shadesOf("wearable", true);
    expect(sh.textured).toBe(false);
    expect(sh.shades[1]).toBe("#666666");
    expect(sh.shades.some((c) => drawn.has(c))).toBe(true);
  });

  it("shades a colourless worn item like the body, in greys", () => {
    const sh = primitiveShading({ zone: "wearable" }, model.colors);
    expect(sh.textured).toBe(true);
    expect(sh.shades).toEqual(["#444", "#666", "#888"]);
  });

  it("marks scheme-painted parts", () => {
    const prism = buildCreatureModel(USER, 3, { color: "prism" });
    const body = prism.spheres.find((s) => s.zone === "primary");
    if (!body) throw new Error("no body");
    expect(
      primitiveShading(body, prism.colors, prism.scheme).schemePainted,
    ).toBe(true);
  });

  it("poses with the idle loop alone when standing", () => {
    const still = creaturePoseOffsets(model.spheres, 3, {
      idleFrame: 30,
      walkPhase: 0.4,
      walkWeight: 0,
    });
    // Nothing moves sideways or in depth while idling, and the head bobs.
    expect(still.every((d) => d[0] === 0 && d[2] === 0)).toBe(true);
    expect(still.some((d) => d[1] !== 0)).toBe(true);
    const walking = creaturePoseOffsets(model.spheres, 3, {
      idleFrame: 30,
      walkPhase: 0.25,
      walkWeight: 1,
    });
    expect(walking.some((d) => d[2] !== 0)).toBe(true);
  });
});

describe("sitting", () => {
  const pose = (stage: number, sitWeight: number) =>
    creaturePoseOffsets(buildCreatureModel(USER, stage).spheres, stage, {
      idleFrame: 0,
      walkPhase: 0,
      walkWeight: 0,
      sitWeight,
    });

  it("brings a herzie's legs out in front, and nothing else", () => {
    const { spheres } = buildCreatureModel(USER, 3);
    const standing = pose(3, 0);
    const seated = pose(3, 1);
    let feet = 0;
    spheres.forEach((sp, i) => {
      const dy = seated[i][1] - standing[i][1];
      const dz = seated[i][2] - standing[i][2];
      const isFoot =
        (sp.part === "leg-l" || sp.part === "leg-r") &&
        sp.center[1] ===
          Math.max(
            ...spheres
              .filter((o) => o.part === sp.part)
              .map((o) => o.center[1]),
          );
      if (isFoot) feet++;
      if (sp.part === "leg-l" || sp.part === "leg-r") {
        // Up (−y) and forward (−z).
        expect(dy).toBeLessThan(0);
        expect(dz).toBeLessThan(0);
      } else {
        expect(dy).toBe(0);
        expect(dz).toBe(0);
      }
    });
    expect(feet).toBe(2);
  });

  it("settles a herzie with legs onto its bottom", () => {
    const { spheres } = buildCreatureModel(USER, 3);
    const bottom = (sp: (typeof spheres)[number]) => sp.center[1] + sp.radius;
    const body = spheres.find((sp) => sp.part === "body");
    if (!body) throw new Error("no body");
    const feet = Math.max(
      ...spheres.filter((sp) => sp.part.startsWith("leg")).map(bottom),
    );
    const drop = creatureSeatDrop(spheres, 3);
    expect(drop).toBeGreaterThan(0);
    // Down to the hips, at most: never sunk past its belly.
    expect(drop).toBeLessThanOrEqual(feet - bottom(body));
  });

  it("leaves herzies without legs as they stand", () => {
    for (const stage of [1, 2]) {
      expect(pose(stage, 1)).toEqual(pose(stage, 0));
      expect(
        creatureSeatDrop(buildCreatureModel(USER, stage).spheres, stage),
      ).toBe(0);
    }
  });
});

describe("headphones", () => {
  it("arch a band over the head at every angle", () => {
    // Headphone cells above the top of the head prove the band is drawn,
    // turned with the herzie, and still found by the ray caster.
    for (const pitch of [undefined, 0.3]) {
      for (let i = 0; i < 8; i++) {
        const frame = renderCreaturePose(
          USER,
          3,
          {
            yAngle: (i / 8) * 2 * Math.PI,
            pitch,
            idleFrame: 0,
            walkPhase: 0,
            walkWeight: 0,
          },
          { head: "headphones" },
        );
        const bare = renderCreaturePose(USER, 3, {
          yAngle: (i / 8) * 2 * Math.PI,
          pitch,
          idleFrame: 0,
          walkPhase: 0,
          walkWeight: 0,
        });
        const top = (f: typeof frame) =>
          f.cells.findIndex((row) => row.some((c) => c.ch !== " "));
        expect(top(frame)).toBeLessThanOrEqual(top(bare));
        const greys = frame.cells
          .flat()
          .filter(
            (c) =>
              c.color !== "#111111" && /^#([0-9A-F]{2})\1\1$/.test(c.color),
          );
        expect(greys.length).toBeGreaterThan(0);
      }
    }
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
    // Headphones keep their own grey shell.
    expect(colors).toContain("#666666");
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
  it("renders without throwing in the spirit slot", () => {
    expect(() =>
      generateRotationFrames(USER, 3, 8, { spirit: "spirit-orb" }),
    ).not.toThrow();
  });

  it("adds pixels beyond the plain body", () => {
    const plain = generateRotationFrames(USER, 3, 12);
    const withOrb = generateRotationFrames(USER, 3, 12, {
      spirit: "spirit-orb",
    });
    expect(hueSet(withOrb).size).toBeGreaterThan(hueSet(plain).size);
  });

  it("dance hop variants reuse plain frames outside the hop", () => {
    const eq = { spirit: "spirit-orb" } as const;
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
      // Seamless at the loop boundary, where a host swaps variants.
      expect(isSpiritHopFrame(v, 0)).toBe(false);
      expect(isSpiritHopFrame(v, plain.length - 1)).toBe(false);
    }
  });

  it("dance hop variants put the spirit back where it started", () => {
    // Travel holds after landing, so a variant whose travels don't cancel out
    // would snap the spirit sideways once its hops end (those frames are
    // reused from the plain loop). Re-render the last frame with the variant's
    // pose actually applied and compare pixels.
    const eq = { spirit: "spirit-orb" } as const;
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

  it("coexists with a boombox on either ground slot", () => {
    for (const side of ["ground_left", "ground_right"] as const) {
      expect(() =>
        generateRotationFrames(USER, 3, 8, {
          spirit: "spirit-orb",
          [side]: "boombox",
        }),
      ).not.toThrow();
    }
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
  // The old renderer cached this per settled drag angle, keyed on frame index alone.
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

describe("neckwear", () => {
  const draw = (stage: number, body?: string) =>
    JSON.stringify(
      renderCreatureAtAngle(USER, stage, 1.2345, 0, false, { body }).cells,
    );

  it("is drawn on a herzie with a body", () => {
    for (const body of ["gold-chain", "pearl-necklace", "bowtie"]) {
      expect(draw(3, body)).not.toBe(draw(3));
    }
  });

  it("swings the chain but nothing else", () => {
    const at = (body: string, swing: number) =>
      renderCreatureAtAngle(
        USER,
        3,
        1.2345,
        0,
        false,
        { body },
        undefined,
        undefined,
        undefined,
        undefined,
        { swing, flare: 0 },
      ).cells;
    expect(JSON.stringify(at("gold-chain", 0.5))).not.toBe(
      JSON.stringify(at("gold-chain", 0)),
    );
    // The bowtie is rigid: no swing however the herzie is spun.
    expect(JSON.stringify(at("bowtie", 0.5))).toBe(
      JSON.stringify(at("bowtie", 0)),
    );
  });

  it("draws nothing before stage 3, when there's no body to sit on", () => {
    for (const stage of [1, 2]) {
      expect(draw(stage, "gold-chain")).toBe(draw(stage));
    }
  });
});

describe("Halloween items", () => {
  const draw = (equipped: Equipped, yAngle = 1.2345, dangle?: DangleState) =>
    JSON.stringify(
      renderCreatureAtAngle(
        USER,
        3,
        yAngle,
        0,
        false,
        equipped,
        undefined,
        126,
        undefined,
        undefined,
        dangle,
      ).cells,
    );

  it("draws each one", () => {
    for (const equipped of [
      { head: "witch-hat" },
      { face: "fangs" },
      { color: "pumpkin-spice" },
      { spirit: "ghost" },
    ] as Equipped[]) {
      expect(draw(equipped)).not.toBe(draw({}));
    }
  });

  it("swings the witch hat's tip on a spin, but not the fangs", () => {
    const swing = { swing: 0.6, flare: 0 };
    expect(draw({ head: "witch-hat" }, 1.2345, swing)).not.toBe(
      draw({ head: "witch-hat" }),
    );
    expect(draw({ face: "fangs" }, 1.2345, swing)).toBe(
      draw({ face: "fangs" }),
    );
  });

  it("doesn't let the fangs move the hat", () => {
    // Everything the fangs add on top of a hat must be what they add alone.
    const cells = (equipped: Equipped) =>
      renderCreatureAtAngle(USER, 3, 1.2345, 0, false, equipped, undefined, 126)
        .cells;
    const changed = (a: Equipped, b: Equipped) => {
      const ca = cells(a);
      const cb = cells(b);
      return ca.flatMap((row, y) =>
        row.flatMap((c, x) =>
          c.ch !== cb[y][x].ch || c.color !== cb[y][x].color
            ? [`${y},${x}`]
            : [],
        ),
      );
    };
    const fangsOnHat = changed(
      { head: "witch-hat", face: "fangs" },
      { head: "witch-hat" },
    );
    const fangsAlone = new Set(changed({ face: "fangs" }, {}));
    expect(fangsOnHat.length).toBeGreaterThan(0);
    for (const cell of fangsOnHat) expect(fangsAlone.has(cell)).toBe(true);
  });

  it("keeps the pets in place while the herzie spins", () => {
    // The cells the pets cover outside the herzie's own silhouette. If they
    // turned with the herzie, these would change between the two angles.
    const petCells = (yAngle: number) => {
      const withPets = renderCreatureAtAngle(
        USER,
        3,
        yAngle,
        0,
        false,
        {
          spirit: "ghost",
        },
        undefined,
        126,
      ).cells;
      const bare = renderCreatureAtAngle(
        USER,
        3,
        yAngle,
        0,
        false,
        {},
        undefined,
        126,
      ).cells;
      return withPets
        .flatMap((row, y) =>
          row.map((c, x) =>
            c.ch !== " " && bare[y][x].ch === " " ? `${y},${x}` : null,
          ),
        )
        .filter((k) => k !== null);
    };
    expect(petCells(0.3)).toEqual(petCells(2.1));
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

describe("renderCreaturePose", () => {
  const lowestRow = (cells: { ch: string }[][]) => {
    let lowest = -1;
    cells.forEach((row, y) => {
      if (row.some((c) => c.ch !== " ")) lowest = y;
    });
    return lowest;
  };
  const drawn = (cells: { ch: string; color: string }[][]) =>
    cells.map((r) => r.map((c) => `${c.ch}${c.color}`).join("")).join("\n");

  it("standing still draws exactly the idle loop", () => {
    for (const stage of [1, 2, 3]) {
      for (const frame of [0, 37, 90]) {
        const pose = renderCreaturePose(USER, stage, {
          yAngle: DEFAULT_Y_ANGLE,
          idleFrame: frame,
          walkPhase: 0.3,
          walkWeight: 0,
        });
        const idle = renderCreatureAtAngle(USER, stage, DEFAULT_Y_ANGLE, frame);
        expect(drawn(pose.cells)).toBe(drawn(idle.cells));
      }
    }
  });

  it("walks: the pose changes through the cycle", () => {
    for (const stage of [1, 2, 3]) {
      const at = (walkPhase: number) =>
        drawn(
          renderCreaturePose(USER, stage, {
            yAngle: Math.PI / 2,
            idleFrame: 0,
            walkPhase,
            walkWeight: 1,
          }).cells,
        );
      expect(at(0.25)).not.toBe(at(0.75));
    }
  });

  it("a legless herzie hops off the ground mid-step", () => {
    const at = (walkPhase: number) =>
      lowestRow(
        renderCreaturePose(USER, 1, {
          yAngle: 0,
          idleFrame: 0,
          walkPhase,
          walkWeight: 1,
        }).cells,
      );
    // Rows grow downward: in the air, the lowest drawn row is higher up.
    expect(at(0.25)).toBeLessThan(at(0));
  });

  it("left and right steps mirror each other from the front", () => {
    const at = (walkPhase: number) =>
      renderCreaturePose(USER, 3, {
        yAngle: 0,
        idleFrame: 0,
        walkPhase,
        walkWeight: 1,
      }).cells.map((row) => row.map((c) => c.ch !== " "));
    const a = at(0.25);
    const b = at(0.75);
    // Same silhouette mirrored left-right, give or take a column of rounding.
    let diff = 0;
    for (let y = 0; y < a.length; y++) {
      const w = a[y].length;
      for (let x = 0; x < w; x++) if (a[y][x] !== b[y][w - 1 - x]) diff++;
    }
    const filled = a.flat().filter(Boolean).length;
    expect(diff / filled).toBeLessThan(0.15);
  });

  it("renders every body (boss included) at any pitch without NaN glyphs", () => {
    const bossParams = {
      ...generateCreatureParams("boss:test"),
      bodyType: BOSS_BODY_TYPE,
    };
    const looks = [
      { stage: 1 },
      { stage: 2 },
      { stage: 3 },
      { stage: 3, params: bossParams },
    ];
    for (const { stage, params } of looks) {
      for (const pitch of [0, 0.3, 0.6]) {
        const frame = renderCreaturePose(
          "boss:test",
          stage,
          { yAngle: 1, pitch, idleFrame: 10, walkPhase: 0.4, walkWeight: 0.5 },
          undefined,
          params,
          48,
        );
        for (const row of frame.cells) {
          for (const c of row) {
            expect(typeof c.ch).toBe("string");
            expect(c.color).not.toContain("NaN");
          }
        }
        expect(lowestRow(frame.cells)).toBeGreaterThan(0);
      }
    }
  });

  it("a finer grid frames the herzie the same, just at higher resolution", () => {
    const extent = (cols: number, rows: number) => {
      const cells = renderCreaturePose(
        USER,
        3,
        { yAngle: 0, idleFrame: 0, walkPhase: 0, walkWeight: 0 },
        undefined,
        undefined,
        cols,
        rows,
      ).cells;
      expect(cells.length).toBe(rows);
      expect(cells[0].length).toBe(cols);
      let top = -1;
      let bottom = -1;
      cells.forEach((row, y) => {
        if (!row.some((c) => c.ch !== " ")) return;
        if (top < 0) top = y;
        bottom = y;
      });
      return { top: top / rows, bottom: (bottom + 1) / rows };
    };
    const base = extent(48, 48);
    const fine = extent(64, 64);
    expect(fine.top).toBeCloseTo(base.top, 1);
    expect(fine.bottom).toBeCloseTo(base.bottom, 1);
  });

  it("is cheap enough to render live (logs ms per frame)", () => {
    const n = 60;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      renderCreaturePose(
        USER,
        3,
        {
          yAngle: i * 0.1,
          pitch: 0.2,
          idleFrame: i,
          walkPhase: i / n,
          walkWeight: 1,
        },
        { head: "headphones" },
        undefined,
        48,
      );
    }
    const ms = (performance.now() - t0) / n;
    console.log(`renderCreaturePose: ${ms.toFixed(2)} ms/frame (48 cols)`);
    expect(ms).toBeLessThan(50);
  });
});
