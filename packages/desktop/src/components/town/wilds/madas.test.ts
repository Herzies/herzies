import { WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import {
  WILDS_CACHE_EVERY_MS,
  WILDS_CACHE_FIRST_MS,
  wildsCacheAt,
} from "@herzies/shared/wilds-loot";
import { describe, expect, it } from "vitest";
import { MADAS_FLAVOUR_LINES, madasLines, nextCacheAt } from "./madas";

const service = {
  startsAt: 1_000_000,
  endsAt: 1_000_000 + 3_600_000,
  departEveryMs: 600_000,
};
const first = service.startsAt + WILDS_CACHE_FIRST_MS;

describe("nextCacheAt", () => {
  it("is when the cache after the one out now turns up", () => {
    expect(nextCacheAt(service, service.startsAt)).toBe(first);
    // Just as one turns up, and a moment later: the one after.
    for (const now of [first, first + 1, first + WILDS_CACHE_EVERY_MS - 1]) {
      const next = nextCacheAt(service, now);
      expect(next).toBe(first + WILDS_CACHE_EVERY_MS);
      // The room agrees: a new cache, numbered on from now's.
      expect(
        wildsCacheAt("e", service.startsAt, service.endsAt, next ?? 0)?.k,
      ).toBe(
        (wildsCacheAt("e", service.startsAt, service.endsAt, now)?.k ?? -1) + 1,
      );
    }
  });

  it("is none past the last before they close", () => {
    const short = { ...service, endsAt: first + WILDS_CACHE_EVERY_MS };
    expect(nextCacheAt(short, first + 1)).toBeNull();
  });
});

describe("madasLines", () => {
  it("says where the cache is out and when the next turns up", () => {
    const now = first + 60_000;
    const lines = madasLines(
      service,
      null,
      { x: WILDS_SAFE_CAMP.x, z: WILDS_SAFE_CAMP.z - 50 },
      now,
    );
    expect(lines[0]).toContain("There's one out now, to the north!");
    expect(lines).toContain(
      "The next one turns up in 4:00. I can feel it in my teeth.",
    );
    expect(lines.slice(-MADAS_FLAVOUR_LINES.length)).toEqual([
      ...MADAS_FLAVOUR_LINES,
    ]);
  });

  it("says nothing of a cache he can't see", () => {
    const lines = madasLines(service, null, null, first + 60_000);
    expect(lines.some((l) => l.includes("out now"))).toBe(false);
  });

  it("frets while the Wilds are shut", () => {
    const lines = madasLines(null, null, null, 0);
    expect(lines[0]).toBe(
      "Closed. The Wilds are closed. Who closed them? Was it you?",
    );
    // And after they close, the cache he last saw is no more.
    const after = madasLines(service, null, { x: 0, z: 0 }, service.endsAt);
    expect(after.some((l) => l.includes("out now"))).toBe(false);
  });
});
