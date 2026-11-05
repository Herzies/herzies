/**
 * The Crystal (00140): listening fills it, attuning pays it out.
 * Requires: `npx supabase start` with 00140 applied.
 *
 * The game_flags row is global, so this file turns the flag on for its own
 * run and puts it back after (integration files run one at a time).
 */
import {
  CRYSTAL_GROUND_CAP,
  chargeCrystal,
  crystalCapacity,
} from "@herzies/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as syncRoute } from "@/app/api/sync/route";
import { attuneCrystal, upgradeCrystal } from "@/lib/game-server";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

async function setFlag(enabled: boolean) {
  await getAdminClient().from("game_flags").upsert({ id: "crystal", enabled });
}

async function backdateBilling(userId: string, msAgo: number) {
  const at = new Date(Date.now() - msAgo).toISOString();
  await getAdminClient()
    .from("herzies")
    .update({ last_synced_at: at, last_billed_at: at })
    .eq("user_id", userId);
}

async function listen(
  user: { userId: string; accessToken: string },
  minutes: number,
) {
  await backdateBilling(user.userId, minutes * 60_000);
  const res = await syncRoute(
    authenticatedRequest("/sync", user.accessToken, {
      nowPlaying: { title: "Crystal Song", artist: "Crystal Artist" },
      minutesListened: minutes,
      genres: ["rock"],
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

/** XP per listened minute this sync paid at (the streak bonus etc.). */
function xpPerMinute(body: { multipliers: { bonus: number }[] }) {
  return 10 * (1 + body.multipliers.reduce((t, m) => t + m.bonus, 0));
}

async function herzieRow(userId: string) {
  const { data } = await getAdminClient()
    .from("herzies")
    .select("*")
    .eq("user_id", userId)
    .single();
  return data as Record<string, number>;
}

async function newPlayer(overrides: Record<string, unknown> = {}) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, {
    total_minutes_listened: 0,
    drop_rolls_done: 0,
    inventory_v2: {},
    ...overrides,
  });
  return user;
}

beforeAll(async () => {
  setLocalEnv();
  await setFlag(true);
}, 10000);

afterAll(async () => {
  await setFlag(false);
  await cleanupTestData();
}, 10000);

describe("Charging", () => {
  it("listening fills the Crystal instead of paying XP or drops", async () => {
    const user = await newPlayer();
    const body = await listen(user, 10);
    const row = await herzieRow(user.userId);
    expect(row.xp).toBe(0);
    expect(Number(row.crystal_fill)).toBe(10);
    expect(Number(row.crystal_xp)).toBeCloseTo(10 * xpPerMinute(body));
    expect(Number(row.crystal_drop_minutes)).toBe(10);
    expect(row.total_minutes_listened).toBe(10);
    // The old per-sync roll counter keeps pace, so no drop lands on the ground.
    expect(row.drop_rolls_done).toBe(1);
    const { count } = await getAdminClient()
      .from("pending_drops")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.userId);
    expect(count).toBe(0);
    expect(body.crystal).toMatchObject({
      enabled: true,
      fill: 10,
      dropsWaiting: 1,
      capacity: 180,
    });
  });

  it("past capacity it keeps charging at the same split as chargeCrystal", async () => {
    const user = await newPlayer({ crystal_fill: 175, crystal_tier: 0 });
    const body = await listen(user, 10);
    const row = await herzieRow(user.userId);
    const expected = chargeCrystal(175, 10, 0);
    expect(Number(row.crystal_fill)).toBe(expected.newFill);
    expect(Number(row.crystal_drop_minutes)).toBeCloseTo(
      expected.effectiveMinutes,
    );
    expect(Number(row.crystal_xp)).toBeCloseTo(
      expected.effectiveMinutes * xpPerMinute(body),
    );
  });

  it("tells the player when the Crystal fills up", async () => {
    const user = await newPlayer({ crystal_fill: crystalCapacity(0) - 5 });
    const body = await listen(user, 10);
    expect(body.notifications.map((n: { title: string }) => n.title)).toContain(
      "Your resonance is full",
    );
  });

  it("hands rolls the old path still owed to the Crystal once, at cutover", async () => {
    // 30 minutes listened, only 1 roll paid: 2 owed from before the flag.
    const user = await newPlayer({
      total_minutes_listened: 30,
      drop_rolls_done: 1,
    });
    await listen(user, 10);
    const row = await herzieRow(user.userId);
    expect(Number(row.crystal_drop_minutes)).toBe(20 + 10);
    expect(row.drop_rolls_done).toBe(4);
  });
});

describe("Attuning", () => {
  it("pays the XP through pending_xp, lands the drops on the ground and empties the Crystal", async () => {
    const user = await newPlayer({
      crystal_fill: 120,
      crystal_xp: 1234.5,
      crystal_drop_minutes: 35,
    });
    const admin = getAdminClient();
    const result = await attuneCrystal(admin, user.userId, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xp).toBe(1234);
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.levelAfter).toBeGreaterThan(result.levelBefore);
    const row = await herzieRow(user.userId);
    expect(row.pending_xp).toBe(1234);
    expect(Number(row.crystal_xp)).toBeCloseTo(0.5);
    expect(Number(row.crystal_drop_minutes)).toBe(5);
    expect(Number(row.crystal_fill)).toBe(0);
    expect(row.crystal_attunes).toBe(1);
    // On the ground, to come out of black holes; not in the bag.
    const { data: ground } = await admin
      .from("pending_drops")
      .select("id, item_id, dropped_at")
      .eq("user_id", user.userId);
    expect(ground).toHaveLength(result.items.length);
    expect(result.pendingDrops.map((d) => d.id).sort()).toEqual(
      (ground ?? []).map((d) => d.id).sort(),
    );
    // Landed a little later, so a spirit's sweep doesn't take them unseen.
    for (const d of ground ?? [])
      expect(new Date(d.dropped_at).getTime()).toBeGreaterThan(Date.now());
    const { count: owned } = await admin
      .from("item_units")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.userId);
    expect(owned).toBe(0);

    // The next sync lands the XP.
    const body = await (
      await syncRoute(
        authenticatedRequest("/sync", user.accessToken, {
          nowPlaying: null,
          minutesListened: 0,
          genres: [],
        }),
      )
    ).json();
    expect(body.herzie.level).toBe(result.levelAfter);
  });

  it("a stale attune (retry, double press) pays nothing", async () => {
    const user = await newPlayer({ crystal_xp: 500, crystal_drop_minutes: 20 });
    const admin = getAdminClient();
    const [a, b] = await Promise.all([
      attuneCrystal(admin, user.userId, 0),
      attuneCrystal(admin, user.userId, 0),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const row = await herzieRow(user.userId);
    expect(row.pending_xp).toBe(500);
    expect(row.crystal_attunes).toBe(1);
    const again = await attuneCrystal(admin, user.userId, 0);
    expect(again).toMatchObject({ ok: false, reason: "stale" });
  });

  it("a sync racing an attune never puts paid-out XP back", async () => {
    const user = await newPlayer({ crystal_xp: 900, crystal_fill: 30 });
    await backdateBilling(user.userId, 10 * 60_000);
    const admin = getAdminClient();
    const [, res] = await Promise.all([
      attuneCrystal(admin, user.userId, 0),
      syncRoute(
        authenticatedRequest("/sync", user.accessToken, {
          nowPlaying: null,
          minutesListened: 10,
          genres: ["rock"],
        }),
      ),
    ]);
    const listened = 10 * xpPerMinute(await res.json());
    const row = await herzieRow(user.userId);
    // Either order: 900 paid once, and the new listening either paid with it
    // or still waiting — never 900 left in the Crystal as well. (Whole XP
    // moves; a fraction may stay behind.)
    const total = Number(row.crystal_xp) + row.pending_xp + row.xp;
    expect(Math.abs(total - (900 + listened))).toBeLessThan(1);
    expect(Number(row.crystal_xp)).toBeLessThanOrEqual(listened);
  });

  it("only lets out what fits on the ground; the rest waits in the Crystal", async () => {
    const admin = getAdminClient();
    const user = await newPlayer({ crystal_drop_minutes: 50 });
    // 28 already lying there: room for 2 more under CRYSTAL_GROUND_CAP (30).
    const { data: one } = await admin
      .from("items")
      .select("id")
      .eq("stackable", false)
      .limit(1)
      .single();
    await admin.from("pending_drops").insert(
      Array.from({ length: CRYSTAL_GROUND_CAP - 2 }, () => ({
        user_id: user.userId,
        item_id: one?.id,
      })),
    );
    const result = await attuneCrystal(admin, user.userId, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groundFull).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(result.dropsLeft).toBeGreaterThanOrEqual(3);
    expect(result.pendingDrops.length).toBeLessThanOrEqual(CRYSTAL_GROUND_CAP);
  });

  it("a full bag doesn't stop the finds coming out", async () => {
    const admin = getAdminClient();
    const { data: items } = await admin
      .from("items")
      .select("id")
      .eq("stackable", false)
      .limit(18);
    const user = await newPlayer({ crystal_drop_minutes: 30 });
    await admin
      .from("item_units")
      .insert(
        (items ?? []).map((i) => ({ user_id: user.userId, item_id: i.id })),
      );
    const result = await attuneCrystal(admin, user.userId, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.dropsLeft).toBe(0);
  });
});

describe("Upgrading", () => {
  it("spends shards, grows capacity and stops at the top tier", async () => {
    const user = await newPlayer({ crystal_shards: 100 });
    const admin = getAdminClient();
    const costs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await upgradeCrystal(admin, user.userId);
      expect(r.ok).toBe(true);
      if (r.ok) costs.push(r.cost);
    }
    expect(costs).toEqual([3, 5, 8, 12, 20]);
    const last = await upgradeCrystal(admin, user.userId);
    expect(last).toMatchObject({ ok: false, reason: "max-tier" });
    expect(last.crystal.capacity).toBe(480);
    expect(last.crystal.shards).toBe(100 - 48);
  });

  it("refuses without enough shards", async () => {
    const user = await newPlayer({ crystal_shards: 2 });
    const r = await upgradeCrystal(getAdminClient(), user.userId);
    expect(r).toMatchObject({ ok: false, reason: "not-enough-shards" });
    expect(r.crystal.tier).toBe(0);
  });
});

describe("Flag off", () => {
  it("listening pays out directly, as before", async () => {
    await setFlag(false);
    try {
      const user = await newPlayer();
      const body = await listen(user, 10);
      const row = await herzieRow(user.userId);
      expect(row.xp).toBe(Math.floor(10 * xpPerMinute(body)));
      expect(Number(row.crystal_fill)).toBe(0);
      expect(body.crystal.enabled).toBe(false);
    } finally {
      await setFlag(true);
    }
  });
});
