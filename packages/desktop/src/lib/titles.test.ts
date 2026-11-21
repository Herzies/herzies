import { TITLES, type TitleDef } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { announceTitles, shownRungs, titleFamilies } from "./titles";

const family = (id: string) => {
  const found = titleFamilies().find((f) => f.rungs.some((r) => r.id === id));
  if (!found) throw new Error(`no family for ${id}`);
  return found;
};
const ids = (defs: TitleDef[]) => defs.map((d) => d.id);

describe("titleFamilies", () => {
  it("keeps every title, in catalog order", () => {
    expect(titleFamilies().flatMap((f) => ids(f.rungs))).toEqual(
      TITLES.map((t) => t.id),
    );
  });

  it("makes one ladder of each run on a metric", () => {
    expect(ids(family("listen-200").rungs)).toEqual([
      "listen-50",
      "listen-100",
      "listen-200",
      "listen-500",
      "listen-1000",
    ]);
  });

  it("leaves a different metric in the same category on its own", () => {
    expect(ids(family("genres-all").rungs)).toEqual(["genres-all"]);
  });

  it("leaves a title without a metric on its own", () => {
    expect(ids(family("original-pressing").rungs)).toEqual([
      "original-pressing",
    ]);
  });
});

describe("shownRungs", () => {
  const listening = family("listen-50");

  it("shows the first rung before any is earned", () => {
    expect(ids(shownRungs(listening, new Set(), false))).toEqual(["listen-50"]);
  });

  it("shows the highest earned rung and the next", () => {
    const earned = new Set(["listen-50", "listen-100"]);
    expect(ids(shownRungs(listening, earned, false))).toEqual([
      "listen-100",
      "listen-200",
    ]);
  });

  it("shows only the top rung once the ladder's done", () => {
    const earned = new Set(listening.rungs.map((r) => r.id));
    expect(ids(shownRungs(listening, earned, false))).toEqual(["listen-1000"]);
  });

  it("shows the whole ladder when opened", () => {
    expect(shownRungs(listening, new Set(), true)).toHaveLength(5);
  });
});

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
