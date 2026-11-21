import {
  type GameEvent,
  WILDS_DEPART_DEFAULT_S,
  WILDS_DEPART_MAX_S,
} from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { wildsFeed } from "./wildsFeed";

const event = (
  type: string,
  startsAt: string,
  endsAt: string,
  config: Record<string, unknown> = {},
): GameEvent => ({
  id: `${type}-${startsAt}`,
  type,
  title: "The Wilds",
  description: null,
  active: true,
  startsAt,
  endsAt,
  config,
});

describe("wildsFeed", () => {
  it("is quiet with no wilds event", () => {
    const tower = event(
      "tower",
      "2026-11-01T00:00:00Z",
      "2026-12-01T00:00:00Z",
    );
    expect(wildsFeed([tower], [])).toEqual({ service: null, upcomingAt: null });
  });

  it("turns the running event into a timetable", () => {
    const on = event("wilds", "2026-11-21T19:00:00Z", "2026-11-21T21:00:00Z", {
      departEverySec: 150,
    });
    const next = event("wilds", "2026-11-22T19:00:00Z", "2026-11-22T21:00:00Z");
    expect(wildsFeed([on], [next])).toEqual({
      service: {
        startsAt: Date.parse("2026-11-21T19:00:00Z"),
        endsAt: Date.parse("2026-11-21T21:00:00Z"),
        departEveryMs: 150_000,
      },
      // One's on: tomorrow's isn't news yet.
      upcomingAt: null,
    });
  });

  it("fills a missing interval and clamps a wild one", () => {
    const at = ["2026-11-21T19:00:00Z", "2026-11-21T21:00:00Z"] as const;
    expect(wildsFeed([event("wilds", ...at)], []).service?.departEveryMs).toBe(
      WILDS_DEPART_DEFAULT_S * 1000,
    );
    expect(
      wildsFeed([event("wilds", ...at, { departEverySec: 1e6 })], []).service
        ?.departEveryMs,
    ).toBe(WILDS_DEPART_MAX_S * 1000);
  });

  it("takes the latest started of two overlapping", () => {
    const early = event(
      "wilds",
      "2026-11-21T18:00:00Z",
      "2026-11-21T20:00:00Z",
    );
    const late = event("wilds", "2026-11-21T19:00:00Z", "2026-11-21T21:00:00Z");
    expect(wildsFeed([late, early], []).service?.startsAt).toBe(
      Date.parse(late.startsAt),
    );
  });

  it("gives the next start when none is on", () => {
    const boss = event(
      "boss_fight",
      "2026-11-22T10:00:00Z",
      "2026-11-22T12:00:00Z",
    );
    const next = event("wilds", "2026-11-22T19:00:00Z", "2026-11-22T21:00:00Z");
    expect(wildsFeed([], [boss, next])).toEqual({
      service: null,
      upcomingAt: Date.parse("2026-11-22T19:00:00Z"),
    });
  });
});
