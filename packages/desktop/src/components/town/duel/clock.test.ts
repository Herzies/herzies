import { DUEL, duelCountdownMs } from "@herzies/shared/duel";
import { describe, expect, it } from "vitest";
import { countdownBeat, duelClock, mmss } from "./clock";

describe("duelClock", () => {
  const d = {
    startsAt: 0,
    suddenAt: DUEL.regulationMs,
    endsAt: DUEL.hardCapMs,
  };

  it("stays hidden until the last 30 s of regulation", () => {
    expect(duelClock(d, -500).shown).toBe(false);
    expect(duelClock(d, 10_000).shown).toBe(false);
    const late = duelClock(d, DUEL.regulationMs - 30_000);
    expect(late).toMatchObject({ shown: true, sudden: false, ms: 30_000 });
  });

  it("counts down to the hard end through sudden death", () => {
    const c = duelClock(d, DUEL.regulationMs + 1000);
    expect(c.sudden).toBe(true);
    expect(c.ms).toBe(DUEL.hardCapMs - DUEL.regulationMs - 1000);
    expect(duelClock(d, DUEL.hardCapMs + 5).ms).toBe(0);
  });

  it("reads as minutes and seconds, rounded up", () => {
    expect(mmss(47_000)).toBe("0:47");
    expect(mmss(23_100)).toBe("0:24");
    expect(mmss(60_000)).toBe("1:00");
    expect(mmss(-5)).toBe("0:00");
  });
});

describe("countdownBeat", () => {
  it("runs VS, 3, 2, 1, FIGHT! up to the start", () => {
    const at = 1000;
    const startsAt = at + duelCountdownMs(true);
    const beats = [0, DUEL.introMs, DUEL.introMs + DUEL.countMs]
      .concat([DUEL.introMs + 2 * DUEL.countMs, duelCountdownMs(true)])
      .map((t) => countdownBeat(at, startsAt, true, at + t + 1).beat);
    expect(beats).toEqual(["vs", 3, 2, 1, "fight"]);
  });

  it("goes straight to 3 on a rematch", () => {
    const at = 0;
    const startsAt = duelCountdownMs(false);
    expect(countdownBeat(at, startsAt, false, 1).beat).toBe(3);
    expect(countdownBeat(at, startsAt, false, startsAt - 1).beat).toBe(1);
  });

  it("says how far into each beat it is, for its animation", () => {
    const startsAt = 3 * DUEL.countMs;
    expect(countdownBeat(0, startsAt, false, DUEL.countMs + 200)).toEqual({
      beat: 2,
      since: 200,
    });
  });
});
