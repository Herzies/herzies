import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesSecretTrack, processSync } from "./game-server.js";
import { WILDS_LISTEN_BONUS, WILDS_LISTEN_LABEL } from "./wilds-loot.js";

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
 * answer from `rpcs` (sync_context from `ctx`), and a table query resolves
 * to `tables[name]` (nothing if absent). Records the RPCs called.
 */
function fakeAdmin(
  ctx: unknown,
  rpcs: Record<string, Reply> = {},
  tables: Record<string, unknown> = {},
) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const query = (data: unknown = null): unknown => {
    const q: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve({ data, error: null });
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
    from: (table: string) => query(tables[table]),
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

describe("processSync on the Wilds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const soon = () => new Date(Date.now() + 60_000).toISOString();
  const ago = () => new Date(Date.now() - 1_000).toISOString();

  it("adds the Wilds' bonus while the room says you're there", async () => {
    const { admin } = fakeAdmin(context({ wilds_until: soon() }));
    const on = await processSync(admin, "u1", null, 5, []);
    expect(on.multipliers).toContainEqual({
      name: WILDS_LISTEN_LABEL,
      bonus: WILDS_LISTEN_BONUS,
    });

    const { admin: offAdmin } = fakeAdmin(context({ wilds_until: ago() }));
    const off = await processSync(offAdmin, "u1", null, 5, []);
    expect(off.multipliers.map((m) => m.name)).not.toContain(
      WILDS_LISTEN_LABEL,
    );
    // The same five minutes are worth more there.
    expect(on.herzie.xp).toBeGreaterThan(off.herzie.xp);
  });

  it("reads sync_context's wilds_until when the row lacks it", async () => {
    const { admin } = fakeAdmin(context({}, { wilds_until: soon() }));
    const result = await processSync(admin, "u1", null, 0, []);
    expect(result.multipliers.map((m) => m.name)).toContain(WILDS_LISTEN_LABEL);
  });

  /** A sync owed drop rolls (none credited this time), with a pool of
   * lutes; what it asked roll_pending_drops to put down. */
  async function rolled(herzie: Record<string, unknown>) {
    const { admin, calls } = fakeAdmin(
      context({ drop_rolls_done: 0, ...herzie }),
      { roll_pending_drops: { data: 0 } },
      { items: [{ id: "lute", rarity: "common" }] },
    );
    await processSync(admin, "u1", null, 0, []);
    const call = calls.find((c) => c.fn === "roll_pending_drops");
    return (call?.args.p_item_ids ?? []) as string[];
  }

  it("makes a share of listening's drops bits there", async () => {
    // Under WILDS_LISTEN_BIT_SHARE, and the commonest bit.
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const ids = await rolled({ wilds_until: soon() });
    // (A seasonal extra may ride along; it rolls on its own.)
    expect(new Set(ids.filter((id) => id !== "trick-or-treat"))).toEqual(
      new Set(["tonewood"]),
    );
  });

  it("rolls the pool as ever past the share, and off the Wilds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const there = await rolled({ wilds_until: soon() });
    expect(there).toContain("lute");
    expect(there).not.toContain("tonewood");

    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const away = await rolled({ wilds_until: ago() });
    expect(away).toContain("lute");
    expect(away).not.toContain("tonewood");
  });

  it("lets a worn spirit take what lies on the Wilds only while there", async () => {
    const landed = new Date(Date.now() - 60_000).toISOString();
    const sweep = async (wildsUntil: string) => {
      const { admin, calls } = fakeAdmin(
        context(
          { wilds_until: wildsUntil, equipped: { spirit: "spirit-orb" } },
          {
            pending_drops: [
              { id: "w", item_id: "tonewood", dropped_at: landed, wilds: true },
              { id: "n", item_id: "tonewood", dropped_at: landed },
            ],
          },
        ),
        { collect_pending_drop: { data: "tonewood" } },
        { items: [{ id: "tonewood", stackable: true }] },
      );
      const result = await processSync(admin, "u1", null, 0, []);
      return {
        taken: calls
          .filter((c) => c.fn === "collect_pending_drop")
          .map((c) => c.args.p_drop_id),
        left: result.pendingDrops,
      };
    };

    const away = await sweep(ago());
    expect(away.taken).toEqual(["n"]);
    // Still lying there, still the Wilds'.
    expect(away.left).toEqual([
      { id: "w", itemId: "tonewood", droppedAt: landed, wilds: true },
    ]);

    const there = await sweep(soon());
    expect(there.taken).toEqual(["w", "n"]);
    expect(there.left).toEqual([]);
  });
});
