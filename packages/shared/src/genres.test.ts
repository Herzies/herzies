import { describe, expect, it } from "vitest";
import { classifyGenre, recordGenreMinutes } from "./genres.js";

describe("classifyGenre", () => {
  it("maps rap to hip-hop", () => {
    expect(classifyGenre(["rap"])).toContain("hip-hop");
  });

  it("maps trap to hip-hop", () => {
    expect(classifyGenre(["trap"])).toContain("hip-hop");
  });

  it("maps edm to electronic", () => {
    expect(classifyGenre(["edm"])).toContain("electronic");
  });

  it("maps house to electronic", () => {
    expect(classifyGenre(["house"])).toContain("electronic");
  });

  it("maps alt to indie", () => {
    expect(classifyGenre(["alt-rock"])).toContain("indie");
  });

  it("maps hardcore to metal", () => {
    expect(classifyGenre(["hardcore"])).toContain("metal");
  });

  it("maps reggaeton to latin", () => {
    expect(classifyGenre(["reggaeton"])).toContain("latin");
  });

  it("maps rnb to r&b", () => {
    expect(classifyGenre(["rnb"])).toContain("r&b");
  });

  it("directly matches genre names", () => {
    expect(classifyGenre(["rock"])).toContain("rock");
    expect(classifyGenre(["jazz"])).toContain("jazz");
    expect(classifyGenre(["classical"])).toContain("classical");
  });

  it("falls back to pop for unknown genres", () => {
    expect(classifyGenre(["xyzunknown"])).toEqual(["pop"]);
  });

  it("matches multiple genres from one input", () => {
    const result = classifyGenre(["pop rock"]);
    expect(result).toContain("pop");
    expect(result).toContain("rock");
  });
});

describe("recordGenreMinutes", () => {
  it("splits minutes evenly across genres", () => {
    const gm: Record<string, number> = {};
    recordGenreMinutes(gm, ["rock", "pop"], 10);
    expect(gm.rock).toBe(5);
    expect(gm.pop).toBe(5);
  });

  it("accumulates across multiple calls", () => {
    const gm: Record<string, number> = {};
    recordGenreMinutes(gm, ["rock"], 10);
    recordGenreMinutes(gm, ["rock"], 5);
    expect(gm.rock).toBe(15);
  });

  it("handles single genre", () => {
    const gm: Record<string, number> = {};
    recordGenreMinutes(gm, ["jazz"], 8);
    expect(gm.jazz).toBe(8);
  });
});
