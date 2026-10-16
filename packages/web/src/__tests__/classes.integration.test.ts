/**
 * Integration tests for classes (00106) and class skills in the boss fight
 * (00107): choosing a class once, its bound gear, the class check on equip,
 * the heal allowance on HP reports, and skill XP batches.
 *
 * Grants aren't tested here by calling as a client: a denied call crashes
 * this Postgres. They're checked against the catalog instead.
 *
 * Requires: `npx supabase start`
 */
import { skillLevelForXp, skillTotalXpForLevel } from "@herzies/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as syncRoute } from "@/app/api/sync/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getUnits,
  setLocalEnv,
} from "./integration-helpers";

const admin = () => getAdminClient();

async function player(overrides: Record<string, unknown> = {}) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, overrides);
  return user.userId;
}

async function rpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

type Outcome = { ok: boolean; reason?: string; already?: boolean };

async function skills(userId: string) {
  const { data } = await admin()
    .from("herzie_skills")
    .select("skill_id, level, xp")
    .eq("user_id", userId);
  return data ?? [];
}

describe("choosing a class", () => {
  afterAll(cleanupTestData);

  it("waits for stage 2", async () => {
    const userId = await player({ stage: 1, level: 5 });
    const r = await rpc<Outcome>("choose_class", {
      p_user_id: userId,
      p_class: "bard",
    });
    expect(r).toMatchObject({ ok: false, reason: "stage-too-low" });
  });

  it("gives the starter skill, and no gear (Boboku sells it, 00116)", async () => {
    const userId = await player({ stage: 2, level: 12 });
    const r = await rpc<Outcome>("choose_class", {
      p_user_id: userId,
      p_class: "percussionist",
    });
    expect(r).toMatchObject({ ok: true, already: false });
    const units = await getUnits(userId);
    expect(
      units.filter((u) => ["worn-stick", "old-cymbal"].includes(u.item_id)),
    ).toEqual([]);
    expect(await skills(userId)).toEqual([
      { skill_id: "cymbrella", level: 1, xp: 0 },
    ]);
  });

  it("is permanent: a different pick is refused, the same one is a no-op", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "bard" });
    expect(
      await rpc<Outcome>("choose_class", {
        p_user_id: userId,
        p_class: "record_slinger",
      }),
    ).toMatchObject({ ok: false, reason: "already-chosen" });
    expect(
      await rpc<Outcome>("choose_class", {
        p_user_id: userId,
        p_class: "bard",
      }),
    ).toMatchObject({ ok: true, already: true });
    // Still no lute: a retry hands nothing over either.
    const lutes = (await getUnits(userId)).filter((u) => u.item_id === "lute");
    expect(lutes).toHaveLength(0);
  });

  it("refuses an unknown class", async () => {
    const userId = await player({ stage: 2, level: 12 });
    expect(
      await rpc<Outcome>("choose_class", {
        p_user_id: userId,
        p_class: "bassist",
      }),
    ).toMatchObject({ ok: false, reason: "bad-class" });
  });
});

describe("class gear", () => {
  afterAll(cleanupTestData);

  it("only a herzie of its class can wear it", async () => {
    const bard = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: bard, p_class: "bard" });
    // A stray cymbal in a bard's bag (it can't get there by trade or drop).
    const { data: unit } = await admin()
      .from("item_units")
      .insert({ user_id: bard, item_id: "old-cymbal" })
      .select("id")
      .single();
    const r = await rpc<Outcome>("equip_unit", {
      p_user_id: bard,
      p_unit_id: unit?.id,
      p_action: "equip",
    });
    expect(r).toMatchObject({ ok: false, reason: "class-required" });
  });

  it("can't be sold", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "bard" });
    await admin()
      .from("item_units")
      .insert({ user_id: userId, item_id: "lute" });
    const lute = (await getUnits(userId)).find((u) => u.item_id === "lute");
    const r = await rpc<Outcome>("sell_units", {
      p_user_id: userId,
      p_unit_ids: [lute?.id],
    });
    expect(r).toMatchObject({ ok: false, reason: "not-sellable" });
  });

  it("can't be offered in a trade, even unworn", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "bard" });
    await admin()
      .from("item_units")
      .insert({ user_id: userId, item_id: "lute" });
    const lute = (await getUnits(userId)).find((u) => u.item_id === "lute");
    await rpc("equip_unit", {
      p_user_id: userId,
      p_unit_id: lute?.id,
      p_action: "unequip",
    });
    expect(
      await rpc("trade_offer_unit_ids", {
        p_offer: { units: [{ unitId: lute?.id }] },
        p_user_id: userId,
      }),
    ).toBeNull();
    expect(
      await rpc("trade_offer_unit_ids", {
        p_offer: { items: { lute: 1 } },
        p_user_id: userId,
      }),
    ).toBeNull();
  });
});

