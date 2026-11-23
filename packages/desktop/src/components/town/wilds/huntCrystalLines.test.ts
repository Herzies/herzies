import { WILDS_SAFE_CAMP } from "@herzies/shared/wilds";
import { huntRate } from "@herzies/shared/wilds-loot";
import { describe, expect, it } from "vitest";
import { huntCrystalLines } from "./huntCrystalLines";

const service = {
  startsAt: 1_000_000,
  endsAt: 1_000_000 + 3_600_000,
  departEveryMs: 600_000,
};
const now = service.startsAt + 60_000;

describe("huntCrystalLines", () => {
  it("says which way its treasure lies once it's full", () => {
    const lines = huntCrystalLines(
      service,
      null,
      { x: WILDS_SAFE_CAMP.x, z: WILDS_SAFE_CAMP.z - 50 },
      { charge: 1, rate: 0, listeners: 2 },
      now,
    );
    expect(lines[0]).toBe("I am full. My treasure lies to the north.");
  });

  it("says how full it is, and when it's full at this rate", () => {
    const lines = huntCrystalLines(
      service,
      null,
      null,
      { charge: 0.5, rate: huntRate(1), listeners: 1 },
      now,
    );
    expect(lines[0]).toBe("I am 50% gold. One of you plays for me.");
    expect(lines[1]).toContain("Full in 2:30");
  });

  it("asks for music when nobody's playing", () => {
    const stalled = huntCrystalLines(
      service,
      null,
      null,
      { charge: 0.42, rate: 0, listeners: 0 },
      now,
    );
    expect(stalled).toEqual(["I am 42% gold.", "Play me music. Any music."]);
  });

  it("sleeps while the Wilds are shut, whatever it last saw", () => {
    expect(huntCrystalLines(null, null, null, null, 0)).toEqual([
      "…I sleep. The Wilds are shut.",
    ]);
    const after = huntCrystalLines(
      service,
      null,
      { x: 0, z: 0 },
      { charge: 1, rate: 0, listeners: 0 },
      service.endsAt,
    );
    expect(after).toEqual(["…I sleep. The Wilds are shut."]);
  });
});
