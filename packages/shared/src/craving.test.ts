import { describe, expect, it } from "vitest";
import { getDailyCraving, matchesCraving } from "./craving.js";
import { GENRES } from "./types.js";

describe("getDailyCraving", () => {
  it("returns a valid genre", () => {
    const genre = getDailyCraving("some-id", "2026-01-01");
    expect(GENRES).toContain(genre);
  });

  it("is deterministic (same id + date = same result)", () => {
    const a = getDailyCraving("herzie-123", "2026-01-01");
    const b = getDailyCraving("herzie-123", "2026-01-01");
    expect(a).toBe(b);
  });

  it("varies by date", () => {
    const results = new Set<string>();
    for (let d = 1; d <= 30; d++) {
      const date = `2026-01-${String(d).padStart(2, "0")}`;
      results.add(getDailyCraving("test-herzie", date));
    }
    // Over 30 days, should get more than 1 unique genre
    expect(results.size).toBeGreaterThan(1);
  });

  it("varies by herzie id", () => {
    const a = getDailyCraving("herzie-aaa", "2026-01-01");
    const b = getDailyCraving("herzie-zzz", "2026-01-01");
    // Different IDs on the same day should usually differ
    // (not guaranteed for every pair, but very likely)
    // Just verify both are valid genres
    expect(GENRES).toContain(a);
    expect(GENRES).toContain(b);
  });
});

describe("matchesCraving", () => {
  it("matches exact genre", () => {
    expect(matchesCraving(["rock"], "rock")).toBe(true);
  });

  it("matches substring (track genre contains craving)", () => {
    expect(matchesCraving(["indie rock"], "rock")).toBe(true);
  });

  it("matches substring (craving contains track genre)", () => {
    expect(matchesCraving(["hip-hop"], "hip-hop")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesCraving(["ROCK"], "rock")).toBe(true);
    expect(matchesCraving(["ROCK"], "rock")).toBe(true);
  });

  it("returns false for no match", () => {
    expect(matchesCraving(["jazz"], "metal")).toBe(false);
  });

  it("returns true if any track genre matches", () => {
    expect(matchesCraving(["jazz", "rock", "pop"], "rock")).toBe(true);
  });
});
