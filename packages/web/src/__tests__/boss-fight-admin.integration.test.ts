/**
 * Integration tests for the Boss Fight admin controls (00076): the weekly
 * spawn's on/off switch and skips, settings defaults, and bosses created or
 * resized from the admin page.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as saveEvent } from "@/app/api/admin/events/route";
import {
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();
const ADMIN_SECRET = "test-admin-secret";
const HOUR = 3_600_000;

function adminPost(body: Record<string, unknown>) {
  return saveEvent(
    new Request("http://localhost/api/admin/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": ADMIN_SECRET,
      },
      body: JSON.stringify(body),
    }),
  );
}

function bossBody(overrides: Record<string, unknown> = {}) {
  return {
    type: "boss_fight",
    title: "Admin Boss",
    active: true,
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + HOUR).toISOString(),
    config: {
      hatedGenres: ["electronic"],
      maxHp: 100,
      rewardItemId: "cd",
      topCount: 3,
    },
    ...overrides,
  };
}

async function setSettings(patch: Record<string, unknown>) {
  const { error } = await admin()
    .from("boss_fight_settings")
    .update(patch)
    .eq("id", true);
  if (error) throw new Error(error.message);
}

async function bossState(eventId: string) {
  const { data } = await admin()
    .from("boss_state")
    .select("hp, max_hp, killed")
    .eq("event_id", eventId)
    .maybeSingle();
  return data as { hp: number; max_hp: number; killed: boolean } | null;
}

async function hit(eventId: string, damage: number) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, { inventory_v2: {} });
  const { error } = await admin().rpc("deal_boss_damage", {
    p_event_id: eventId,
    p_user_id: user.userId,
    p_damage: damage,
  });
  if (error) throw new Error(error.message);
}

async function scheduledSpawn() {
  const { data, error } = await admin().rpc("spawn_scheduled_boss_fight");
  if (error) throw new Error(error.message);
  return data as string | null;
}

beforeEach(async () => {
  setLocalEnv();
  process.env.GAME_ADMIN_SECRET = ADMIN_SECRET;
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe("weekly spawn", () => {
  it("spawns with the defaults when nothing is configured", async () => {
    const id = await scheduledSpawn();
    expect(id).toBeTruthy();
    const { data: event } = await admin()
      .from("events")
      .select("config")
      .eq("id", id)
      .single();
    expect(event!.config.rewardItemId).toBe("cd");
    expect(event!.config.hatedGenres).toHaveLength(3);
  });

  it("does nothing while the weekly spawn is turned off", async () => {
    await setSettings({ auto_spawn: false });
    expect(await scheduledSpawn()).toBeNull();
  });

  it("does nothing on a skipped week", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await admin().from("boss_fight_skips").insert({ week_of: today });
    expect(await scheduledSpawn()).toBeNull();
  });

  it("uses the configured default HP and rewards", async () => {
    await admin().from("items").upsert({
      id: "boss-test-fang",
      name: "Test Fang",
      description: "test",
      rarity: "rare",
    });
    await setSettings({
      default_hp: 1234,
      reward_item_id: "boss-test-fang",
      top_reward_item_id: null,
      top_count: 5,
    });

    const id = (await scheduledSpawn())!;
    const { data: event } = await admin()
      .from("events")
      .select("config")
      .eq("id", id)
      .single();

    expect((await bossState(id))!.max_hp).toBe(1234);
    expect(event!.config.rewardItemId).toBe("boss-test-fang");
    expect(event!.config.topRewardItemId).toBeNull();
    expect(event!.config.topCount).toBe(5);
  });

  it("is replaced by a custom boss overlapping its window", async () => {
    // Starts later this week — the cron's four-day window overlaps it.
    const res = await adminPost(
      bossBody({
        startsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        endsAt: new Date(Date.now() + 5 * HOUR).toISOString(),
      }),
    );
    expect(res.status).toBe(201);
    expect(await scheduledSpawn()).toBeNull();
  });

  it("is not blocked by a custom boss scheduled weeks ahead", async () => {
    // The pre-00076 guard ("any boss ending in the future") would have
    // blocked every weekly spawn until this one ran.
    const inTwoWeeks = Date.now() + 14 * 24 * HOUR;
    const res = await adminPost(
      bossBody({
        startsAt: new Date(inTwoWeeks).toISOString(),
        endsAt: new Date(inTwoWeeks + 4 * 24 * HOUR).toISOString(),
      }),
    );
    expect(res.status).toBe(201);
    expect(await scheduledSpawn()).toBeTruthy();
  });
});

describe("admin-created bosses", () => {
  it("gets an HP pool, so it can actually be damaged", async () => {
    const res = await adminPost(bossBody());
    expect(res.status).toBe(201);
    const { event } = await res.json();

    expect(await bossState(event.id)).toMatchObject({ hp: 100, max_hp: 100 });

    await hit(event.id, 30);
    expect((await bossState(event.id))!.hp).toBe(70);
  });

  it("refuses a second boss overlapping an active one", async () => {
    expect((await adminPost(bossBody())).status).toBe(201);
    expect((await adminPost(bossBody({ title: "Second" }))).status).toBe(409);
  });

  it("refuses reward items that are not in the catalog", async () => {
    const res = await adminPost(
      bossBody({
        config: { ...bossBody().config, topRewardItemId: "no-such-item" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses genres the classifier never emits", async () => {
    const res = await adminPost(
      bossBody({ config: { ...bossBody().config, hatedGenres: ["techno"] } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("resizing a live boss", () => {
  async function liveBoss() {
    const { event } = await (await adminPost(bossBody())).json();
    return event as { id: string };
  }

  it("keeps the damage already dealt", async () => {
    const boss = await liveBoss();
    await hit(boss.id, 30);

    const res = await adminPost(
      bossBody({ id: boss.id, config: { ...bossBody().config, maxHp: 200 } }),
    );
    expect(res.status).toBe(200);
    expect(await bossState(boss.id)).toMatchObject({ hp: 170, max_hp: 200 });
  });

  it("refuses to shrink the pool below the damage dealt", async () => {
    const boss = await liveBoss();
    await hit(boss.id, 60);

    const res = await adminPost(
      bossBody({ id: boss.id, config: { ...bossBody().config, maxHp: 50 } }),
    );
    expect(res.status).toBe(400);
    expect(await bossState(boss.id)).toMatchObject({ hp: 40, max_hp: 100 });
  });

  it("refuses to resize a dead boss", async () => {
    const boss = await liveBoss();
    await hit(boss.id, 100);
    expect((await bossState(boss.id))!.killed).toBe(true);

    const res = await adminPost(
      bossBody({ id: boss.id, config: { ...bossBody().config, maxHp: 500 } }),
    );
    expect(res.status).toBe(400);
  });

  it("lets a dead boss be deactivated without touching HP", async () => {
    const boss = await liveBoss();
    await hit(boss.id, 100);

    const res = await adminPost(bossBody({ id: boss.id, active: false }));
    expect(res.status).toBe(200);
  });
});
