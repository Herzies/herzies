/**
 * Integration tests for bosses created or resized from the admin page (00076).
 * The weekly schedule is now an event series; see
 * event-series.integration.test.ts.
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

beforeEach(async () => {
  setLocalEnv();
  process.env.GAME_ADMIN_SECRET = ADMIN_SECRET;
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
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
