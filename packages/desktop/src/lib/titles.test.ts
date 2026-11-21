import type { TitleDef } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { announceTitles, heldByLabel } from "./titles";

const ids = (defs: TitleDef[]) => defs.map((d) => d.id);

describe("announceTitles", () => {
  it("announces one or two titles each on their own", () => {
    expect(announceTitles(["listen-50", "duel-1"])).toEqual([
      { kind: "one", def: expect.objectContaining({ id: "listen-50" }) },
      { kind: "one", def: expect.objectContaining({ id: "duel-1" }) },
    ]);
  });

  it("sums up three or more, rarest first", () => {
    const [summary] = announceTitles([
      "listen-50",
      "original-pressing",
      "tower-100",
    ]);
    expect(summary.kind).toBe("many");
    if (summary.kind !== "many") return;
    expect(ids(summary.defs)).toEqual([
      "tower-100",
      "original-pressing",
      "listen-50",
    ]);
  });

  it("skips ids this app doesn't know", () => {
    expect(announceTitles(["from-the-future"])).toEqual([]);
  });
});

describe("heldByLabel", () => {
  it("says a tenth of a percent under 10%, whole ones above", () => {
    expect(heldByLabel(32, 1000)).toBe("Held by 3.2% of herzies");
    expect(heldByLabel(1, 1000)).toBe("Held by 0.1% of herzies");
    expect(heldByLabel(5, 10)).toBe("Held by 50% of herzies");
    expect(heldByLabel(123, 1000)).toBe("Held by 12% of herzies");
  });

  it("rounds across 10% to a whole number", () => {
    expect(heldByLabel(996, 10_000)).toBe("Held by 10% of herzies");
    expect(heldByLabel(994, 10_000)).toBe("Held by 9.9% of herzies");
  });

  it("never rounds to nothing, nor to everyone while some lack it", () => {
    expect(heldByLabel(1, 5000)).toBe("Held by <0.1% of herzies");
    expect(heldByLabel(999, 1000)).toBe("Held by 99% of herzies");
    expect(heldByLabel(7, 7)).toBe("Held by 100% of herzies");
  });

  it("counts you among the holders, whatever an old server says", () => {
    expect(heldByLabel(0, 4)).toBe("Held by 25% of herzies");
    expect(heldByLabel(3, 0)).toBe("Held by 100% of herzies");
  });
});
