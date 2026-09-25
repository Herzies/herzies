/**
 * Integration tests for sync and herzie registration against local Supabase.
 * Requires: `npx supabase start`
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as registerHerzie } from "@/app/api/herzie/route";
import { GET as getMe } from "@/app/api/me/route";
import { POST as syncRoute } from "@/app/api/sync/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  seedInventory,
  setLocalEnv,
} from "./integration-helpers";

let user: { userId: string; accessToken: string };

/**
 * Backdate a herzie's sync clocks so the elapsed-time cap and the billing
 * cooldown see the gap a test wants.
 *
 * Both columns, always. `last_billed_at` is what processSync actually measures
 * from (00061); `last_synced_at` only falls back for rows predating that
 * column, so a test that moved just the latter would silently assert nothing
 * the moment the herzie had been billed once.
 */
async function backdateSyncClocks(userId: string, msAgo: number) {
  const at = new Date(Date.now() - msAgo).toISOString();
  await getAdminClient()
    .from("herzies")
    .update({ last_synced_at: at, last_billed_at: at })
    .eq("user_id", userId);
  return at;
}

beforeAll(async () => {
  setLocalEnv();
  user = await createTestUser();
}, 10000);

afterAll(async () => {
  await cleanupTestData();
}, 10000);

describe("Herzie registration", () => {
  it("registers a new herzie", async () => {
    const res = await registerHerzie(
      authenticatedRequest("/herzie", user.accessToken, {
        name: `IT-${Date.now().toString(36)}`,
        appearance: {
          headIndex: 0,
          eyesIndex: 0,
          mouthIndex: 0,
          accessoryIndex: 0,
          limbsIndex: 0,
          bodyIndex: 0,
          legsIndex: 0,
          colorScheme: "blue",
        },
        friendCode: `HERZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.herzie).toBeDefined();
    expect(body.herzie.level).toBe(1);
  });

  it("returns existing herzie on duplicate registration", async () => {
    const res = await registerHerzie(
      authenticatedRequest("/herzie", user.accessToken, {
        name: "ShouldBeIgnored",
        appearance: {},
        friendCode: "HERZ-IGNORED",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should return the herzie created in the previous test
    expect(body.herzie.name).toMatch(/^IT-/);
  });

  it("GET /me returns the registered herzie", async () => {
    const req = new Request("http://localhost/api/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const res = await getMe(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.name).toMatch(/^IT-/);
  });
});

describe("Sync flow", () => {
  it("syncs with no listening time", async () => {
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie).toBeDefined();
    expect(body.notifications).toBeDefined();
    expect(body.multipliers).toBeDefined();
  });

  it("grants XP for listening time", async () => {
    // Backdate the sync clocks so the elapsed-time cap allows 5 minutes
    await backdateSyncClocks(user.userId, 10 * 60_000);

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Test Song", artist: "Test Artist" },
        minutesListened: 5,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.xp).toBeGreaterThan(0);
    expect(body.herzie.totalMinutesListened).toBe(5);
  });

  it("does not grant a CD straight to inventory from listening time alone", async () => {
    // CDs are no longer a guaranteed per-10-minutes grant — they're just
    // another item in the world-drop pool (see ITEM_DROP_WEIGHT_OVERRIDES),
    // which lands as a pending ground drop, not straight in inventory.
    const admin = getAdminClient();
    await backdateSyncClocks(user.userId, 10 * 60_000);

    // We already have 5 minutes from the previous test, add 5 more to cross
    // the 10-minute drop-roll boundary.
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Test Song 2", artist: "Test Artist" },
        minutesListened: 5,
        genres: ["pop"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.totalMinutesListened).toBe(10);

    const { data } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", user.userId)
      .single();

    expect((data!.inventory_v2 as Record<string, number>).cd ?? 0).toBe(0);
  });

  it("caps minutesListened to elapsed time since the last bill", async () => {
    const admin = getAdminClient();

    // 15 seconds ago — above the 8s cooldown, so the sync is billable
    await backdateSyncClocks(user.userId, 15_000);

    // Fetch current minutes before sync
    const { data: before } = await admin
      .from("herzies")
      .select("total_minutes_listened")
      .eq("user_id", user.userId)
      .single();

    const minutesBefore = before!.total_minutes_listened as number;

    // Try to claim 10 minutes. The ceiling is elapsed * CATCHUP_RATE + grace =
    // 0.25 * 3 + 5/60 ≈ 0.83 min — enough headroom to drain a backlog faster
    // than it accrued, nowhere near the 10 claimed.
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Cheat Song", artist: "Cheat Artist" },
        minutesListened: 10,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const gained = body.herzie.totalMinutesListened - minutesBefore;
    expect(gained).toBeLessThanOrEqual(0.9);
    expect(gained).toBeGreaterThan(0);
  });

  it("enforces 8-second cooldown between billable syncs", async () => {
    const admin = getAdminClient();

    // 2 seconds ago — within the cooldown window
    await backdateSyncClocks(user.userId, 2000);

    const { data: before } = await admin
      .from("herzies")
      .select("total_minutes_listened")
      .eq("user_id", user.userId)
      .single();

    const minutesBefore = before!.total_minutes_listened as number;

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Rapid Song", artist: "Rapid Artist" },
        minutesListened: 5,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Should gain 0 minutes due to cooldown
    const gained = body.herzie.totalMinutesListened - minutesBefore;
    expect(gained).toBe(0);
  });

  // Regression: the cooldown and the wall-clock cap used to measure from
  // last_synced_at, which every sync rewrites as a liveness heartbeat. At the
  // desktop's 5s visible cadence that gap never reached 8s, so with the window
  // open no listening time was ever credited — and since drop eligibility is a
  // counter diff on total_minutes_listened, no drops ever rolled either.
  it("a throttled sync moves last_synced_at but not the billing clock", async () => {
    const admin = getAdminClient();
    const backdatedTo = await backdateSyncClocks(user.userId, 5000);

    const { data: before } = await admin
      .from("herzies")
      .select("total_minutes_listened")
      .eq("user_id", user.userId)
      .single();

    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Throttled", artist: "Throttled Artist" },
        minutesListened: 5,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.totalMinutesListened).toBe(
      before!.total_minutes_listened,
    );

    const { data: after } = await admin
      .from("herzies")
      .select("last_synced_at, last_billed_at")
      .eq("user_id", user.userId)
      .single();

    // The billing clock stays put, so the next tick 5s later clears the 8s gap.
    expect(new Date(after!.last_billed_at as string).getTime()).toBe(
      new Date(backdatedTo).getTime(),
    );
    // The heartbeat still advances — the Spotify cron reads it to decide
    // whether the desktop app is already covering this user.
    expect(new Date(after!.last_synced_at as string).getTime()).toBeGreaterThan(
      new Date(backdatedTo).getTime(),
    );
  });

  it("rejects minutesListened > 10 at schema level", async () => {
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 50,
        genres: [],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("allows first sync without last_synced_at using 10-min cap", async () => {
    // Create a fresh user/herzie with no last_synced_at
    const freshUser = await createTestUser();
    const admin = getAdminClient();

    // Register a herzie for this fresh user
    const regRes = await registerHerzie(
      authenticatedRequest("/herzie", freshUser.accessToken, {
        name: `Fresh-${Date.now().toString(36)}`,
        appearance: {
          headIndex: 0,
          eyesIndex: 0,
          mouthIndex: 0,
          accessoryIndex: 0,
          limbsIndex: 0,
          bodyIndex: 0,
          legsIndex: 0,
          colorScheme: "green",
        },
        friendCode: `HERZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      }),
    );
    expect(regRes.status).toBe(201);

    // Sync with 8 minutes — should be accepted (under 10-min hard cap)
    const res = await syncRoute(
      authenticatedRequest("/sync", freshUser.accessToken, {
        nowPlaying: { title: "First Song", artist: "First Artist" },
        minutesListened: 8,
        genres: ["pop"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.totalMinutesListened).toBe(8);
  });

  it("sends first-finder notification for song_hunt events", async () => {
    const admin = getAdminClient();

    // Create a song_hunt event
    const tomorrow = new Date(Date.now() + 86400_000).toISOString();
    const { data: event } = await admin
      .from("events")
      .insert({
        type: "song_hunt",
        title: "Test Hunt",
        description: "Find the song!",
        active: true,
        starts_at: new Date(Date.now() - 86400_000).toISOString(),
        ends_at: tomorrow,
        config: {
          trackTitle: "Never Gonna Give You Up",
          trackArtist: "Rick Astley",
          rewardItemId: "cd",
          maxClaims: 100,
          hints: [],
        },
      })
      .select("id")
      .single();

    expect(event).toBeDefined();

    // Create a second user who "found" the song
    const finder = await createTestUser();
    await createTestHerzie(finder.userId, { name: "FinderHerzie" });

    // Insert a claim for the finder
    await admin.from("event_claims").insert({
      event_id: event!.id,
      user_id: finder.userId,
    });

    // Sync the original user — should get a first-finder notification
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const huntNotif = body.notifications.find(
      (n: { type: string; message: string }) =>
        n.type === "info" && n.message.includes("FinderHerzie"),
    );
    expect(huntNotif).toBeDefined();
    expect(huntNotif.message).toContain("found the song");

    // Sync again — should NOT get the notification a second time
    const res2 = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    const huntNotif2 = body2.notifications.find(
      (n: { type: string; message: string }) =>
        n.type === "info" && n.message.includes("FinderHerzie"),
    );
    expect(huntNotif2).toBeUndefined();
  });

  it("sends a win notification and log-only reward line when the user finds a song_hunt track", async () => {
    const admin = getAdminClient();

    const winner = await createTestUser();
    await createTestHerzie(winner.userId, { name: "WinnerHerzie" });

    const { data: event } = await admin
      .from("events")
      .insert({
        type: "song_hunt",
        title: "Winnable Hunt",
        description: "Find it!",
        active: true,
        starts_at: new Date(Date.now() - 86400_000).toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        config: {
          trackTitle: "Take On Me",
          trackArtist: "a-ha",
          rewardItemId: "cd",
          maxClaims: 100,
          hints: [],
        },
      })
      .select("id")
      .single();
    expect(event).toBeDefined();

    const res = await syncRoute(
      authenticatedRequest("/sync", winner.accessToken, {
        nowPlaying: { title: "Take On Me", artist: "a-ha" },
        minutesListened: 1,
        genres: ["pop"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const winNotif = body.notifications.find(
      (n: { type: string; message: string; logOnly?: boolean }) =>
        n.type === "item_granted" && !n.logOnly,
    );
    expect(winNotif).toBeDefined();
    expect(winNotif.message.toLowerCase()).toContain("won");

    const rewardNotif = body.notifications.find(
      (n: { logOnly?: boolean; message: string }) =>
        n.logOnly === true &&
        n.message.toLowerCase().startsWith("you received"),
    );
    expect(rewardNotif).toBeDefined();
    // "cd" item has display name "CD" — should resolve the human name, not the id
    expect(rewardNotif.message).toContain("CD");
  });

  it("sends a later-finder win notification when the user finds a song_hunt after someone else", async () => {
    const admin = getAdminClient();

    const finder = await createTestUser();
    await createTestHerzie(finder.userId, { name: "FirstFinder" });

    const later = await createTestUser();
    await createTestHerzie(later.userId, { name: "LaterFinder" });

    const { data: event } = await admin
      .from("events")
      .insert({
        type: "song_hunt",
        title: "Late Hunt",
        description: "Find it!",
        active: true,
        starts_at: new Date(Date.now() - 86400_000).toISOString(),
        ends_at: new Date(Date.now() + 86400_000).toISOString(),
        config: {
          trackTitle: "Blue Monday",
          trackArtist: "New Order",
          rewardItemId: "cd",
          maxClaims: 100,
          hints: [],
        },
      })
      .select("id")
      .single();
    expect(event).toBeDefined();

    await admin.from("event_claims").insert({
      event_id: event!.id,
      user_id: finder.userId,
    });

    const res = await syncRoute(
      authenticatedRequest("/sync", later.accessToken, {
        nowPlaying: { title: "Blue Monday", artist: "New Order" },
        minutesListened: 1,
        genres: ["pop"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const winNotif = body.notifications.find(
      (n: { type: string; message: string; logOnly?: boolean }) =>
        n.type === "item_granted" && !n.logOnly,
    );
    expect(winNotif).toBeDefined();
    expect(winNotif.message).toContain("You found the song");
    expect(winNotif.message.toLowerCase()).not.toContain("first");

    const firstFinderNotif = body.notifications.find(
      (n: { type: string; message: string }) =>
        n.type === "info" && n.message.includes("found the song"),
    );
    expect(firstFinderNotif).toBeUndefined();
  });

  it("sync does not wipe inventory changes from other operations", async () => {
    const admin = getAdminClient();

    // Manually set inventory to simulate a trade completing
    await seedInventory(user.userId, { cd: 3, "rare-item": 1 });
    await admin
      .from("herzies")
      .update({ currency: 500 })
      .eq("user_id", user.userId);

    // Sync should NOT overwrite currency or inventory
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);

    // Verify currency was not reset
    const { data } = await admin
      .from("herzies")
      .select("inventory_v2, currency")
      .eq("user_id", user.userId)
      .single();

    expect(data!.currency).toBe(500);
    expect((data!.inventory_v2 as Record<string, number>)["rare-item"]).toBe(1);
  });
});

describe("World drops", () => {
  it("advances drop_rolls_done by exactly 1 when crossing a 10-minute boundary", async () => {
    const admin = getAdminClient();
    const dropUser = await createTestUser();
    await createTestHerzie(dropUser.userId, {
      total_minutes_listened: 0,
      inventory_v2: {},
    });

    await backdateSyncClocks(dropUser.userId, 10 * 60_000);

    const res = await syncRoute(
      authenticatedRequest("/sync", dropUser.accessToken, {
        nowPlaying: { title: "Drop Song", artist: "Drop Artist" },
        minutesListened: 10,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);

    const { data } = await admin
      .from("herzies")
      .select("drop_rolls_done, total_minutes_listened")
      .eq("user_id", dropUser.userId)
      .single();

    expect(data!.total_minutes_listened).toBeGreaterThanOrEqual(10);
    expect(data!.drop_rolls_done).toBe(1);
  });

  // Both conditional writes in step 7 — last_billed_at and drop_rolls_done —
  // land in the same UPDATE. This is the one shape that exercises them
  // together: minutes are credited *and* more than one boundary is crossed.
  it("bills minutes and awards both owed rolls in the same sync", async () => {
    const admin = getAdminClient();
    const comboUser = await createTestUser();
    // 15 banked, none paid: 5 more minutes takes it to 20, i.e. two whole ticks.
    await createTestHerzie(comboUser.userId, {
      total_minutes_listened: 15,
      drop_rolls_done: 0,
      inventory_v2: {},
    });

    const backdatedTo = await backdateSyncClocks(comboUser.userId, 10 * 60_000);

    const res = await syncRoute(
      authenticatedRequest("/sync", comboUser.accessToken, {
        nowPlaying: { title: "Combo Song", artist: "Combo Artist" },
        minutesListened: 5,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.totalMinutesListened).toBe(20);
    expect(body.pendingDrops).toHaveLength(2);

    const { data } = await admin
      .from("herzies")
      .select("drop_rolls_done, last_billed_at")
      .eq("user_id", comboUser.userId)
      .single();

    expect(data!.drop_rolls_done).toBe(2);
    expect(new Date(data!.last_billed_at as string).getTime()).toBeGreaterThan(
      new Date(backdatedTo).getTime(),
    );
  });

  it("does not advance drop_rolls_done again while still within the same 10-minute tick", async () => {
    const admin = getAdminClient();
    const dropUser = await createTestUser();
    await createTestHerzie(dropUser.userId, {
      total_minutes_listened: 10,
      drop_rolls_done: 1,
      inventory_v2: {},
    });

    await backdateSyncClocks(dropUser.userId, 10 * 60_000);

    // 1 more minute (10 -> 11) is still floor(11/10) === 1, the same tick
    // drop_rolls_done already accounts for — should not roll or advance again.
    const res = await syncRoute(
      authenticatedRequest("/sync", dropUser.accessToken, {
        nowPlaying: { title: "Same Tick", artist: "Same Artist" },
        minutesListened: 1,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.totalMinutesListened).toBeGreaterThanOrEqual(11);

    const { data } = await admin
      .from("herzies")
      .select("drop_rolls_done")
      .eq("user_id", dropUser.userId)
      .single();
    expect(data!.drop_rolls_done).toBe(1);
  });

  // Regression: the roll block used to insert exactly one drop and then
  // fast-forward drop_rolls_done to the eligible count, writing off the rest.
  // Unreachable from the desktop (10 min/sync cap = at most one boundary), but
  // the Spotify cron hands over uncapped catch-up minutes.
  it("awards one drop per boundary when a sync owes several rolls", async () => {
    const admin = getAdminClient();
    const catchupUser = await createTestUser();
    // 25 minutes banked, nothing paid out: two whole ticks are owed.
    await createTestHerzie(catchupUser.userId, {
      total_minutes_listened: 25,
      drop_rolls_done: 0,
      inventory_v2: {},
    });

    const res = await syncRoute(
      authenticatedRequest("/sync", catchupUser.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pendingDrops).toHaveLength(2);

    const { data } = await admin
      .from("herzies")
      .select("drop_rolls_done")
      .eq("user_id", catchupUser.userId)
      .single();
    expect(data!.drop_rolls_done).toBe(2);
  });

  it("auto-collects a pending drop in the same tick when Spirit Orb is equipped", async () => {
    const admin = getAdminClient();
    const petUser = await createTestUser();
    // The orb has to be an owned copy to be worn: a worn item is a unit, so
    // "equipped but not owned" (which the old columns could express) can't exist.
    await createTestHerzie(petUser.userId, {
      inventory_v2: { "spirit-orb": 1 },
      equipped: { ground_left: "spirit-orb" },
    });

    await admin.rpc("roll_pending_drop", {
      p_user_id: petUser.userId,
      p_item_id: "headphones",
    });

    const res = await syncRoute(
      authenticatedRequest("/sync", petUser.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.pendingDrops).toEqual([]);

    const collectedNotif = body.notifications.find(
      (n: { type: string; itemId?: string }) =>
        n.type === "item_granted" && n.itemId === "headphones",
    );
    expect(collectedNotif).toBeDefined();
    // Logged to activity only — no native notification per auto-collect.
    expect(collectedNotif.logOnly).toBe(true);
    // The response carries the post-collect inventory the client renders from.
    expect(body.inventory.headphones).toBe(1);

    const { data: herzieRow } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", petUser.userId)
      .single();
    expect((herzieRow!.inventory_v2 as Record<string, number>).headphones).toBe(
      1,
    );

    const { data: drops } = await admin
      .from("pending_drops")
      .select("id")
      .eq("user_id", petUser.userId);
    expect(drops).toEqual([]);
  });

  it("leaves the drop pending and reports it in the sync response without the pet equipped", async () => {
    const admin = getAdminClient();
    const noPetUser = await createTestUser();
    await createTestHerzie(noPetUser.userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: noPetUser.userId,
      p_item_id: "boombox",
    });

    const res = await syncRoute(
      authenticatedRequest("/sync", noPetUser.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.pendingDrops).toEqual([
      expect.objectContaining({ itemId: "boombox" }),
    ]);
  });

  it("keeps multiple drops pending at once instead of blocking on the first", async () => {
    const admin = getAdminClient();
    const multiUser = await createTestUser();
    await createTestHerzie(multiUser.userId, { inventory_v2: {} });

    await admin.rpc("roll_pending_drop", {
      p_user_id: multiUser.userId,
      p_item_id: "boombox",
    });
    await admin.rpc("roll_pending_drop", {
      p_user_id: multiUser.userId,
      p_item_id: "cd",
    });

    const res = await syncRoute(
      authenticatedRequest("/sync", multiUser.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.pendingDrops).toHaveLength(2);
    const itemIds = body.pendingDrops.map((d: { itemId: string }) => d.itemId);
    expect(itemIds).toEqual(expect.arrayContaining(["boombox", "cd"]));

    // Collecting one by id leaves the other untouched.
    const boombox = body.pendingDrops.find(
      (d: { itemId: string }) => d.itemId === "boombox",
    );
    const { data: collectedId } = await admin.rpc("collect_pending_drop", {
      p_user_id: multiUser.userId,
      p_drop_id: boombox.id,
    });
    expect(collectedId).toBe("boombox");

    const { data: remaining } = await admin
      .from("pending_drops")
      .select("item_id")
      .eq("user_id", multiUser.userId);
    expect(remaining).toEqual([{ item_id: "cd" }]);
  });
});
