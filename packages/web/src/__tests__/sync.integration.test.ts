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
  setLocalEnv,
} from "./integration-helpers";

let user: { userId: string; accessToken: string };

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
    // Backdate last_synced_at so the elapsed-time cap allows 5 minutes
    const admin = getAdminClient();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await admin
      .from("herzies")
      .update({ last_synced_at: tenMinAgo })
      .eq("user_id", user.userId);

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
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await admin
      .from("herzies")
      .update({ last_synced_at: tenMinAgo })
      .eq("user_id", user.userId);

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

  it("caps minutesListened to elapsed time since last sync", async () => {
    const admin = getAdminClient();

    // Set last_synced_at to 15 seconds ago — above 8s cooldown, so sync is allowed
    const fifteenSecondsAgo = new Date(Date.now() - 15_000).toISOString();
    await admin
      .from("herzies")
      .update({ last_synced_at: fifteenSecondsAgo })
      .eq("user_id", user.userId);

    // Fetch current minutes before sync
    const { data: before } = await admin
      .from("herzies")
      .select("total_minutes_listened")
      .eq("user_id", user.userId)
      .single();

    const minutesBefore = before!.total_minutes_listened as number;

    // Try to claim 10 minutes — should be capped to ~0.33 min (0.25 elapsed + 5s grace)
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: { title: "Cheat Song", artist: "Cheat Artist" },
        minutesListened: 10,
        genres: ["rock"],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Should have gained at most ~0.33 min (15s elapsed + 5s grace), not 10
    const gained = body.herzie.totalMinutesListened - minutesBefore;
    expect(gained).toBeLessThanOrEqual(0.4);
    expect(gained).toBeGreaterThan(0);
  });

  it("enforces 8-second cooldown between syncs", async () => {
    const admin = getAdminClient();

    // Set last_synced_at to 2 seconds ago — within cooldown window
    const twoSecondsAgo = new Date(Date.now() - 2000).toISOString();
    await admin
      .from("herzies")
      .update({ last_synced_at: twoSecondsAgo })
      .eq("user_id", user.userId);

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
    await admin
      .from("herzies")
      .update({ inventory_v2: { cd: 3, "rare-item": 1 }, currency: 500 })
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

    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await admin
      .from("herzies")
      .update({ last_synced_at: tenMinAgo })
      .eq("user_id", dropUser.userId);

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

  it("does not advance drop_rolls_done again while still within the same 10-minute tick", async () => {
    const admin = getAdminClient();
    const dropUser = await createTestUser();
    await createTestHerzie(dropUser.userId, {
      total_minutes_listened: 10,
      drop_rolls_done: 1,
      inventory_v2: {},
    });

    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await admin
      .from("herzies")
      .update({ last_synced_at: tenMinAgo })
      .eq("user_id", dropUser.userId);

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

  it("auto-collects a pending drop in the same tick when Spirit Orb is equipped", async () => {
    const admin = getAdminClient();
    const petUser = await createTestUser();
    await createTestHerzie(petUser.userId, {
      inventory_v2: {},
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

    const { data: herzieRow } = await admin
      .from("herzies")
      .select("inventory_v2")
      .eq("user_id", petUser.userId)
      .single();
    expect(
      (herzieRow!.inventory_v2 as Record<string, number>).headphones,
    ).toBe(1);

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
    const itemIds = body.pendingDrops.map(
      (d: { itemId: string }) => d.itemId,
    );
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
