import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { matchesSecretTrack, processSync } from "./game-server.js";

describe("matchesSecretTrack", () => {
  const hunt = {
    trackTitle: "NY Is Killing Me",
    trackArtist: "Gil Scott-Heron & Jamie xx",
  };

  it("matches however an app credits a collaboration", () => {
    // Apple Music lists every artist; Spotify only the first.
    expect(
      matchesSecretTrack(
        "NY Is Killing Me",
        "Gil Scott-Heron & Jamie xx",
        hunt,
      ),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me", "Gil Scott-Heron", hunt),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me", "Gil Scott-Heron, Jamie xx", hunt),
    ).toBe(true);
    expect(
      matchesSecretTrack(
        "NY Is Killing Me",
        "Gil Scott-Heron feat. Jamie xx",
        hunt,
      ),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me", "Gil Scott-Heron", {
        ...hunt,
        trackArtist: "Gil Scott-Heron",
      }),
    ).toBe(true);
  });

  it("still ignores case, brackets and dash suffixes", () => {
    expect(
      matchesSecretTrack(
        "ny is killing me (Remastered)",
        "GIL SCOTT-HERON",
        hunt,
      ),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me - 2011", "Gil Scott-Heron", hunt),
    ).toBe(true);
  });

  it("does not match a different lead artist or title", () => {
    expect(matchesSecretTrack("NY Is Killing Me", "Jamie xx", hunt)).toBe(
      false,
    );
    expect(
      matchesSecretTrack(
        "Home Is Where the Hatred Is",
        "Gil Scott-Heron",
        hunt,
      ),
    ).toBe(false);
  });

  it("keeps band names with an ampersand or comma whole enough to match", () => {
    const ewf = { trackTitle: "September", trackArtist: "Earth, Wind & Fire" };
    expect(matchesSecretTrack("September", "Earth, Wind & Fire", ewf)).toBe(
      true,
    );
  });
});

type Reply = { data?: unknown; error?: { message: string } };

/**
 * Just enough of a Supabase client for a sync that only listens: RPCs
 * answer from `rpcs` (sync_context from `ctx`), and every table query
 * resolves to nothing. Records the RPCs called.
 */
function fakeAdmin(ctx: unknown, rpcs: Record<string, Reply> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const query = (): unknown => {
    const q: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: null });
        }
        return () => q;
      },
    });
    return q;
  };
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "sync_context") return { data: ctx, error: null };
      const reply = rpcs[fn] ?? {};
      return { data: reply.data ?? null, error: reply.error ?? null };
    },
    from: () => query(),
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function context(
  herzie: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    herzie: {
      id: "h1",
      user_id: "u1",
      name: "Pip",
      created_at: "2020-01-01T00:00:00Z",
      appearance: {},
      xp: 0,
      level: 9,
      stage: 1,
      total_minutes_listened: 100,
      genre_minutes: {},
      friend_code: "PIP123",
      friend_codes: [],
      // Already counted today: the streak stays put.
      streak_days: 6,
      streak_last_date: new Date().toISOString().slice(0, 10),
      last_billed_at: "2020-01-01T00:00:00Z",
      // Far ahead of the minutes: no drop rolls owed.
      drop_rolls_done: 1_000_000,
      equipped: {},
      ...herzie,
    },
    item_units: [],
    multipliers: [],
    pending_drops: [],
    active_hunts: [],
    pending_trade: null,
    friend_requests: [],
    ...extra,
  };
}

const titleCalls = (calls: { fn: string; args: Record<string, unknown> }[]) =>
  calls.filter((c) => c.fn === "take_new_titles");

describe("processSync and titles", () => {
  it("grants and hands over titles when listening crosses a goal", async () => {
    // 50 h is 3000 minutes; this sync bills 5.
    const { admin, calls } = fakeAdmin(
      context({ total_minutes_listened: 2998 }),
      {
        take_new_titles: {
          data: ["original-pressing", "not-a-title", "listen-50"],
        },
      },
    );
    const result = await processSync(admin, "u1", null, 5, []);
    expect(titleCalls(calls).map((c) => c.args)).toEqual([
      { p_user: "u1", p_refresh: true },
    ]);
    // Catalog order, unknown ids left out.
    expect(result.newTitles).toEqual(["listen-50", "original-pressing"]);
    expect(
      result.notifications.filter((n) => n.title === "Title earned"),
    ).toEqual([
      expect.objectContaining({
        message: 'You earned the title "Opening Act"',
        logOnly: true,
      }),
      expect.objectContaining({
        message: 'You earned the title "Original Pressing"',
        logOnly: true,
      }),
    ]);
  });

  it("asks nothing when no goal is crossed and none are waiting", async () => {
    const { admin, calls } = fakeAdmin(context({}, { new_titles: [] }));
    const result = await processSync(admin, "u1", null, 5, []);
    expect(titleCalls(calls)).toEqual([]);
    expect(result.newTitles).toEqual([]);
  });

  it("hands over titles granted elsewhere without granting again", async () => {
    const { admin, calls } = fakeAdmin(
      context({}, { new_titles: ["duel-1", "duel-10", "tower-10"] }),
      { take_new_titles: { data: ["duel-1", "duel-10", "tower-10"] } },
    );
    const result = await processSync(admin, "u1", null, 0, []);
    expect(titleCalls(calls).map((c) => c.args)).toEqual([
      { p_user: "u1", p_refresh: false },
    ]);
    expect(result.newTitles).toEqual(["tower-10", "duel-1", "duel-10"]);
    // Three or more: one line in the activity feed, not one each.
    expect(
      result.notifications.filter((n) => n.title.startsWith("Title")),
    ).toEqual([
      expect.objectContaining({
        title: "Titles earned",
        message: "You earned 3 titles",
      }),
    ]);
  });

  it("keeps them waiting when taking them fails", async () => {
    const { admin } = fakeAdmin(context({ total_minutes_listened: 2998 }), {
      take_new_titles: { error: { message: "boom" } },
    });
    const result = await processSync(admin, "u1", null, 5, []);
    expect(result.newTitles).toEqual([]);
  });

  it("carries the worn title and the loadouts", async () => {
    const loadouts = { active: 2, inactive: [] };
    const { admin } = fakeAdmin(context({ title: "duel-1" }, { loadouts }));
    const result = await processSync(admin, "u1", null, 0, []);
    expect(result.herzie.title).toBe("duel-1");
    expect(result.loadouts).toEqual(loadouts);
  });
});
