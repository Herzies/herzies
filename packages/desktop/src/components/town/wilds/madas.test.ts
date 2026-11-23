import { WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import { huntRate } from "@herzies/shared/wilds-loot";
import { describe, expect, it } from "vitest";
import { MADAS_FLAVOUR_LINES, madasLines } from "./madas";

const service = {
  startsAt: 1_000_000,
  endsAt: 1_000_000 + 3_600_000,
  departEveryMs: 600_000,
};
const now = service.startsAt + 60_000;

describe("madasLines", () => {
  it("says where the cache is out", () => {
    const lines = madasLines(
      service,
      null,
      { x: WILDS_SAFE_CAMP.x, z: WILDS_SAFE_CAMP.z - 50 },
      { charge: 1, rate: 0, listeners: 2 },
      now,
    );
    expect(lines[0]).toContain("There's one out now, to the north!");
    expect(lines.slice(-MADAS_FLAVOUR_LINES.length)).toEqual([
      ...MADAS_FLAVOUR_LINES,
    ]);
  });

  it("says how full the crystal is, and when it's full at this rate", () => {
    const lines = madasLines(
      service,
      null,
      null,
      { charge: 0.5, rate: huntRate(1), listeners: 1 },
      now,
    );
    expect(lines[0]).toBe(
      "The crystal's 50% gold. One of you's playing. More! Louder! More of you!",
    );
    expect(lines[1]).toContain("full in 2:30");
  });

  it("begs for music when nobody's playing", () => {
    const dull = madasLines(
      service,
      null,
      null,
      { charge: 0, rate: 0, listeners: 0 },
      now,
    );
    expect(dull[0]).toContain("It wants music");
    const stalled = madasLines(
      service,
      null,
      null,
      { charge: 0.42, rate: 0, listeners: 0 },
      now,
    );
    expect(stalled[0]).toContain("42% gold and nobody's playing");
  });

  it("says nothing of a cache or a crystal he can't see", () => {
    const lines = madasLines(service, null, null, null, now);
    expect(lines.some((l) => l.includes("out now"))).toBe(false);
    expect(lines.some((l) => l.includes("% gold"))).toBe(false);
  });

  it("frets while the Wilds are shut", () => {
    const lines = madasLines(null, null, null, null, 0);
    expect(lines[0]).toBe(
      "Closed. The Wilds are closed. Who closed them? Was it you?",
    );
    // And after they close, the cache he last saw is no more.
    const after = madasLines(
      service,
      null,
      { x: 0, z: 0 },
      null,
      service.endsAt,
    );
    expect(after.some((l) => l.includes("out now"))).toBe(false);
  });
});
