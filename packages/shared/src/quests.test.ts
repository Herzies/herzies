import { describe, expect, it } from "vitest";
import { PIP_KEY } from "./pip.js";
import { genreInTags, getPipGenre, normTag, PIP_GENRES } from "./pip-genres.js";
import { dailyQuestFor, OLDIE_YEARS, QUESTS, questOfferFor } from "./quests.js";

/** A day Pip hands out the given kind, searching forward from Nov 1 2026. */
function dayFor(kind: string): string {
  const d = new Date("2026-11-01T00:00:00Z");
  for (let i = 0; i < 400; i++) {
    const day = d.toISOString().slice(0, 10);
    if (dailyQuestFor(PIP_KEY, day)?.kind === kind) return day;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error(`no ${kind} day`);
}

describe("Pip's quests", () => {
  it("rotates all three kinds", () => {
    const kinds = QUESTS.filter((q) => q.giver === PIP_KEY).map((q) => q.kind);
    expect(kinds.sort()).toEqual(["genre", "new_artist", "oldie"]);
    for (const k of kinds) expect(dayFor(k)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("offers the same genre to a player all day, named in the text", () => {
    const day = dayFor("genre");
    const a = questOfferFor(PIP_KEY, "user-a", day);
    const b = questOfferFor(PIP_KEY, "user-a", day);
    expect(a).toEqual(b);
    const genre = getPipGenre(a?.params.genre ?? "");
    expect(genre).toBeDefined();
    expect(a?.title).toContain(genre?.name);
    expect(a?.description).toContain(genre?.name);
  });

  it("never offers a genre the player already found", () => {
    const day = dayFor("genre");
    const first = questOfferFor(PIP_KEY, "user-a", day)?.params.genre;
    const next = questOfferFor(PIP_KEY, "user-a", day, [first ?? ""]);
    expect(next?.params.genre).not.toBe(first);
    // Every genre found: he starts over rather than offering nothing.
    const all = PIP_GENRES.map((g) => g.key);
    expect(
      questOfferFor(PIP_KEY, "user-a", day, all)?.params.genre,
    ).toBeTruthy();
  });

  it("asks for songs from before a year between 1940 and 2000", () => {
    const day = dayFor("oldie");
    const offer = questOfferFor(PIP_KEY, "user-a", day);
    expect(OLDIE_YEARS).toContain(offer?.params.before);
    expect(OLDIE_YEARS[0]).toBe(1940);
    expect(OLDIE_YEARS[OLDIE_YEARS.length - 1]).toBe(2000);
    expect(offer?.title).toBe(`Before ${offer?.params.before}`);
  });
});

describe("genre tags", () => {
  it("ignores case, accents, spaces and dashes", () => {
    expect(normTag("Tropicália")).toBe(normTag("tropicalia"));
    expect(normTag("Post-Rock")).toBe(normTag("post rock"));
    expect(normTag("chopped & screwed")).toBe(normTag("Chopped and Screwed"));
  });

  it("matches whole tags and aliases only", () => {
    const dub = getPipGenre("dub");
    const footwork = getPipGenre("footwork");
    if (!dub || !footwork) throw new Error("missing genre");
    expect(genreInTags(dub, ["dubstep", "electronic"])).toBe(false);
    expect(genreInTags(dub, ["Dub", "reggae"])).toBe(true);
    expect(genreInTags(footwork, ["juke"])).toBe(true);
  });

  it("has unique keys and no game genre", () => {
    const keys = PIP_GENRES.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    const game = [
      "pop",
      "rock",
      "hiphop",
      "electronic",
      "jazz",
      "classical",
      "rnb",
      "country",
      "metal",
      "indie",
      "latin",
      "folk",
      "blues",
      "punk",
      "soul",
    ];
    for (const g of PIP_GENRES) expect(game).not.toContain(normTag(g.name));
  });
});
