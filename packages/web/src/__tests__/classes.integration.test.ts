/**
 * Integration tests for classes (00106) and class skills in the boss fight
 * (00107): choosing a class once, its gear, the class check on equip,
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
    .eq("user_id", userId)
    .order("skill_id");
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

  it("gives the class's skills, and no gear (Boboku sells it, 00116)", async () => {
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
    // Both of a Percussionist's skills (00122): Cymbrella and Taunt.
    expect(await skills(userId)).toEqual([
      { skill_id: "cymbrella", level: 1, xp: 0 },
      { skill_id: "taunt", level: 1, xp: 0 },
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

  it("a Bard learns Haste at level 15: on choosing, or on reaching it", async () => {
    const young = await player({ stage: 2, level: 14 });
    await rpc("choose_class", { p_user_id: young, p_class: "bard" });
    expect((await skills(young)).map((s) => s.skill_id)).toEqual([
      "resurrect",
      "soothing-drones",
    ]);
    // Level 15: learned (by the trigger), once.
    await admin().from("herzies").update({ level: 15 }).eq("user_id", young);
    await admin().from("herzies").update({ level: 16 }).eq("user_id", young);
    expect((await skills(young)).map((s) => s.skill_id)).toEqual([
      "haste",
      "resurrect",
      "soothing-drones",
    ]);
    // Choosing at 15 or above: straight away.
    const grown = await player({ stage: 3, level: 20 });
    await rpc("choose_class", { p_user_id: grown, p_class: "bard" });
    expect((await skills(grown)).map((s) => s.skill_id)).toContain("haste");
    // Other classes never do.
    const tank = await player({ stage: 3, level: 20 });
    await rpc("choose_class", { p_user_id: tank, p_class: "percussionist" });
    await admin().from("herzies").update({ level: 21 }).eq("user_id", tank);
    expect((await skills(tank)).map((s) => s.skill_id)).not.toContain("haste");
  });

  it("a Record Slinger learns Shuffle at level 15: on choosing, or on reaching it", async () => {
    const young = await player({ stage: 2, level: 14 });
    await rpc("choose_class", { p_user_id: young, p_class: "record_slinger" });
    expect((await skills(young)).map((s) => s.skill_id)).toEqual(["backspin"]);
    await admin().from("herzies").update({ level: 15 }).eq("user_id", young);
    await admin().from("herzies").update({ level: 16 }).eq("user_id", young);
    expect((await skills(young)).map((s) => s.skill_id)).toEqual([
      "backspin",
      "shuffle",
    ]);
    const grown = await player({ stage: 3, level: 20 });
    await rpc("choose_class", { p_user_id: grown, p_class: "record_slinger" });
    expect((await skills(grown)).map((s) => s.skill_id)).toContain("shuffle");
    // A Bard learns Haste, never Shuffle.
    const bard = await player({ stage: 3, level: 20 });
    await rpc("choose_class", { p_user_id: bard, p_class: "bard" });
    expect((await skills(bard)).map((s) => s.skill_id)).not.toContain(
      "shuffle",
    );
  });

  it("a Percussionist learns Rimshot at level 15: on choosing, or on reaching it", async () => {
    const young = await player({ stage: 2, level: 14 });
    await rpc("choose_class", { p_user_id: young, p_class: "percussionist" });
    expect((await skills(young)).map((s) => s.skill_id)).not.toContain(
      "rimshot",
    );
    await admin().from("herzies").update({ level: 15 }).eq("user_id", young);
    expect((await skills(young)).map((s) => s.skill_id)).toContain("rimshot");
    const grown = await player({ stage: 3, level: 20 });
    await rpc("choose_class", { p_user_id: grown, p_class: "percussionist" });
    expect((await skills(grown)).map((s) => s.skill_id)).toContain("rimshot");
    // The others still learn theirs.
    const dj = await player({ stage: 3, level: 20 });
    await rpc("choose_class", { p_user_id: dj, p_class: "record_slinger" });
    const djSkills = (await skills(dj)).map((s) => s.skill_id);
    expect(djSkills).toContain("shuffle");
    expect(djSkills).not.toContain("rimshot");
  });

  it.each([
    ["percussionist", "cymbal-trap", 20, "rimshot", 5],
    ["record_slinger", "multispin", 20, "shuffle", 8],
    ["bard", "focus", 30, "rage", 8],
  ] as const)("a %s learns %s at level %i once its %s is level %i, in either order", async (cls, skill, level, needs, needsLevel) => {
    const has = async (userId: string) =>
      (await skills(userId)).map((s) => s.skill_id).includes(skill);
    const setLevel = (userId: string, l: number) =>
      admin()
        .from("herzie_skills")
        .update({ level: l })
        .eq("user_id", userId)
        .eq("skill_id", needs);
    // The herzie level first, then the skill's.
    const a = await player({ stage: 3, level: level + 2 });
    await rpc("choose_class", { p_user_id: a, p_class: cls });
    expect(await has(a)).toBe(false);
    await setLevel(a, needsLevel - 1);
    expect(await has(a)).toBe(false);
    await setLevel(a, needsLevel);
    expect(await has(a)).toBe(true);
    // The skill's level first, then the herzie's.
    const b = await player({ stage: 3, level: level - 1 });
    await rpc("choose_class", { p_user_id: b, p_class: cls });
    await setLevel(b, needsLevel);
    expect(await has(b)).toBe(false);
    await admin().from("herzies").update({ level }).eq("user_id", b);
    expect(await has(b)).toBe(true);
  });

  it("a Bard learns Rage at level 20", async () => {
    const young = await player({ stage: 3, level: 19 });
    await rpc("choose_class", { p_user_id: young, p_class: "bard" });
    expect((await skills(young)).map((s) => s.skill_id)).not.toContain("rage");
    await admin().from("herzies").update({ level: 20 }).eq("user_id", young);
    expect((await skills(young)).map((s) => s.skill_id)).toContain("rage");
  });

  it("a Record Slinger learns Forbidden Frequency at level 30: on choosing, or on reaching it", async () => {
    const young = await player({ stage: 3, level: 29 });
    await rpc("choose_class", { p_user_id: young, p_class: "record_slinger" });
    const ids = async (u: string) => (await skills(u)).map((s) => s.skill_id);
    expect(await ids(young)).not.toContain("forbidden-frequency");
    await admin().from("herzies").update({ level: 30 }).eq("user_id", young);
    expect(await ids(young)).toContain("forbidden-frequency");

    const grown = await player({ stage: 3, level: 31 });
    await rpc("choose_class", { p_user_id: grown, p_class: "record_slinger" });
    expect(await ids(grown)).toContain("forbidden-frequency");

    const bard = await player({ stage: 3, level: 31 });
    await rpc("choose_class", { p_user_id: bard, p_class: "bard" });
    expect(await ids(bard)).not.toContain("forbidden-frequency");
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
    // A cymbal in a bard's bag (traded or bought from Boboku).
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

  it("sells to the game for a little", async () => {
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
    expect(r).toMatchObject({ ok: true, earned: 10 });
  });

  it("can be offered in a trade when unworn", async () => {
    const userId = await player({ stage: 2, level: 12 });
    await rpc("choose_class", { p_user_id: userId, p_class: "bard" });
    await admin()
      .from("item_units")
      .insert({ user_id: userId, item_id: "lute" });
    const lute = (await getUnits(userId)).find((u) => u.item_id === "lute");
    expect(
      await rpc("trade_offer_unit_ids", {
        p_offer: { units: [{ unitId: lute?.id }] },
        p_user_id: userId,
      }),
    ).toEqual([lute?.id]);
    expect(
      await rpc("trade_offer_unit_ids", {
        p_offer: { items: { lute: 1 } },
        p_user_id: userId,
      }),
    ).toEqual([lute?.id]);
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
      { skill_id: "resurrect", level: 1, xp: 0 },
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
    expect(
      (await skills(userId)).find((s) => s.skill_id === "cymbrella")?.level,
    ).toBe(10);
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
    expect(
      [...body.skills].sort((a: { skillId: string }, b: { skillId: string }) =>
        a.skillId.localeCompare(b.skillId),
      ),
    ).toEqual([
      { skillId: "resurrect", level: 1, xp: 0 },
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
