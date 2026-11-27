import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  inCatalogOrder,
  syncTitleMetrics,
  TITLES,
  type TitleDef,
  titleGoalReached,
} from "./titles.js";
import { GENRES } from "./types.js";

describe("the titles catalog", () => {
  it("matches the titles table refresh_titles grants from", () => {
    // Each migration's seed in turn, a later row for an id replacing the
    // earlier one (as its `on conflict` does).
    type Row = {
      id: string;
      metric: string | null;
      goal: number | null;
      retired: boolean;
    };
    const table = new Map<string, Row>();
    for (const file of [
      "00152_titles_duels_loadouts.sql",
      "00168_boss_awards.sql",
    ]) {
      const sql = readFileSync(
        new URL(`../../../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      );
      const seed = sql.slice(
        sql.indexOf("insert into public.titles"),
        sql.indexOf("on conflict (id) do update"),
      );
      for (const [, id, metric, goal, retired] of seed.matchAll(
        /\('([a-z0-9-]+)', (?:'([a-zA-Z]+)'|null), (\d+|null), (true|false)\)/g,
      )) {
        table.set(id, {
          id,
          metric: metric ?? null,
          goal: goal === "null" ? null : Number(goal),
          retired: retired === "true",
        });
      }
    }
    expect(
      [...table.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      TITLES.map(
        (t: TitleDef): Row => ({
          id: t.id,
          metric: t.metric ?? null,
          goal: t.goal ?? null,
          retired: t.retired === true,
        }),
      ).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("has unique ids, and a goal with every metric", () => {
    expect(new Set(TITLES.map((t) => t.id)).size).toBe(TITLES.length);
    for (const t of TITLES as readonly TitleDef[]) {
      expect(!!t.metric, t.id).toBe(t.goal !== undefined);
    }
  });
});

describe("a sync's title check", () => {
  const herzie = {
    totalMinutesListened: 2998.6,
    level: 9,
    streakDays: 6,
    genreMinutes: { pop: 61, rock: 59.9 } as Record<string, number>,
  };

  it("reads the metrics a sync moves the way the database counts them", () => {
    expect(syncTitleMetrics(herzie)).toEqual({
      minutes: 2998,
      level: 9,
      streak: 6,
      genres: 1,
    });
  });

  it("asks for a grant only when a goal is crossed", () => {
    const before = syncTitleMetrics(herzie);
    // 50 h is 3000 minutes.
    expect(titleGoalReached(before, { ...before, minutes: 3000 })).toBe(true);
    expect(titleGoalReached(before, { ...before, minutes: 2999 })).toBe(false);
    expect(titleGoalReached(before, { ...before, streak: 7 })).toBe(true);
    // A level jump past a goal counts too.
    expect(titleGoalReached(before, { ...before, level: 12 })).toBe(true);
    expect(titleGoalReached(before, before)).toBe(false);
  });

  it("doesn't ask again once past a goal", () => {
    const past = { minutes: 3100, level: 11, streak: 8, genres: 3 };
    expect(titleGoalReached(past, { ...past, minutes: 3200 })).toBe(false);
    // A streak that broke and climbs back past 7 is a crossing again: the
    // grant is a no-op if it's already earned.
    expect(
      titleGoalReached({ ...past, streak: 6 }, { ...past, streak: 7 }),
    ).toBe(true);
  });

  it("ignores metrics only one side has", () => {
    expect(titleGoalReached({ level: 9 }, { minutes: 999_999 })).toBe(false);
  });

  it("counts every genre for Genre Hopper", () => {
    const all = Object.fromEntries(GENRES.map((g) => [g, 60]));
    const before = syncTitleMetrics({
      ...herzie,
      genreMinutes: { ...all, soul: 59 },
    });
    const after = syncTitleMetrics({ ...herzie, genreMinutes: all });
    expect(after.genres).toBe(15);
    expect(titleGoalReached(before, after)).toBe(true);
  });
});

describe("inCatalogOrder", () => {
  it("orders ids as the catalog does and drops unknown ones", () => {
    expect(
      inCatalogOrder(["duel-1", "nope", "listen-50", "original-pressing"]),
    ).toEqual(["listen-50", "duel-1", "original-pressing"]);
  });
});
