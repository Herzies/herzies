import { describe, expect, it } from "vitest";
import {
  inWildsSafeCamp,
  nextDeparture,
  type ShipState,
  type SkyDock,
  shipState,
  WILDS_LEG_MS,
  type WildsService,
  wildsConfig,
  wildsConfigError,
} from "./wilds.js";

const S = Date.UTC(2026, 10, 21, 18);
const D = 120_000;
const H = D / 2;
const L = WILDS_LEG_MS;
/** Run 0 leaves home once it's lain there a run's stay (H - L). */
const FIRST = S + H - L;
const service = (hours = 2, every = D): WildsService => ({
  startsAt: S,
  endsAt: S + hours * 3_600_000,
  departEveryMs: every,
});

const where = (st: ShipState) =>
  st.kind === "docked" ? st.at : `${st.from}>${st.to}`;

describe("wildsConfig", () => {
  it("fills in and clamps to 96–1200 s, 120 by default", () => {
    expect(wildsConfig(null).departEverySec).toBe(120);
    expect(wildsConfig({ departEverySec: 1 }).departEverySec).toBe(96);
    expect(wildsConfig({ departEverySec: 1e9 }).departEverySec).toBe(1200);
    expect(wildsConfig({ departEverySec: 150.4 }).departEverySec).toBe(150);
  });
  it("refuses what the admin can't save", () => {
    expect(wildsConfigError({ departEverySec: 96 })).toBeNull();
    expect(wildsConfigError({ departEverySec: 1200 })).toBeNull();
    expect(wildsConfigError({ departEverySec: 95 })).toMatch(/96–1200/);
    expect(wildsConfigError({ departEverySec: 1201 })).toMatch(/96–1200/);
    expect(wildsConfigError({ departEverySec: "120" })).toMatch(/whole/);
  });
});

describe("shipState", () => {
  it("lays the ship up at home with no service", () => {
    expect(shipState(null, 0, S)).toEqual({
      kind: "docked",
      at: "home",
      since: Number.NEGATIVE_INFINITY,
      until: null,
    });
    expect(shipState(service(), 0, S - 1)).toMatchObject({ until: null });
  });

  it("walks home, the Wilds and home again, leaving each half a run apart", () => {
    const at = (t: number) => shipState(service(), 0, t);
    expect(at(S + 1000)).toMatchObject({ at: "home", until: FIRST });
    expect(at(FIRST + L / 2)).toEqual({
      kind: "flying",
      from: "home",
      to: "wilds",
      departedAt: FIRST,
      arrivesAt: FIRST + L,
    });
    expect(at(FIRST + L)).toEqual({
      kind: "docked",
      at: "wilds",
      since: FIRST + L,
      until: FIRST + H,
    });
    expect(at(FIRST + H)).toMatchObject({
      from: "wilds",
      to: "home",
      arrivesAt: FIRST + H + L,
    });
    expect(at(FIRST + H + L)).toEqual({
      kind: "docked",
      at: "home",
      since: FIRST + H + L,
      until: FIRST + D,
    });
    expect(where(at(FIRST + D + 1))).toBe("home>wilds");
  });

  it("takes nobody out after the end, but brings everyone home", () => {
    const sv = service(1);
    let lastOut = Number.NEGATIVE_INFINITY;
    let lastBack = Number.NEGATIVE_INFINITY;
    for (let t = S; t < sv.endsAt + 3 * D; t += 250) {
      const st = shipState(sv, 0, t);
      if (st.kind === "flying" && st.from === "home")
        lastOut = Math.max(lastOut, st.departedAt);
      if (st.kind === "flying" && st.from === "wilds")
        lastBack = Math.max(lastBack, st.departedAt);
    }
    expect(lastOut).toBeLessThan(sv.endsAt);
    expect(lastBack).toBe(lastOut + H);
    expect(shipState(sv, 0, sv.endsAt + 3 * D)).toMatchObject({
      at: "home",
      since: lastBack + L,
      until: null,
    });
  });

  it("brings its last run home even when the end comes while it's out", () => {
    const sv = { ...service(), endsAt: FIRST + 1 };
    expect(where(shipState(sv, 0, FIRST + L))).toBe("wilds");
    expect(shipState(sv, 0, FIRST + H + 1)).toMatchObject({ from: "wilds" });
    expect(shipState(sv, 0, FIRST + H + L)).toMatchObject({
      at: "home",
      until: null,
    });
  });

  it("never leaves home in a service too short for a run", () => {
    const sv = { ...service(), endsAt: FIRST };
    expect(shipState(sv, 0, S + 1000)).toMatchObject({ until: null });
    expect(nextDeparture(sv, "home", S)).toBeNull();
    expect(nextDeparture(sv, "wilds", S)).toBeNull();
  });

  it("moves continuously: each state's times meet the next", () => {
    const sv = service(1, 100_000);
    let prev = shipState(sv, 0, S);
    for (let t = S; t < sv.endsAt + 3 * D; t += 100) {
      const st = shipState(sv, 0, t);
      if (where(st) !== where(prev)) {
        // A change happens exactly when the last state said it would.
        const ends = prev.kind === "docked" ? prev.until : prev.arrivesAt;
        expect(ends).not.toBeNull();
        expect(t - (ends as number)).toBeGreaterThanOrEqual(0);
        expect(t - (ends as number)).toBeLessThan(100);
      }
      prev = st;
    }
  });
});

describe("nextDeparture", () => {
  it("boards at home from the start, at the Wilds once it's there", () => {
    expect(nextDeparture(service(), "home", S)).toEqual({
      ship: 0,
      dockedFrom: S,
      departsAt: FIRST,
    });
    expect(nextDeparture(service(), "home", FIRST)).toEqual({
      ship: 0,
      dockedFrom: FIRST + H + L,
      departsAt: FIRST + D,
    });
    expect(nextDeparture(service(), "wilds", S)).toEqual({
      ship: 0,
      dockedFrom: FIRST + L,
      departsAt: FIRST + H,
    });
    expect(nextDeparture(service(), "wilds", FIRST + H)).toMatchObject({
      departsAt: FIRST + H + D,
    });
  });
  it("leaves each dock every interval, agreeing with shipState", () => {
    for (const dock of ["home", "wilds"] as SkyDock[]) {
      const off = dock === "home" ? 0 : H;
      let t = S;
      for (let k = 0; k < 5; k++) {
        const next = nextDeparture(service(), dock, t);
        if (!next) throw new Error("no departure");
        expect(next.departsAt).toBe(FIRST + k * D + off);
        // Lying there since it said (at home from the start: all along).
        expect(shipState(service(), 0, next.departsAt - 1)).toMatchObject({
          at: dock,
          since:
            next.dockedFrom === S ? Number.NEGATIVE_INFINITY : next.dockedFrom,
        });
        t = next.departsAt;
      }
    }
  });
  it("runs out after the end, the Wilds last", () => {
    const sv = service(1);
    expect(nextDeparture(sv, "home", sv.endsAt)).toBeNull();
    const back = nextDeparture(sv, "wilds", sv.endsAt - H);
    expect(back).not.toBeNull();
    expect(nextDeparture(sv, "wilds", (back?.departsAt ?? 0) + 1)).toBeNull();
  });
});

describe("the safe camp", () => {
  it("holds the Wilds' spawn", () => {
    expect(inWildsSafeCamp(-66.5, 0.5)).toBe(true);
    expect(inWildsSafeCamp(0, 0)).toBe(false);
  });
});
