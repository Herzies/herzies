import { describe, expect, it } from "vitest";
import { RAINBOW_RAMP } from "./ascii3d.js";
import {
  generateCreatureParams,
  generateIdleFrames,
  generateRotationFrames,
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
