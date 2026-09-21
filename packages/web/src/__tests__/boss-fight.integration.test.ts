/**
 * Integration tests for the Boss Fight event (00073, 00074).
 *
 * These run against real Postgres because the thing under test IS the
 * concurrency behaviour of the SQL — a mocked client cannot fail the way a
 * lost update fails. The overkill test in particular passes trivially if run
 * serially, so it drives parallel connections on purpose.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as syncRoute } from "@/app/api/sync/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();

/** "techno" is not one of the 15 GENRES — classifyGenre maps it here. */
const HATED = ["electronic"];

async function spawnBoss(hp: number, endsInMs = 3_600_000) {
  const { data, error } = await admin().rpc("spawn_boss_fight", {
    p_hated_genres: HATED,
    p_hp: hp,
    p_ends_at: new Date(Date.now() + endsInMs).toISOString(),
    p_title: "Test Boss",
  });
  if (error) throw new Error(error.message);
  return data as string | null;
}

async function makePlayer() {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { inventory_v2: {} });
  return user;
}

async function hit(eventId: string, userId: string, damage: number) {
  const { data, error } = await admin().rpc("deal_boss_damage", {
    p_event_id: eventId,
    p_user_id: userId,
    p_damage: damage,
  });
  if (error) throw new Error(error.message);
  return (data ?? [])[0] as
    | { hp: number; is_killing_blow: boolean }
    | undefined;
}

async function bossState(eventId: string) {
  const { data } = await admin()
    .from("boss_state")
    .select("*")
    .eq("event_id", eventId)
    .single();
  return data as {
    hp: number;
    killed: boolean;
    settled: boolean;
    escaped: boolean;
  };
}

async function inventoryOf(userId: string) {
  const { data } = await admin()
    .from("herzies")
    .select("inventory_v2")
    .eq("user_id", userId)
    .single();
  return (data?.inventory_v2 ?? {}) as Record<string, number>;
}

