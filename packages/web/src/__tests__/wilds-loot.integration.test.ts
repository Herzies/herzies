/**
 * Integration tests for 00154: the Wilds' loot. A card dropped when taken
 * down (escrow, taking it, giving it back, the lazy return), caches opened
 * once, being on the Wilds for the listening bonus, and the Crafting
 * Station's crafting and tuning routes.
 *
 * Requires: `npx supabase start`
 */

import { randomUUID } from "node:crypto";
import {
  BANK_SLOT_COUNT,
  recipeFor,
  TUNING_MAX_LEVEL,
  tuningCost,
  WILDS_LISTEN_LABEL,
} from "@herzies/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as syncRoute } from "@/app/api/sync/route";
import { POST as craftRoute } from "@/app/api/wilds/craft/route";
import { POST as tuneRoute } from "@/app/api/wilds/tune/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getUnits,
  setLocalEnv,
} from "./integration-helpers";

beforeAll(() => {
  setLocalEnv();
});
afterAll(cleanupTestData);

const admin = () => getAdminClient();

async function rpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin().rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function player(overrides: Record<string, unknown> = {}) {
  const user = await createTestUser();
  await createTestHerzie(user.userId, overrides);
  return user;
}

/** A Wilds event on now (or, `live: false`, one that's over). */
async function wildsEvent(live = true): Promise<string> {
  const now = Date.now();
  const { data, error } = await admin()
    .from("events")
    .insert({
      type: "wilds",
      title: "The Wilds",
      active: true,
      starts_at: new Date(now - 3_600_000).toISOString(),
      ends_at: new Date(now + (live ? 3_600_000 : -60_000)).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`wilds event: ${error?.message}`);
  return data.id as string;
}

const count = (units: { item_id: string }[], item: string) =>
  units.filter((u) => u.item_id === item).length;

// ---------------------------------------------------------------------------
// Taken down
// ---------------------------------------------------------------------------

describe("a card dropped on the Wilds", () => {
  it("drops one copy from the bag, never what's worn, once per id", async () => {
    const event = await wildsEvent();
    const victim = await player({
      inventory_v2: { cd: 3, "old-cymbal": 1 },
      equipped: { off_hand: "old-cymbal" },
    });
    const id = randomUUID();
    const drop = await rpc<{ id: string; item: string; level: number }>(
      "wilds_drop",
      {
        p_id: id,
        p_event: event,
        p_victim: victim.userId,
        p_killer: null,
        p_x: 1,
        p_z: 2,
      },
    );
    expect(drop).toEqual({ id, item: "cd", level: 0 });
    // The same id again: the same drop, nothing more taken.
    expect(
      await rpc("wilds_drop", {
        p_id: id,
        p_event: event,
        p_victim: victim.userId,
        p_killer: null,
        p_x: 1,
        p_z: 2,
      }),
    ).toEqual(drop);
    const units = await getUnits(victim.userId);
    expect(count(units, "cd")).toBe(2);
    expect(count(units, "old-cymbal")).toBe(1);
  });

  it("drops nothing from an empty bag or outside the Wilds event", async () => {
    const live = await wildsEvent();
    const over = await wildsEvent(false);
    const bare = await player({
      inventory_v2: { lute: 1 },
      equipped: { main_hand: "lute" },
    });
    const stocked = await player({ inventory_v2: { cd: 1 } });
    const args = (victim: string, event: string) => ({
      p_id: randomUUID(),
      p_event: event,
      p_victim: victim,
      p_killer: null,
      p_x: 0,
      p_z: 0,
    });
    expect(await rpc("wilds_drop", args(bare.userId, live))).toBeNull();
    expect(await rpc("wilds_drop", args(stocked.userId, over))).toBeNull();
    expect(count(await getUnits(stocked.userId), "cd")).toBe(1);
  });

  it("goes to whoever takes it, keeping its level, and only once", async () => {
    const event = await wildsEvent();
    const victim = await player({
      inventory_v2: { lute: 1 },
      item_upgrades: { lute: 4 },
    });
    const killer = await player({ inventory_v2: {} });
    const id = randomUUID();
    await rpc("wilds_drop", {
      p_id: id,
      p_event: event,
      p_victim: victim.userId,
      p_killer: killer.userId,
      p_x: 0,
      p_z: 0,
    });
    expect(await rpc("wilds_take", { p_id: id, p_uid: killer.userId })).toEqual(
      { ok: true, item: "lute", level: 4 },
    );
    expect(await rpc("wilds_take", { p_id: id, p_uid: victim.userId })).toEqual(
      { ok: false, why: "gone" },
    );
    // Nothing to give back: it's been taken.
    expect(await rpc("wilds_return", { p_ids: [id] })).toEqual([]);
    expect(
      (await getUnits(killer.userId)).map((u) => [u.item_id, u.upgrade_level]),
    ).toEqual([["lute", 4]]);
    expect(await getUnits(victim.userId)).toEqual([]);
  });

  it("won't go into a full bag, and goes back to its owner", async () => {
    const event = await wildsEvent();
    const victim = await player({ inventory_v2: { lute: 1 } });
    const full = await player({
      inventory_v2: { "worn-stick": BANK_SLOT_COUNT },
    });
    const id = randomUUID();
    await rpc("wilds_drop", {
      p_id: id,
      p_event: event,
      p_victim: victim.userId,
      p_killer: full.userId,
      p_x: 0,
      p_z: 0,
    });
    expect(await rpc("wilds_take", { p_id: id, p_uid: full.userId })).toEqual({
      ok: false,
      why: "bag-full",
    });
    expect(await rpc("wilds_return", { p_ids: [id] })).toEqual([id]);
    expect(await rpc("wilds_return", { p_ids: [id] })).toEqual([]);
    expect(count(await getUnits(victim.userId), "lute")).toBe(1);
  });

  it("comes home on the owner's next sync if no room returned it", async () => {
    const event = await wildsEvent();
    const victim = await player({ inventory_v2: { lute: 1 } });
    const id = randomUUID();
    await rpc("wilds_drop", {
      p_id: id,
      p_event: event,
      p_victim: victim.userId,
      p_killer: null,
      p_x: 0,
      p_z: 0,
    });
    await admin()
      .from("wilds_drops")
      .update({ dropped_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .eq("id", id);
    const ctx = await rpc<{ item_units: { itemId: string }[] }>(
      "sync_context",
      { p_user_id: victim.userId },
    );
    expect(ctx.item_units.map((u) => u.itemId)).toEqual(["lute"]);
    const { data } = await admin()
      .from("wilds_drops")
      .select("settled")
      .eq("id", id)
      .single();
    expect(data?.settled).toBe("returned");
  });
});

// ---------------------------------------------------------------------------
// Caches and being there
// ---------------------------------------------------------------------------

describe("the Wilds' caches", () => {
  it("open once: the first opener's loot lands on their ground", async () => {
    const event = await wildsEvent();
    const first = await player();
    const second = await player();
    const id = `${event}:0:0`;
    const opened = await rpc<{
      opened: boolean;
      drops: { id: string; item: string }[];
    }>("wilds_open_cache", {
      p_id: id,
      p_event: event,
      p_uid: first.userId,
      p_items: ["tonewood", "sky-string"],
    });
    expect(opened.opened).toBe(true);
    expect(opened.drops.map((d) => d.item)).toEqual(["tonewood", "sky-string"]);
    expect(
      await rpc("wilds_open_cache", {
        p_id: id,
        p_event: event,
        p_uid: second.userId,
        p_items: ["tonewood"],
      }),
    ).toEqual({ opened: false, drops: [] });
    const { data: ground } = await admin()
      .from("pending_drops")
      .select("user_id, item_id, source_event")
      .eq("source_event", event);
    expect(ground?.map((d) => d.user_id)).toEqual([first.userId, first.userId]);
  });
});

describe("being on the Wilds", () => {
  it("adds the listening bonus to the sync while the room says so", async () => {
    const event = await wildsEvent();
    const here = await player();
    const elsewhere = await player();
    expect(
      await rpc("wilds_presence", {
        p_event: event,
        p_uids: [here.userId],
      }),
    ).toBe(1);
    // Not for an event that isn't the one on now.
    expect(
      await rpc("wilds_presence", {
        p_event: await wildsEvent(false),
        p_uids: [elsewhere.userId],
      }),
    ).toBe(0);

    const sync = async (token: string) => {
      const res = await syncRoute(
        authenticatedRequest("/sync", token, {
          nowPlaying: null,
          minutesListened: 0,
          genres: [],
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { multipliers: { name: string }[] };
      return json.multipliers.map((m) => m.name);
    };
    expect(await sync(here.accessToken)).toContain(WILDS_LISTEN_LABEL);
    expect(await sync(elsewhere.accessToken)).not.toContain(WILDS_LISTEN_LABEL);
  });
});

// ---------------------------------------------------------------------------
// The Crafting Station
// ---------------------------------------------------------------------------

const craft = (token: string, recipe: string) =>
  craftRoute(authenticatedRequest("/wilds/craft", token, { recipe }));
const tune = (token: string, unitId: string) =>
  tuneRoute(authenticatedRequest("/wilds/tune", token, { unitId }));

describe("crafting a Wilds instrument", () => {
  const lute = recipeFor("wildwood-lute");
  if (!lute) throw new Error("no wildwood-lute recipe");
  const bits = lute.bits as Record<string, number>;

  it("uses up the base copy and the bits, keeping its level", async () => {
    const user = await player({
      inventory_v2: { lute: 2, ...bits, tonewood: (bits.tonewood ?? 0) + 1 },
      item_upgrades: { lute: 3 },
    });
    const res = await craft(user.accessToken, "wildwood-lute");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, item: "wildwood-lute" });
    const units = await getUnits(user.userId);
    const made = units.find((u) => u.id === json.unitId);
    expect(made).toMatchObject({ item_id: "wildwood-lute", upgrade_level: 3 });
    // The one furthest along went; the other lute, one tonewood stay.
    expect(count(units, "lute")).toBe(1);
    expect(count(units, "tonewood")).toBe(1);
    expect(count(units, "sky-string")).toBe(0);
    expect(json.inventory["wildwood-lute"]).toBe(1);
  });

  it("says what's missing", async () => {
    const none = await player({ inventory_v2: bits });
    const worn = await player({
      inventory_v2: { lute: 1, ...bits },
      equipped: { main_hand: "lute" },
    });
    const poor = await player({ inventory_v2: { lute: 1, tonewood: 1 } });
    const errorOf = async (token: string, recipe = "wildwood-lute") => {
      const res = await craft(token, recipe);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await errorOf(none.accessToken, "not-a-recipe")).toMatch(
      /doesn't know/,
    );
    expect(await errorOf(none.accessToken)).toBe("You need a Lute in your bag");
    expect(await errorOf(worn.accessToken)).toBe("Take your Lute off first");
    expect(await errorOf(poor.accessToken)).toBe(
      "You don't have enough bits for that",
    );
    // Nothing was spent on a refusal.
    expect(count(await getUnits(none.userId), "tonewood")).toBe(
      bits.tonewood ?? 0,
    );
  });

  it("won't use a copy a loadout holds", async () => {
    const user = await player({
      inventory_v2: { lute: 1, ...bits },
      equipped: { main_hand: "lute" },
    });
    // The first switch puts what's worn into loadout 1, out of the bag.
    await rpc("switch_loadout", { p_user: user.userId, p_to: 2 });
    const res = await craft(user.accessToken, "wildwood-lute");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Your Lute is in your other loadout");
  });
});

describe("tuning an instrument", () => {
  /** Enough bits for every step there is. */
  const plenty = {
    tonewood: 30,
    "sky-string": 20,
    "storm-hide": 10,
    resonite: 2,
  };

  it("raises one copy a level, worn or not, for that level's bits", async () => {
    const user = await player({
      inventory_v2: { lute: 1, ...plenty },
      equipped: { main_hand: "lute" },
      item_upgrades: { lute: 2 },
    });
    const [unit] = (await getUnits(user.userId)).filter(
      (u) => u.item_id === "lute",
    );
    const res = await tune(user.accessToken, unit.id);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, newLevel: 3 });
    const cost = tuningCost(2) as Record<string, number>;
    const units = await getUnits(user.userId);
    expect(units.find((u) => u.id === unit.id)).toMatchObject({
      upgrade_level: 3,
      equipped_slot: "main_hand",
    });
    for (const [bit, n] of Object.entries(cost)) {
      expect(count(units, bit)).toBe(plenty[bit as keyof typeof plenty] - n);
    }
  });

  it("stops at the cap, takes only instruments, and wants the bits", async () => {
    const user = await player({
      inventory_v2: { lute: 1, cd: 1, tonewood: 1 },
      item_upgrades: { lute: TUNING_MAX_LEVEL },
    });
    const units = await getUnits(user.userId);
    const lute = units.find((u) => u.item_id === "lute");
    const cd = units.find((u) => u.item_id === "cd");
    if (!lute || !cd) throw new Error("seed");
    const errorOf = async (unitId: string) => {
      const res = await tune(user.accessToken, unitId);
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await errorOf(lute.id)).toMatch(/only goes to \+6/);
    expect(await errorOf(cd.id)).toBe("Only class instruments can be tuned");
    expect(await errorOf(randomUUID())).toBe("You don't own that card");

    await admin()
      .from("item_units")
      .update({ upgrade_level: 0 })
      .eq("id", lute.id);
    expect(await errorOf(lute.id)).toBe("You don't have enough bits for that");
  });
});
