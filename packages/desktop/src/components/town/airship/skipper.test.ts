import { nextDeparture, type WildsService } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { skipperLines } from "./skipper";
import { clock, sailingTime } from "./status";

const T = Date.UTC(2026, 10, 23, 18);
const service: WildsService = {
  startsAt: T,
  endsAt: T + 3_600_000,
  departEveryMs: 120_000,
};

describe("skipperLines", () => {
  it("says she's sailing, and when she next leaves Town", () => {
    const now = T + 10 * 60_000 + 5_000;
    const next = nextDeparture(service, "home", now);
    expect(next).not.toBeNull();
    const lines = skipperLines(service, null, now);
    expect(lines[0]).toMatch(/^Sofia III's sailing\. She/);
    expect(lines[1]).toContain(clock((next?.departsAt ?? 0) - now));
  });

  it("says her last sailing's done once the service is over", () => {
    const now = service.endsAt + 5 * 60_000;
    const upcoming = T + 86_400_000;
    const lines = skipperLines(service, upcoming, now);
    expect(lines[0]).toContain("last sailing");
    expect(lines[1]).toContain(sailingTime(upcoming, now));
  });

  it("says when she sails, when one's planned", () => {
    const now = T - 3 * 3_600_000;
    const lines = skipperLines(null, T, now);
    expect(lines[0]).toContain("laid up");
    expect(lines[1]).toContain(sailingTime(T, now));
  });

  it("says nothing's planned, when nothing is", () => {
    const lines = skipperLines(null, null, T);
    expect(lines.join(" ")).toContain("nothing on the timetable");
  });
});