beforeEach(async () => {
  setLocalEnv();
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("spawning", () => {
  it("refuses to spawn a second boss while one is live", async () => {
    const first = await spawnBoss(500);
    expect(first).toBeTruthy();
    // The cron can retry, and a dev can run this by hand during testing.
    // Two live bosses makes "the active boss" undefined.
    expect(await spawnBoss(500)).toBeNull();
  });

  it("spawns a four-day window by default", async () => {
    const { data: id } = await admin().rpc("spawn_boss_fight", {
      p_hated_genres: HATED,
      p_hp: 500,
    });
    const { data: event } = await admin()
      .from("events")
      .select("starts_at, ends_at, config")
      .eq("id", id)
      .single();
    const span =
      new Date(event!.ends_at).getTime() - new Date(event!.starts_at).getTime();
    expect(span).toBe(4 * 24 * 60 * 60 * 1000);
    expect(event!.config.hatedGenres).toEqual(HATED);
  });

  it("never rolls pop as a hated genre", async () => {
    // Pop is the fallback for unmatched tags, the Spotify path and Last.fm
    // timeouts, so a pop-hating boss takes damage from nearly every listen.
    for (let i = 0; i < 40; i++) {
      await cleanupTestData();
      const { data: id } = await admin().rpc("spawn_boss_fight", {});
      const { data: event } = await admin()
        .from("events")
        .select("config")
        .eq("id", id)
        .single();
      expect(event!.config.hatedGenres).not.toContain("pop");
      expect(event!.config.hatedGenres).toHaveLength(3);
    }
  });
});

describe("damage", () => {
  it("accumulates per player and decrements shared HP", async () => {
    const boss = (await spawnBoss(100))!;
    const a = await makePlayer();
    const b = await makePlayer();

    await hit(boss, a.userId, 10);
    await hit(boss, a.userId, 5);
    await hit(boss, b.userId, 20);

    expect((await bossState(boss)).hp).toBeCloseTo(65, 5);

    const { data: rows } = await admin()
      .from("boss_damage")
      .select("user_id, damage")
      .eq("event_id", boss);
    const byUser = Object.fromEntries(
      (rows ?? []).map((r) => [r.user_id, r.damage]),
    );
    expect(byUser[a.userId]).toBeCloseTo(15, 5);
    expect(byUser[b.userId]).toBeCloseTo(20, 5);
  });

  it("ignores non-positive damage", async () => {
    const boss = (await spawnBoss(100))!;
    const a = await makePlayer();
    await hit(boss, a.userId, 0);
    await hit(boss, a.userId, -50);
    expect((await bossState(boss)).hp).toBe(100);
  });

  it("refuses damage once the window has closed", async () => {
    const boss = (await spawnBoss(100, -1000))!; // already ended
    const a = await makePlayer();
    await hit(boss, a.userId, 40);
    expect((await bossState(boss)).hp).toBe(100);
  });

  it("clamps HP at zero rather than going negative", async () => {
    const boss = (await spawnBoss(30))!;
    const a = await makePlayer();
    const res = await hit(boss, a.userId, 500);
    expect(res!.hp).toBe(0);
    expect((await bossState(boss)).killed).toBe(true);
  });
});

describe("the killing blow", () => {
  it("loses no damage when 20 players hit at once", async () => {
    // THE lost-update detector, and it has to be run with HP high enough that
    // every hit is accepted — under overkill the boss legitimately refuses
    // the tail, which would mask a lost update as "expected" shortfall.
    // Serial execution passes even with a read-modify-write bug, so these
    // fire on parallel connections on purpose.
    const boss = (await spawnBoss(1000))!;
    const players = await Promise.all(
      Array.from({ length: 20 }, () => makePlayer()),
    );

    await Promise.all(players.map((p) => hit(boss, p.userId, 10)));

    // 20 x 10 = 200 damage, every point of it accounted for.
    expect((await bossState(boss)).hp).toBeCloseTo(800, 5);
    const { data: rows } = await admin()
      .from("boss_damage")
      .select("damage")
      .eq("event_id", boss);
    expect(rows).toHaveLength(20);
    expect((rows ?? []).reduce((s, r) => s + r.damage, 0)).toBeCloseTo(200, 5);
  });

  it("fires exactly once under parallel overkill", async () => {
    const boss = (await spawnBoss(100))!;
    const players = await Promise.all(
      Array.from({ length: 10 }, () => makePlayer()),
    );

    const results = await Promise.all(
      players.map((p) => hit(boss, p.userId, 20)),
    );

    // The whole reward path hangs off this being 1.
    expect(results.filter((r) => r?.is_killing_blow).length).toBe(1);

    const state = await bossState(boss);
    expect(state.hp).toBe(0);
    expect(state.killed).toBe(true);

    // Five hits of 20 finish a 100 HP boss; the rest are refused outright
    // rather than queued, so only the accepted hits are on the ledger.
    const { data: rows } = await admin()
      .from("boss_damage")
      .select("damage")
      .eq("event_id", boss);
    expect((rows ?? []).reduce((s, r) => s + r.damage, 0)).toBeCloseTo(100, 5);
  });

  it("stops accepting damage after death", async () => {
    const boss = (await spawnBoss(10))!;
    const a = await makePlayer();
    const b = await makePlayer();
    await hit(boss, a.userId, 10);
    const late = await hit(boss, b.userId, 50);
    expect(late?.is_killing_blow).toBe(false);

    const { data: rows } = await admin()
      .from("boss_damage")
      .select("user_id")
      .eq("event_id", boss);
    expect(rows).toHaveLength(1);
  });
});

describe("settling", () => {
  it("pays every participant once and is safe to re-run", async () => {
    const boss = (await spawnBoss(60))!;
    const players = await Promise.all(
      Array.from({ length: 4 }, () => makePlayer()),
    );
    // Distinct damage so ranks are unambiguous.
    await hit(boss, players[0].userId, 30);
    await hit(boss, players[1].userId, 20);
    await hit(boss, players[2].userId, 8);
    await hit(boss, players[3].userId, 2);

    expect((await bossState(boss)).killed).toBe(true);

    const { data: paid } = await admin().rpc("settle_boss_fight", {
      p_event_id: boss,
    });
    expect(paid).toBe(4);

    // Top 3 get base + gold; everyone else gets base only. Both ids are "cd"
    // in this config, so the top three hold 2 and the tail holds 1.
    expect((await inventoryOf(players[0].userId)).cd).toBe(2);
    expect((await inventoryOf(players[2].userId)).cd).toBe(2);
    expect((await inventoryOf(players[3].userId)).cd).toBe(1);

    // Re-running must be a no-op — this is what makes a cron-driven settle
    // safe, and what lets a half-finished payout be recovered.
    const { data: again } = await admin().rpc("settle_boss_fight", {
      p_event_id: boss,
    });
    expect(again).toBe(0);
    expect((await inventoryOf(players[0].userId)).cd).toBe(2);
    expect((await bossState(boss)).settled).toBe(true);
  });

  it("recovers a half-finished payout", async () => {
    const boss = (await spawnBoss(40))!;
    const players = await Promise.all(
      Array.from({ length: 4 }, () => makePlayer()),
    );
    // Distinct damage on purpose: ties break on user_id, which is a random
    // uuid, so equal damage makes top-3 membership nondeterministic.
    await hit(boss, players[0].userId, 16);
    await hit(boss, players[1].userId, 12);
    await hit(boss, players[2].userId, 8);
    await hit(boss, players[3].userId, 4);

    await admin().rpc("settle_boss_fight", { p_event_id: boss });

    // Simulate a payout that died halfway through: for the first two players
    // neither the claim nor the grant ever landed. Rolling back the claim
    // alone would not be faithful — it would make a correct re-run look like
    // a double-pay.
    const unpaid = [players[0].userId, players[1].userId];
    await admin()
      .from("event_claims")
      .delete()
      .eq("event_id", boss)
      .in("user_id", unpaid);
    await admin()
      .from("herzies")
      .update({ inventory_v2: {} })
      .in("user_id", unpaid);
    await admin()
      .from("boss_state")
      .update({ settled: false })
      .eq("event_id", boss);

    const { data: paid } = await admin().rpc("settle_boss_fight", {
      p_event_id: boss,
    });
    expect(paid).toBe(2);

    // The two who missed out are now paid, at their correct rank.
    expect((await inventoryOf(players[0].userId)).cd).toBe(2);
    expect((await inventoryOf(players[1].userId)).cd).toBe(2);
    // And the two already paid were not paid a second time.
    expect((await inventoryOf(players[2].userId)).cd).toBe(2);
    expect((await inventoryOf(players[3].userId)).cd).toBe(1);
  });

  it("does not settle a boss that is still alive", async () => {
    const boss = (await spawnBoss(100))!;
    const a = await makePlayer();
    await hit(boss, a.userId, 10);
    const { data: paid } = await admin().rpc("settle_boss_fight", {
      p_event_id: boss,
    });
    expect(paid).toBe(0);
    expect(await inventoryOf(a.userId)).toEqual({});
  });
});

describe("escaping", () => {
  it("grants nothing when the timer runs out", async () => {
    const boss = (await spawnBoss(1000, -1000))!; // ends in the past
    const a = await makePlayer();

    const { data: escaped } = await admin().rpc("resolve_boss_fight", {});
    expect(escaped).toBe(1);

    const state = await bossState(boss);
    expect(state.escaped).toBe(true);
    expect(state.killed).toBe(false);
    expect(await inventoryOf(a.userId)).toEqual({});

    const { data: event } = await admin()
      .from("events")
      .select("active")
      .eq("id", boss)
      .single();
    expect(event!.active).toBe(false);

    // And an escaped boss frees the slot for next Thursday.
    expect(await spawnBoss(500)).toBeTruthy();
  });
});

describe("leaderboard", () => {
  it("ranks damage dealers by damage descending", async () => {
    const boss = (await spawnBoss(1000))!;
    const players = await Promise.all(
      Array.from({ length: 4 }, () => makePlayer()),
    );
    await hit(boss, players[0].userId, 5);
    await hit(boss, players[1].userId, 50);
    await hit(boss, players[2].userId, 20);
    await hit(boss, players[3].userId, 1);

    const { data } = await admin().rpc("boss_leaderboard", {
      p_event_id: boss,
      p_limit: 3,
    });
    const rows = data as { user_id: string; damage: number; rank: number }[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.damage)).toEqual([50, 20, 5]);
    expect(rows[0].user_id).toBe(players[1].userId);
  });
});

/**
 * Damage from actually listening, through the real /sync route and the
 * canonical processSync — the piece that was missing entirely before: the
 * tests above only ever call deal_boss_damage directly.
 */
describe("damage from listening", () => {
  /**
   * Rewind both billing clocks. Without this every sync after the first lands
   * inside BILL_COOLDOWN_MS (8s), bills zero minutes, and deals zero damage —
   * which would read as a broken hook rather than a throttled test.
   * `last_billed_at` is what processSync measures from; `last_synced_at` only
   * falls back for rows predating that column.
   */
  async function backdate(userId: string, msAgo = 10 * 60_000) {
    const at = new Date(Date.now() - msAgo).toISOString();
    await admin()
      .from("herzies")
      .update({ last_synced_at: at, last_billed_at: at })
      .eq("user_id", userId);
  }

  async function listen(
    user: { userId: string; accessToken: string },
    genres: string[],
    minutes = 5,
  ) {
    await backdate(user.userId);
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Track", artist: "Artist" },
        minutesListened: minutes,
        genres,
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  async function damageOf(eventId: string, userId: string) {
    const { data } = await admin()
      .from("boss_damage")
      .select("damage")
      .eq("event_id", eventId)
      .eq("user_id", userId)
      .maybeSingle();
    return data?.damage ?? 0;
  }

  it("damages the boss by the minutes billed for a hated genre", async () => {
    const boss = (await spawnBoss(500))!;
    const player = await makePlayer();

    // A raw Last.fm tag, not the GENRES value: "techno" is classified onto
    // "electronic", which is what this boss hates.
    await listen(player, ["techno"], 5);

    expect(await damageOf(boss, player.userId)).toBeCloseTo(5, 5);
    expect((await bossState(boss)).hp).toBeCloseTo(495, 5);
  });

  it("deals more damage with sonic power equipped", async () => {
    const boss = (await spawnBoss(500))!;
    const plain = await makePlayer();
    const boomer = await createTestUser();
    // Box of Boom: +10 sonic power, which is +10% damage.
    await createTestHerzie(boomer.userId, {
      inventory_v2: {},
      equipped: { ground_left: "boombox" },
    });

    await listen(plain, ["techno"], 5);
    await listen(boomer, ["techno"], 5);

    // The plain player in the same test is the baseline, so the delta is the
    // claim rather than a magic number.
    const base = await damageOf(boss, plain.userId);
    expect(base).toBeCloseTo(5, 4);
    expect(await damageOf(boss, boomer.userId)).toBeCloseTo(base * 1.1, 4);
  });

  it("deals nothing for a genre the boss doesn't hate", async () => {
    const boss = (await spawnBoss(500))!;
    const player = await makePlayer();

    await listen(player, ["jazz"], 5);

    expect(await damageOf(boss, player.userId)).toBe(0);
    expect((await bossState(boss)).hp).toBe(500);
  });

  it("deals nothing when the track has no tags at all", async () => {
    // XP falls back to classifying an empty tag list as ["pop"]. The boss
    // path must not inherit that: "we don't know what this is" is not a hit.
    const boss = (await spawnBoss(500))!;
    const player = await makePlayer();

    await listen(player, [], 5);

    expect(await damageOf(boss, player.userId)).toBe(0);
  });

  it("hits on any classified genre, not just the first", async () => {
    // listen_log only keeps classifyGenre(...)[0]; damage must not.
    const boss = (await spawnBoss(500))!;
    const player = await makePlayer();

    await listen(player, ["jazz", "techno"], 5);

    expect(await damageOf(boss, player.userId)).toBeCloseTo(5, 5);
  });

  it("uses billed minutes, not the minutes the client claims", async () => {
    // The client asserts minutesListened. The server caps it at 10 per sync,
    // and that capped number is what must reach the boss.
    const boss = (await spawnBoss(500))!;
    const player = await makePlayer();

    await listen(player, ["techno"], 10);
    const first = await damageOf(boss, player.userId);
    // Must see damage land first. Without this the assertion below passes
    // vacuously — 0 before, 0 after — on a hook that never fires at all.
    expect(first).toBeCloseTo(10, 5);

    // Inside the cooldown, the same claim bills nothing and so deals nothing.
    await syncRoute(
      authenticatedRequest("/sync", player.accessToken, {
        nowPlaying: { title: "Track", artist: "Artist" },
        minutesListened: 10,
        genres: ["techno"],
      }),
    );

    expect(await damageOf(boss, player.userId)).toBeCloseTo(first, 5);
  });

  it("announces the killing blow, and only the killing blow", async () => {
    const boss = (await spawnBoss(8))!;
    const player = await makePlayer();

    const body = await listen(player, ["techno"], 5); // 8 -> 3
    expect(
      (body.notifications ?? []).some(
        (n: { title: string }) => n.title === "Boss defeated!",
      ),
    ).toBe(false);

    const finisher = await listen(player, ["techno"], 5); // 3 -> 0
    const kill = (finisher.notifications ?? []).find(
      (n: { title: string }) => n.title === "Boss defeated!",
    );
    expect(kill).toBeDefined();
    // House style for log/notification lines: the name in quotes.
    expect(kill.message).toBe('You landed the killing blow on "Test Boss".');
    expect((await bossState(boss)).killed).toBe(true);
  });

  it("stops dealing damage once the boss is dead", async () => {
    const boss = (await spawnBoss(5))!;
    const player = await makePlayer();

    await listen(player, ["techno"], 5); // kills it
    const atDeath = await damageOf(boss, player.userId);
    // Same trap as above: prove it actually died before asserting nothing
    // more lands, or a dead hook passes this too.
    expect(atDeath).toBeGreaterThan(0);
    expect((await bossState(boss)).killed).toBe(true);

    await listen(player, ["techno"], 5);

    expect(await damageOf(boss, player.userId)).toBeCloseTo(atDeath, 5);
  });
});
