import {
  WILDS_DEPART_DEFAULT_S,
  WILDS_DEPART_MAX_S,
  WILDS_DEPART_MIN_S,
} from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { isEventConfigComplete, validateWildsConfig } from "./event-config";
import { adminEventSeriesSchema } from "./schemas";

describe("validateWildsConfig", () => {
  it("fills a missing interval with the default", () => {
    expect(validateWildsConfig({})).toEqual({
      config: { departEverySec: WILDS_DEPART_DEFAULT_S },
    });
  });

  it("keeps an interval in range, and nothing else", () => {
    expect(validateWildsConfig({ departEverySec: 150, stray: 1 })).toEqual({
      config: { departEverySec: 150 },
    });
    for (const departEverySec of [WILDS_DEPART_MIN_S, WILDS_DEPART_MAX_S]) {
      expect(validateWildsConfig({ departEverySec })).toEqual({
        config: { departEverySec },
      });
    }
  });

  it("refuses rather than clamps what's out of range or not whole", () => {
    for (const departEverySec of [
      WILDS_DEPART_MIN_S - 1,
      WILDS_DEPART_MAX_S + 1,
      60.5,
      "60",
      null,
    ]) {
      const result = validateWildsConfig({ departEverySec });
      expect("error" in result && result.error).toMatch(/departEverySec/);
    }
  });
});

describe("wilds in the admin", () => {
  it("is a series type", () => {
    expect(
      adminEventSeriesSchema.safeParse({
        type: "wilds",
        title: "The Wilds",
        anchorAt: "2026-11-21T19:00:00Z",
        intervalDays: 1,
        durationMinutes: 120,
      }).success,
    ).toBe(true);
  });

  it("is always ready to go live, like the SQL event_config_complete", () => {
    expect(isEventConfigComplete("wilds", {})).toBe(true);
  });
});