describe("healing in a fight report", () => {
  afterAll(cleanupTestData);

  type Vitals = { hp: number; maxHp: number; down: boolean };

  it("may rise by the heal allowance, and no further", async () => {
    const userId = await player({ level: 59 }); // 395 max
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 100 });
    // Healed 50 since: the report says 150.
    const v = await rpc<Vitals>("set_herzie_hp", {
      p_user: userId,
      p_hp: 150,
      p_heal: 50,
    });
    expect(v.hp).toBeCloseTo(150, 0);
    // A report claiming more than was healed is held to the allowance.
    const greedy = await rpc<Vitals>("set_herzie_hp", {
      p_user: userId,
      p_hp: 395,
      p_heal: 10,
    });
    expect(greedy.hp).toBeCloseTo(160, 0);
  });

  it("damage and a heal in one window aren't counted twice", async () => {
    const userId = await player({ level: 59 });
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 100 });
    // 100 → hit to 60 → healed 30 to 90, reported together.
    const v = await rpc<Vitals>("set_herzie_hp", {
      p_user: userId,
      p_hp: 90,
      p_heal: 30,
    });
    expect(v.hp).toBeCloseTo(90, 0);
  });

  it("still only lowers without one (older callers)", async () => {
    const userId = await player({ level: 59 });
    await rpc("set_herzie_hp", { p_user: userId, p_hp: 100 });
    const v = await rpc<Vitals>("set_herzie_hp", { p_user: userId, p_hp: 300 });
    expect(v.hp).toBeLessThan(105);
  });
});

describe("skill XP", () => {
  afterAll(cleanupTestData);

  it("applies a batch once and levels by the shared curve", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "bard" });
    const xp = skillTotalXpForLevel(3) + 5;
    const batch = `test:${crypto.randomUUID()}`;
    const args = {
      p_batch: batch,
      p_xp: [{ uid: userId, skill: "soothing-drones", xp }],
    };
    const first = await rpc<{
      applied: boolean;
      levels: { uid: string; skill: string; level: number }[];
    }>("apply_skill_xp_batch", args);
    expect(first.applied).toBe(true);
    expect(first.levels).toEqual([
      { uid: userId, skill: "soothing-drones", level: skillLevelForXp(xp) },
    ]);
    // A retry changes nothing but still says where it stands.
    const again = await rpc<typeof first>("apply_skill_xp_batch", args);
    expect(again.applied).toBe(false);
    expect(again.levels).toEqual(first.levels);
    expect(await skills(userId)).toEqual([
      { skill_id: "soothing-drones", level: 3, xp },
    ]);
  });

  it("only a skill the herzie knows gains anything", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "bard" });
    const r = await rpc<{ levels: unknown[] }>("apply_skill_xp_batch", {
      p_batch: `test:${crypto.randomUUID()}`,
      p_xp: [{ uid: userId, skill: "cymbrella", xp: 10_000 }],
    });
    expect(r.levels).toEqual([]);
  });

  it("caps at level 10", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "percussionist" });
    await rpc("apply_skill_xp_batch", {
      p_batch: `test:${crypto.randomUUID()}`,
      p_xp: [{ uid: userId, skill: "cymbrella", xp: 99_999 }],
    });
    expect((await skills(userId))[0].level).toBe(10);
  });
});

describe("sync", () => {
  beforeAll(setLocalEnv);
  afterAll(cleanupTestData);

  it("carries the class and its skills, and never clears the class", async () => {
    const user = await createTestUser();
    await createTestHerzie(user.userId, { stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: user.userId, p_class: "bard" });
    const res = await syncRoute(
      authenticatedRequest("/sync", user.accessToken, {
        nowPlaying: null,
        minutesListened: 0,
        genres: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.herzie.class).toBe("bard");
    expect(body.skills).toEqual([
      { skillId: "soothing-drones", level: 1, xp: 0 },
    ]);
    const { data } = await admin()
      .from("herzies")
      .select("class")
      .eq("user_id", user.userId)
      .single();
    expect(data?.class).toBe("bard");
  });
});
