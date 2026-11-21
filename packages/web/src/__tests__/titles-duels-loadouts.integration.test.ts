/**
 * Integration tests for 00152: titles (granting, wearing, the sync's
 * hand-over), duel results (replays, the once-a-day rule, streaks) and
 * loadouts (a loadout holding its gear out of the bag, switching, a copy
 * that's gone, a piece that can't go on, a full bag).
 *
 * Requires: `npx supabase start`
 */

import { randomUUID } from "node:crypto";
import {
  BANK_SLOT_COUNT,
  type LoadoutState,
  type LoadoutSwitchReport,
  TITLES,
  type TitleMetrics,
  type TitlesState,
} from "@herzies/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as equipRoute } from "@/app/api/inventory/equip/route";
import { POST as loadoutRoute } from "@/app/api/inventory/loadout/route";
import { GET as inventoryRoute } from "@/app/api/inventory/route";
import { POST as syncRoute } from "@/app/api/sync/route";
import { GET as titlesRoute } from "@/app/api/titles/route";
import { POST as seenRoute } from "@/app/api/titles/seen/route";
import { POST as wearRoute } from "@/app/api/titles/wear/route";
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

async function earned(userId: string) {
  const { data } = await admin()
    .from("herzie_titles")
    .select("title_id, count, seen, notified")
    .eq("user_id", userId)
    .order("title_id");
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

describe("titles", () => {
  afterAll(cleanupTestData);

  it("reports exactly the TitleMetrics keys", async () => {
    const { userId } = await player();
    const keys: Record<keyof TitleMetrics, true> = {
      minutes: true,
      level: true,
      streak: true,
      towerFloor: true,
      towerWins: true,
      huntWins: true,
      genres: true,
      bossFights: true,
      bossTops: true,
      duelWins: true,
      duelStreak: true,
      mythics: true,
      friends: true,
      marketSales: true,
    };
    const metrics = await rpc<TitleMetrics>("title_metrics", {
      p_user: userId,
    });
    expect(Object.keys(metrics).sort()).toEqual(Object.keys(keys).sort());
  });

  it("grants every reached rung once, and nothing it hasn't reached", async () => {
    const { userId } = await player({
      total_minutes_listened: 6100,
      level: 26,
      streak_days: 7,
      genre_minutes: { pop: 120, rock: 30 },
    });
    const granted = await rpc<string[]>("refresh_titles", { p_user: userId });
    expect([...granted].sort()).toEqual(
      ["level-10", "level-25", "listen-100", "listen-50", "streak-7"].sort(),
    );
    expect(await rpc<string[]>("refresh_titles", { p_user: userId })).toEqual(
      [],
    );
    // Granted titles wait to be handed over and are NEW in the tab.
    expect(await earned(userId)).toEqual(
      granted.sort().map((id) => ({
        title_id: id,
        count: 1,
        seen: false,
        notified: false,
      })),
    );
  });

  it("gave Original Pressing to every herzie from before titles, and no one since", async () => {
    const { userId } = await player({ level: 30 });
    await rpc("refresh_titles", { p_user: userId });
    expect((await earned(userId)).map((r) => r.title_id)).not.toContain(
      "original-pressing",
    );

    // The backfill's grants are all stamped with the migration's time.
    const { data: first } = await admin()
      .from("herzie_titles")
      .select("earned_at")
      .eq("title_id", "original-pressing")
      .order("earned_at")
      .limit(1)
      .maybeSingle();
    if (!first) return; // A database with no herzies before 00152.
    const { data: before } = await admin()
      .from("herzies")
      .select("user_id")
      .lt("created_at", first.earned_at)
      .limit(1000);
    const ids = (before ?? []).map((h) => h.user_id as string);
    const { count } = await admin()
      .from("herzie_titles")
      .select("user_id", { count: "exact", head: true })
      .eq("title_id", "original-pressing")
      .in("user_id", ids.length > 0 ? ids : [randomUUID()]);
    expect(count ?? 0).toBe(ids.length);
  });

  it("wears only an earned title, and takes it off", async () => {
    const user = await player({ level: 10 });
    await rpc("refresh_titles", { p_user: user.userId });

    const wear = async (title: string | null) => {
      const res = await wearRoute(
        authenticatedRequest("/titles/wear", user.accessToken, { title }),
      );
      return { status: res.status, body: await res.json() };
    };

    expect(await wear("listen-1000")).toMatchObject({
      status: 400,
      body: { reason: "not-earned" },
    });
    expect(await wear("no-such-title")).toMatchObject({
      status: 400,
      body: { reason: "unknown" },
    });
    expect(await wear("level-10")).toEqual({
      status: 200,
      body: { worn: "level-10" },
    });
    const { data: row } = await admin()
      .from("herzies")
      .select("title")
      .eq("user_id", user.userId)
      .single();
    expect(row?.title).toBe("level-10");
    expect(await wear(null)).toEqual({ status: 200, body: { worn: null } });
  });

  it("shows the tab, grants on opening it, and clears NEW once seen", async () => {
    const user = await player({ level: 25 });
    const open = async () =>
      (await (
        await titlesRoute(
          authenticatedRequest("/titles", user.accessToken, undefined, "GET"),
        )
      ).json()) as TitlesState;

    const first = await open();
    expect([...first.granted].sort()).toEqual(["level-10", "level-25"]);
    expect(first.worn).toBeNull();
    expect(first.metrics.level).toBe(25);
    expect(first.earned.map((t) => [t.id, t.fresh, t.count])).toEqual(
      expect.arrayContaining([
        ["level-10", true, 1],
        ["level-25", true, 1],
      ]),
    );
    expect(first.holders["level-25"]).toBeGreaterThanOrEqual(1);

    const res = await seenRoute(
      authenticatedRequest("/titles/seen", user.accessToken, {
        ids: ["level-10", "not-earned-anyway"],
      }),
    );
    expect(await res.json()).toEqual({ ok: true });

    const again = await open();
    expect(again.granted).toEqual([]);
    expect(
      Object.fromEntries(again.earned.map((t) => [t.id, t.fresh])),
    ).toEqual({ "level-10": false, "level-25": true });
  });

  it("hands titles to the app once, on the next sync", async () => {
    const user = await player({ level: 10 });
    await rpc("refresh_titles", { p_user: user.userId });
    const sync = async () =>
      (await (
        await syncRoute(
          authenticatedRequest("/sync", user.accessToken, {
            nowPlaying: null,
            minutesListened: 0,
            genres: [],
          }),
        )
      ).json()) as { newTitles?: string[]; herzie: { title?: string | null } };

    const first = await sync();
    expect(first.newTitles).toEqual(["level-10"]);
    expect(first.herzie.title).toBeNull();
    expect((await sync()).newTitles).toEqual([]);
  });

  it("keeps the catalog's every grantable title in the table", async () => {
    const { data } = await admin().from("titles").select("id");
    expect((data ?? []).map((r) => r.id).sort()).toEqual(
      TITLES.map((t) => t.id).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Duels
// ---------------------------------------------------------------------------

type Recorded = {
  recorded: boolean;
  counted?: boolean;
  titles?: Record<string, string[]>;
};

const duelIds: string[] = [];

function duel(
  a: string,
  b: string,
  winner: string | null,
  opts: { credited?: boolean; why?: string; id?: string } = {},
) {
  const id = opts.id ?? `test:${randomUUID()}`;
  duelIds.push(id);
  return rpc<Recorded>("record_duel", {
    p_id: id,
    p_a: a,
    p_b: b,
    p_winner: winner,
    p_why: opts.why ?? (winner ? "defeat" : "draw"),
    p_ms: 30_000,
    p_damage: { [a]: 500, [b]: 400 },
    p_max_hp: { [a]: 1000, [b]: 1000 },
    p_level: { [a]: 20, [b]: 20 },
    p_credited: opts.credited ?? winner !== null,
  });
}

async function stats(userId: string) {
  const { data } = await admin()
    .from("duel_stats")
    .select("wins, losses, draws, streak, best_streak")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

describe("duel results", () => {
  afterAll(async () => {
    // No foreign keys on the duelists: the results outlive the herzies.
    await admin().from("duel_results").delete().in("id", duelIds);
    await cleanupTestData();
  });

  it("records a duel once, whatever the retries", async () => {
    const [a, b] = [(await player()).userId, (await player()).userId];
    const id = `test:${randomUUID()}`;
    const first = await duel(a, b, a, { id });
    expect(first).toMatchObject({ recorded: true, counted: true });
    expect(first.titles?.[a]).toEqual(["duel-1"]);
    expect(first.titles?.[b]).toEqual([]);
    expect(await duel(a, b, a, { id })).toEqual({ recorded: false });
    expect(await stats(a)).toMatchObject({ wins: 1, streak: 1 });
    expect(await stats(b)).toMatchObject({ losses: 1, streak: 0 });
  });

  it("counts a win over the same herzie once a UTC day", async () => {
    const [a, b] = [(await player()).userId, (await player()).userId];
    expect(await duel(a, b, a)).toMatchObject({ counted: true });
    expect(await duel(b, a, a)).toMatchObject({
      recorded: true,
      counted: false,
    });
    // The other way round is its own pair.
    expect(await duel(a, b, b)).toMatchObject({ counted: true });
    expect(await stats(a)).toMatchObject({ wins: 1 });
    expect(await stats(b)).toMatchObject({ wins: 1 });
  });

  it("only counts what the room credited", async () => {
    const [a, b] = [(await player()).userId, (await player()).userId];
    expect(await duel(a, b, a, { credited: false })).toMatchObject({
      recorded: true,
      counted: false,
    });
    expect(await stats(a)).toMatchObject({ wins: 0, streak: 0 });
  });

  it("keeps the streak: a counted loss ends it, a draw doesn't", async () => {
    const champ = (await player()).userId;
    const others = await Promise.all(
      [1, 2, 3, 4, 5].map(async () => (await player()).userId),
    );
    await duel(champ, others[0], champ);
    await duel(champ, others[1], champ);
    await duel(champ, others[2], null);
    await duel(champ, others[3], champ);
    expect(await stats(champ)).toMatchObject({
      wins: 3,
      draws: 1,
      streak: 3,
      best_streak: 3,
    });
    // A loss the room didn't credit (a stomp) leaves it.
    await duel(champ, others[4], others[4], { credited: false });
    expect(await stats(champ)).toMatchObject({ streak: 3 });
    // Yielding never dodges a loss.
    await duel(champ, others[4], others[4], { credited: false, why: "yield" });
    expect(await stats(champ)).toMatchObject({
      losses: 1,
      streak: 0,
      best_streak: 3,
    });
    const metrics = await rpc<TitleMetrics>("title_metrics", {
      p_user: champ,
    });
    expect(metrics).toMatchObject({ duelWins: 3, duelStreak: 3 });
  });
});

// ---------------------------------------------------------------------------
// Loadouts
// ---------------------------------------------------------------------------

type Switched = {
  ok: boolean;
  reason?: string;
  loadouts?: LoadoutState;
  report?: LoadoutSwitchReport;
};

const switchTo = (userId: string, to: number) =>
  rpc<Switched>("switch_loadout", { p_user: userId, p_to: to });

/** Past the gap between switches (LOADOUT_SWITCH_GAP_MS). */
async function rewind(userId: string) {
  const { error } = await admin()
    .from("herzies")
    .update({ loadout_switched_at: new Date(Date.now() - 5000).toISOString() })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

async function worn(userId: string) {
  return (await getUnits(userId))
    .filter((u) => u.equipped_slot !== null)
    .map((u) => ({ id: u.id, item: u.item_id, slot: u.equipped_slot }));
}

type Unit = {
  id: string;
  itemId: string;
  equippedSlot: string | null;
  heldBy?: number;
};

/** The copies as the clients read them (item_units_json, with heldBy). */
const units = (userId: string) =>
  rpc<Unit[]>("item_units_json", { p_user_id: userId });

async function unitOf(userId: string, itemId: string) {
  const unit = (await units(userId)).find((u) => u.itemId === itemId);
  if (!unit) throw new Error(`no ${itemId}`);
  return unit;
}

async function inventoryOf(userId: string) {
  const { data } = await admin()
    .from("herzies")
    .select("inventory_v2")
    .eq("user_id", userId)
    .single();
  return data?.inventory_v2 as Record<string, number>;
}

const equip = (userId: string, unitId: string, action: "equip" | "unequip") =>
  rpc<{ ok: boolean; reason?: string }>("equip_unit", {
    p_user_id: userId,
    p_unit_id: unitId,
    p_action: action,
  });

describe("loadouts", () => {
  afterAll(cleanupTestData);

  it("starts loadout 2 empty, and swaps back exactly", async () => {
    const { userId } = await player({
      inventory_v2: { headphones: 1, prism: 1 },
      equipped: { head: "headphones", color: "prism" },
    });
    const before = await worn(userId);
    const idOf = (item: string) => before.find((u) => u.item === item)?.id;

    const first = await switchTo(userId, 2);
    expect(first).toMatchObject({
      ok: true,
      report: { missing: [], refused: [] },
    });
    expect(await worn(userId)).toEqual([]);
    expect(first.loadouts?.active).toBe(2);
    expect(first.loadouts?.inactive).toHaveLength(2);
    expect(first.loadouts?.inactive).toEqual(
      expect.arrayContaining([
        { slot: "head", unitId: idOf("headphones"), itemId: "headphones" },
        { slot: "color", unitId: idOf("prism"), itemId: "prism" },
      ]),
    );

    await rewind(userId);
    const back = await switchTo(userId, 1);
    expect(back).toMatchObject({
      ok: true,
      report: { missing: [], refused: [] },
    });
    expect(await worn(userId)).toEqual(before);
    expect(back.loadouts).toEqual({ active: 1, inactive: [] });
  });

  it("keeps what it holds out of the bag and the inventory", async () => {
    const { userId } = await player({
      inventory_v2: { headphones: 1, cd: 2 },
      equipped: { head: "headphones" },
    });
    expect(await inventoryOf(userId)).toEqual({ headphones: 1, cd: 2 });

    await switchTo(userId, 2);
    expect(await inventoryOf(userId)).toEqual({ cd: 2 });
    expect(await unitOf(userId, "headphones")).toMatchObject({
      equippedSlot: null,
      heldBy: 1,
    });
    expect(await unitOf(userId, "cd")).not.toHaveProperty("heldBy");

    await rewind(userId);
    await switchTo(userId, 1);
    expect(await inventoryOf(userId)).toEqual({ headphones: 1, cd: 2 });
    expect((await units(userId)).some((u) => "heldBy" in u)).toBe(false);
  });

  it("wears one copy in both loadouts", async () => {
    const { userId } = await player({
      inventory_v2: { headphones: 1, prism: 1 },
      equipped: { head: "headphones", color: "prism" },
    });
    const hp = await unitOf(userId, "headphones");

    await switchTo(userId, 2);
    expect(await equip(userId, hp.id, "equip")).toMatchObject({ ok: true });
    expect(await unitOf(userId, "headphones")).toMatchObject({
      equippedSlot: "head",
      heldBy: 1,
    });
    // Worn counts; the prism is still put away.
    expect(await inventoryOf(userId)).toEqual({ headphones: 1 });

    await rewind(userId);
    const back = await switchTo(userId, 1);
    expect(back.report).toEqual({ missing: [], refused: [] });
    expect((await worn(userId)).map((u) => u.item).sort()).toEqual([
      "headphones",
      "prism",
    ]);
    expect(back.loadouts?.inactive).toEqual([
      { slot: "head", unitId: hp.id, itemId: "headphones" },
    ]);
    expect(await unitOf(userId, "headphones")).toMatchObject({
      equippedSlot: "head",
      heldBy: 2,
    });
  });

  it("won't sell, list, trade or roll on a copy it holds", async () => {
    const { userId } = await player({
      inventory_v2: { headphones: 1, "power-dice-1": 1 },
      equipped: { head: "headphones" },
    });
    const hp = await unitOf(userId, "headphones");
    await switchTo(userId, 2);

    expect(
      await rpc("sell_units", { p_user_id: userId, p_unit_ids: [hp.id] }),
    ).toEqual({ ok: false, reason: "not-enough" });
    expect(
      await rpc("market_list", {
        p_user_id: userId,
        p_unit_id: hp.id,
        p_price: 1000,
        p_quantity: 1,
      }),
    ).toEqual({ ok: false, reason: "held" });
    expect(
      await rpc("trade_offer_unit_ids", {
        p_offer: { units: [{ unitId: hp.id }] },
        p_user_id: userId,
      }),
    ).toBeNull();
    expect(
      await rpc("trade_offer_unit_ids", {
        p_offer: { items: { headphones: 1 } },
        p_user_id: userId,
      }),
    ).toBeNull();
    const roll = () =>
      rpc("apply_item_upgrade", {
        p_user_id: userId,
        p_dice_item_id: "power-dice-1",
        p_target_unit_id: hp.id,
      });
    expect(await roll()).toEqual({ ok: false, reason: "held" });
    // Worn as well as held: still the other loadout's.
    await equip(userId, hp.id, "equip");
    expect(await roll()).toEqual({ ok: false, reason: "held" });

    expect((await units(userId)).map((u) => u.itemId).sort()).toEqual([
      "headphones",
      "power-dice-1",
    ]);
  });

  it("won't take a piece off into a full bag, unless the other loadout holds it", async () => {
    const user = await player({
      // A full starting bag: 17 boomboxes and a sixpence, one slot each.
      inventory_v2: {
        boombox: BANK_SLOT_COUNT - 1,
        sixpence: 1,
        headphones: 1,
      },
      equipped: { head: "headphones" },
    });
    const { userId } = user;
    const hp = await unitOf(userId, "headphones");
    const six = await unitOf(userId, "sixpence");

    expect(await equip(userId, hp.id, "unequip")).toEqual({
      ok: false,
      reason: "bag-full",
    });
    const res = await equipRoute(
      authenticatedRequest("/inventory/equip", user.accessToken, {
        unitId: hp.id,
        action: "unequip",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Your bag is full: make room first.",
      reason: "bag-full",
    });

    // A swap from the bag goes through: the headphones take its slot.
    expect(await equip(userId, six.id, "equip")).toMatchObject({ ok: true });

    // Loadout 1 now holds the sixpence; the bag is the boomboxes and the
    // headphones, full again.
    await switchTo(userId, 2);
    expect(await equip(userId, hp.id, "equip")).toMatchObject({ ok: true });
    const { error } = await admin()
      .from("item_units")
      .insert({ user_id: userId, item_id: "boombox" });
    if (error) throw new Error(error.message);

    // The held sixpence would push the headphones into the full bag.
    expect(await equip(userId, six.id, "equip")).toEqual({
      ok: false,
      reason: "bag-full",
    });
    expect(await equip(userId, hp.id, "unequip")).toEqual({
      ok: false,
      reason: "bag-full",
    });

    // With room for the headphones, the sixpence goes on; the bag is full
    // again, but it comes off back into loadout 1, not the bag.
    const spare = await unitOf(userId, "boombox");
    await rpc("sell_units", { p_user_id: userId, p_unit_ids: [spare.id] });
    expect(await equip(userId, six.id, "equip")).toMatchObject({ ok: true });
    expect(await equip(userId, six.id, "unequip")).toMatchObject({ ok: true });
    expect(await unitOf(userId, "sixpence")).toMatchObject({
      equippedSlot: null,
      heldBy: 1,
    });
  });

  it("refuses the same loadout, a quick second switch, and no loadout", async () => {
    const { userId } = await player();
    expect(await switchTo(userId, 1)).toEqual({ ok: false, reason: "same" });
    expect((await switchTo(userId, 2)).ok).toBe(true);
    expect(await switchTo(userId, 1)).toEqual({
      ok: false,
      reason: "too-soon",
    });
    expect(await switchTo(userId, 3)).toEqual({ ok: false, reason: "invalid" });
  });

  it("reports a gone piece missing, with no stand-in from the bag", async () => {
    const { userId } = await player({
      inventory_v2: { headphones: 2, prism: 1 },
      equipped: { head: "headphones", color: "prism" },
    });
    const h1 = (await worn(userId)).find((u) => u.item === "headphones");

    await switchTo(userId, 2);
    await admin().from("item_units").delete().eq("id", h1?.id);
    const state = await rpc<LoadoutState>("loadout_state_json", {
      p_user: userId,
    });
    expect(state.inactive).toContainEqual({
      slot: "head",
      unitId: null,
      itemId: "headphones",
    });

    await rewind(userId);
    const back = await switchTo(userId, 1);
    expect(back.report).toEqual({ missing: ["headphones"], refused: [] });
    expect((await worn(userId)).map((u) => u.item)).toEqual(["prism"]);
  });

  it("puts what can't go on any more in the bag, or refuses if it won't fit", async () => {
    const { userId } = await player({
      stage: 2,
      level: 12,
      class: "percussionist",
      inventory_v2: { boombox: BANK_SLOT_COUNT, lute: 1, headphones: 1 },
      // Put on as a Bard, before a change of class.
      equipped: { main_hand: "lute", head: "headphones" },
    });
    await switchTo(userId, 2);
    await rewind(userId);

    // The lute would land in a full bag: nothing changes.
    expect(await switchTo(userId, 1)).toEqual({
      ok: false,
      reason: "bag-full",
    });
    expect(await worn(userId)).toEqual([]);

    const spare = await unitOf(userId, "boombox");
    await rpc("sell_units", { p_user_id: userId, p_unit_ids: [spare.id] });
    const back = await switchTo(userId, 1);
    expect(back).toMatchObject({
      ok: true,
      report: { missing: [], refused: ["lute"] },
    });
    expect((await worn(userId)).map((u) => u.item)).toEqual(["headphones"]);
    const lute = await unitOf(userId, "lute");
    expect(lute.equippedSlot).toBeNull();
    expect(lute).not.toHaveProperty("heldBy");
  });

  it("keeps the modifiers' order", async () => {
    const { userId } = await player({
      inventory_v2: { "first-edition": 1, "good-eye-sniper": 1 },
    });
    for (const item of ["good-eye-sniper", "first-edition"]) {
      await equip(userId, (await unitOf(userId, item)).id, "equip");
    }
    const order = async () => {
      const { data } = await admin()
        .from("item_units")
        .select("item_id")
        .eq("user_id", userId)
        .eq("equipped_slot", "modifier")
        .order("equipped_at");
      return (data ?? []).map((r) => r.item_id);
    };
    expect(await order()).toEqual(["good-eye-sniper", "first-edition"]);
    const away = await switchTo(userId, 2);
    expect(
      away.loadouts?.inactive
        ?.filter((p) => p.slot === "modifier")
        .map((p) => p.itemId),
    ).toEqual(["good-eye-sniper", "first-edition"]);
    await rewind(userId);
    await switchTo(userId, 1);
    expect(await order()).toEqual(["good-eye-sniper", "first-edition"]);
  });

  it("switches through the API, and the inventory shows the loadouts", async () => {
    const user = await player({
      inventory_v2: { headphones: 1 },
      equipped: { head: "headphones" },
    });
    const res = await loadoutRoute(
      authenticatedRequest("/inventory/loadout", user.accessToken, {
        loadout: 2,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      loadouts: { active: 2 },
      report: { missing: [], refused: [] },
      inventory: {},
    });
    expect(body.units).toEqual([
      expect.objectContaining({
        itemId: "headphones",
        equippedSlot: null,
        heldBy: 1,
      }),
    ]);

    const refused = await loadoutRoute(
      authenticatedRequest("/inventory/loadout", user.accessToken, {
        loadout: 2,
      }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ reason: "same" });

    const bad = await loadoutRoute(
      authenticatedRequest("/inventory/loadout", user.accessToken, {
        loadout: 7,
      }),
    );
    expect(await bad.json()).toMatchObject({ reason: "invalid" });

    const inv = await (
      await inventoryRoute(
        authenticatedRequest("/inventory", user.accessToken, undefined, "GET"),
      )
    ).json();
    expect(inv.loadouts).toEqual({
      active: 2,
      inactive: [
        {
          slot: "head",
          unitId: body.units[0].id,
          itemId: "headphones",
        },
      ],
    });
    // Out of the bag, but still owned: its details still come along.
    expect(inv.inventory).toEqual({});
    expect(inv.items.map((i: { id: string }) => i.id)).toEqual(["headphones"]);
  });
});
