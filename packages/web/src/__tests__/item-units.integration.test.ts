/**
 * Integration tests for per-unit item identity against local Supabase.
 * Requires: `npx supabase start`
 *
 * Every owned copy of an item is its own row (item_units), so a dice upgrade
 * lands on one copy, a trade moves a specific copy WITH its level, and a worn
 * copy can't be traded away. The legacy columns (inventory_v2, equipped,
 * item_upgrades) are derived from the units by a trigger; older clients read
 * them and send item ids rather than copy ids, and the routes keep serving
 * them — both are covered here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as buy } from "@/app/api/inventory/buy/route";
import { POST as equip } from "@/app/api/inventory/equip/route";
import { GET as getInventory } from "@/app/api/inventory/route";
import { POST as sell } from "@/app/api/inventory/sell/route";
import { POST as upgrade } from "@/app/api/inventory/upgrade/route";
import { POST as syncRoute } from "@/app/api/sync/route";
import { POST as acceptTrade } from "@/app/api/trade/accept/route";
import { POST as createTrade } from "@/app/api/trade/create/route";
import { POST as joinTrade } from "@/app/api/trade/join/route";
import { POST as lockTrade } from "@/app/api/trade/lock/route";
import { POST as offerTrade } from "@/app/api/trade/offer/route";
import {
  authenticatedRequest,
  cleanupTestData,
  createTestHerzie,
  createTestUser,
  getAdminClient,
  getUnits,
  type InventorySpec,
  seedInventory,
  setLocalEnv,
} from "./integration-helpers";

type Player = {
  userId: string;
  accessToken: string;
  friendCode: string;
};

beforeAll(() => {
  setLocalEnv();
});

afterAll(async () => {
  await cleanupTestData();
}, 15000);

async function makePlayer(
  inventory: InventorySpec,
  opts: {
    equipped?: Record<string, string | string[]>;
    levels?: Record<string, number>;
    currency?: number;
  } = {},
): Promise<Player> {
  const user = await createTestUser();
  const herzie = await createTestHerzie(user.userId, {
    inventory_v2: inventory,
    equipped: opts.equipped ?? {},
    item_upgrades: opts.levels ?? {},
    currency: opts.currency ?? 100,
  });
  return { ...user, friendCode: herzie.friend_code as string };
}

const call = (
  handler: (r: Request) => Promise<Response>,
  path: string,
  who: Player,
  body?: unknown,
) => handler(authenticatedRequest(path, who.accessToken, body));

const unitsOf = async (who: Player, itemId: string) =>
  (await getUnits(who.userId)).filter((u) => u.item_id === itemId);

/**
 * The legacy columns must always say exactly what the units say — that is what
 * lets every older reader of them keep working. Checked after operations rather
 * than only in isolation.
 */
async function expectProjectionMatchesUnits(who: Player) {
  const admin = getAdminClient();
  const units = await getUnits(who.userId);
  const { data: row } = await admin
    .from("herzies")
    .select("inventory_v2, equipped, item_upgrades")
    .eq("user_id", who.userId)
    .single();

  const counts: Record<string, number> = {};
  for (const u of units) counts[u.item_id] = (counts[u.item_id] ?? 0) + 1;
  expect(row?.inventory_v2).toEqual(counts);

  const equipped: Record<string, unknown> = {};
  const modifiers: string[] = [];
  for (const u of units) {
    if (!u.equipped_slot) continue;
    if (u.equipped_slot === "modifier") modifiers.push(u.item_id);
    else equipped[u.equipped_slot] = u.item_id;
  }
  if (modifiers.length > 0) equipped.modifier = modifiers;
  expect(row?.equipped).toEqual(equipped);
}

describe("dice upgrades land on one copy", () => {
  // The bug this whole change exists for.
  it("upgrading one of two Box of Booms leaves the other alone", async () => {
    const p = await makePlayer({ boombox: 2, "power-dice-1": 3 });
    const [a, b] = await unitsOf(p, "boombox");

    for (const level of [1, 2, 3]) {
      const res = await call(upgrade, "/inventory/upgrade", p, {
        diceItemId: "power-dice-1",
        targetUnitId: a.id,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).newLevel).toBe(level);
    }

    const after = await unitsOf(p, "boombox");
    expect(after.find((u) => u.id === a.id)?.upgrade_level).toBe(3);
    expect(after.find((u) => u.id === b.id)?.upgrade_level).toBe(0);
    // All three dice were spent.
    expect(await unitsOf(p, "power-dice-1")).toHaveLength(0);
    await expectProjectionMatchesUnits(p);
  });

  it("returns the units, and the derived views older clients read", async () => {
    const p = await makePlayer({ boombox: 2, "power-dice-1": 1 });
    const [a] = await unitsOf(p, "boombox");

    const res = await call(upgrade, "/inventory/upgrade", p, {
      diceItemId: "power-dice-1",
      targetUnitId: a.id,
    });
    const body = await res.json();

    expect(
      body.units.find((u: { id: string }) => u.id === a.id).upgradeLevel,
    ).toBe(1);
    expect(body.inventory).toEqual({ boombox: 2 });
    expect(body.itemUpgrades).toEqual({ boombox: 1 });
  });

  it("refuses past the level cap without spending a die", async () => {
    const p = await makePlayer(
      { boombox: 1, "power-dice-1": 2 },
      { levels: { boombox: 3 } },
    );
    const [a] = await unitsOf(p, "boombox");

    const res = await call(upgrade, "/inventory/upgrade", p, {
      diceItemId: "power-dice-1",
      targetUnitId: a.id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/fully upgraded/);
    expect(await unitsOf(p, "power-dice-1")).toHaveLength(2);
  });

  it("refuses when the player has no dice", async () => {
    const p = await makePlayer({ boombox: 1 });
    const [a] = await unitsOf(p, "boombox");
    const res = await call(upgrade, "/inventory/upgrade", p, {
      diceItemId: "power-dice-1",
      targetUnitId: a.id,
    });
    expect(res.status).toBe(400);
  });

  it("refuses to upgrade a copy that belongs to someone else", async () => {
    const owner = await makePlayer({ boombox: 1 });
    const thief = await makePlayer({ "power-dice-1": 1 });
    const [theirs] = await unitsOf(owner, "boombox");

    const res = await call(upgrade, "/inventory/upgrade", thief, {
      diceItemId: "power-dice-1",
      targetUnitId: theirs.id,
    });
    expect(res.status).toBe(400);
    expect((await unitsOf(owner, "boombox"))[0].upgrade_level).toBe(0);
    expect(await unitsOf(thief, "power-dice-1")).toHaveLength(1);
  });

  it("refuses a card with no stats to upgrade", async () => {
    const p = await makePlayer({ cd: 1, "power-dice-1": 1 });
    const [cd] = await unitsOf(p, "cd");
    const res = await call(upgrade, "/inventory/upgrade", p, {
      diceItemId: "power-dice-1",
      targetUnitId: cd.id,
    });
    expect(res.status).toBe(400);
  });

  it("older clients naming an item id upgrade one copy, not all", async () => {
    const p = await makePlayer({ boombox: 2, "power-dice-1": 2 });

    for (let i = 0; i < 2; i++) {
      const res = await call(upgrade, "/inventory/upgrade", p, {
        diceItemId: "power-dice-1",
        targetItemId: "boombox",
      });
      expect(res.status).toBe(200);
    }

    // Both dice went to the same card — the way the old per-item level piled up
    // — and the other is untouched.
    const levels = (await unitsOf(p, "boombox"))
      .map((u) => u.upgrade_level)
      .sort();
    expect(levels).toEqual([0, 2]);
  });
});

describe("equipping a specific copy", () => {
  it("wearing a second copy swaps rather than doubling up", async () => {
    const p = await makePlayer({ boombox: 2 }, { levels: { boombox: 3 } });
    const units = await unitsOf(p, "boombox");
    const plus3 = units.find((u) => u.upgrade_level === 3)!;
    const plain = units.find((u) => u.upgrade_level === 0)!;

    let res = await call(equip, "/inventory/equip", p, {
      unitId: plain.id,
      action: "equip",
      side: "left",
    });
    expect(res.status).toBe(200);

    res = await call(equip, "/inventory/equip", p, {
      unitId: plus3.id,
      action: "equip",
      side: "right",
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // One Box of Boom worn at a time: the +3 replaced the plain one.
    const after = await unitsOf(p, "boombox");
    expect(after.find((u) => u.id === plain.id)?.equipped_slot).toBeNull();
    expect(after.find((u) => u.id === plus3.id)?.equipped_slot).toBe(
      "ground_right",
    );
    expect(body.equipped).toEqual({ ground_right: "boombox" });
    // And the derived level an older client reads is the WORN copy's.
    expect(body.itemUpgrades).toEqual({ boombox: 3 });
    await expectProjectionMatchesUnits(p);
  });

  it("wearing into an occupied slot displaces the incumbent", async () => {
    const p = await makePlayer({ headphones: 1, "rainbow-headband": 1 });
    const [phones] = await unitsOf(p, "headphones");
    const [band] = await unitsOf(p, "rainbow-headband");

    await call(equip, "/inventory/equip", p, {
      unitId: phones.id,
      action: "equip",
    });
    const res = await call(equip, "/inventory/equip", p, {
      unitId: band.id,
      action: "equip",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).equipped).toEqual({ head: "rainbow-headband" });
    await expectProjectionMatchesUnits(p);
  });

  it("unequips, and refuses to unequip what isn't worn", async () => {
    const p = await makePlayer({ headphones: 1 });
    const [phones] = await unitsOf(p, "headphones");

    let res = await call(equip, "/inventory/equip", p, {
      unitId: phones.id,
      action: "unequip",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not equipped/i);

    await call(equip, "/inventory/equip", p, {
      unitId: phones.id,
      action: "equip",
    });
    res = await call(equip, "/inventory/equip", p, {
      unitId: phones.id,
      action: "unequip",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).equipped).toEqual({});
  });

  it("requires a side for ground items", async () => {
    const p = await makePlayer({ boombox: 1 });
    const [b] = await unitsOf(p, "boombox");
    const res = await call(equip, "/inventory/equip", p, {
      unitId: b.id,
      action: "equip",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/side/);
  });

  it("refuses an item that can't be worn", async () => {
    const p = await makePlayer({ cd: 1 });
    const [cd] = await unitsOf(p, "cd");
    const res = await call(equip, "/inventory/equip", p, {
      unitId: cd.id,
      action: "equip",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a copy that isn't the player's", async () => {
    const owner = await makePlayer({ headphones: 1 });
    const other = await makePlayer({});
    const [phones] = await unitsOf(owner, "headphones");
    const res = await call(equip, "/inventory/equip", other, {
      unitId: phones.id,
      action: "equip",
    });
    expect(res.status).toBe(400);
  });

  it("older clients naming an item id wear the best copy", async () => {
    const p = await makePlayer({ boombox: 2 }, { levels: { boombox: 3 } });

    const res = await call(equip, "/inventory/equip", p, {
      itemId: "boombox",
      action: "equip",
      side: "left",
    });
    expect(res.status).toBe(200);

    // The +3 is the one worn, so the level an older client sees is unchanged.
    const worn = (await unitsOf(p, "boombox")).find((u) => u.equipped_slot);
    expect(worn?.upgrade_level).toBe(3);
  });
});

describe("selling specific copies", () => {
  it("sells the copy named, keeping the one you've invested in", async () => {
    const p = await makePlayer({ boombox: 2 }, { levels: { boombox: 3 } });
    const units = await unitsOf(p, "boombox");
    const plain = units.find((u) => u.upgrade_level === 0)!;
    const plus3 = units.find((u) => u.upgrade_level === 3)!;

    const res = await call(sell, "/inventory/sell", p, { unitIds: [plain.id] });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.earned).toBe(250);
    expect(body.newCurrency).toBe(350);
    const left = await unitsOf(p, "boombox");
    expect(left.map((u) => u.id)).toEqual([plus3.id]);
    expect(left[0].upgrade_level).toBe(3);
    await expectProjectionMatchesUnits(p);
  });

  it("selling a worn copy stops it being worn", async () => {
    const p = await makePlayer(
      { headphones: 1, prism: 1 },
      { equipped: { head: "headphones", color: "prism" } },
    );
    const [phones] = await unitsOf(p, "headphones");

    const res = await call(sell, "/inventory/sell", p, {
      unitIds: [phones.id],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).equipped).toEqual({ color: "prism" });
    await expectProjectionMatchesUnits(p);
  });

  it("refuses a copy that isn't the player's, changing nothing", async () => {
    const owner = await makePlayer({ boombox: 1 });
    const thief = await makePlayer({ cd: 1 }, { currency: 0 });
    const [theirs] = await unitsOf(owner, "boombox");

    const res = await call(sell, "/inventory/sell", thief, {
      unitIds: [theirs.id],
    });
    expect(res.status).toBe(400);
    expect(await unitsOf(owner, "boombox")).toHaveLength(1);
    const { data } = await getAdminClient()
      .from("herzies")
      .select("currency")
      .eq("user_id", thief.userId)
      .single();
    expect(data?.currency).toBe(0);
  });

  it("refuses an item with no sell price", async () => {
    const p = await makePlayer({ "boss-test-fang": 1 });
    const [fang] = await unitsOf(p, "boss-test-fang");
    const res = await call(sell, "/inventory/sell", p, { unitIds: [fang.id] });
    expect(res.status).toBe(400);
    expect(await unitsOf(p, "boss-test-fang")).toHaveLength(1);
  });

  it("sells several copies in one go", async () => {
    const p = await makePlayer({ cd: 5 });
    const ids = (await unitsOf(p, "cd")).slice(0, 3).map((u) => u.id);
    const res = await call(sell, "/inventory/sell", p, { unitIds: ids });
    expect(res.status).toBe(200);
    expect((await res.json()).earned).toBe(30);
    expect(await unitsOf(p, "cd")).toHaveLength(2);
  });

  it("older clients selling 'N of an item' lose their plainest copies first", async () => {
    const p = await makePlayer(
      { boombox: 3 },
      { levels: { boombox: 2 }, equipped: { ground_left: "boombox" } },
    );
    // Copies: one worn +2, two plain. Selling two must take the plain ones.
    const res = await call(sell, "/inventory/sell", p, {
      itemId: "boombox",
      quantity: 2,
    });
    expect(res.status).toBe(200);

    const left = await unitsOf(p, "boombox");
    expect(left).toHaveLength(1);
    expect(left[0].upgrade_level).toBe(2);
    expect(left[0].equipped_slot).toBe("ground_left");
  });

  it("older clients can't sell more than they own", async () => {
    const p = await makePlayer({ cd: 2 });
    const res = await call(sell, "/inventory/sell", p, {
      itemId: "cd",
      quantity: 3,
    });
    expect(res.status).toBe(400);
    expect(await unitsOf(p, "cd")).toHaveLength(2);
  });
});

describe("buying", () => {
  it("adds the copies and charges once", async () => {
    // A 3000-coin skin.
    const p = await makePlayer({}, { currency: 7000 });
    const res = await call(buy, "/inventory/buy", p, {
      itemId: "prism",
      quantity: 2,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spent).toBe(6000);
    expect(body.newCurrency).toBe(1000);
    expect(await unitsOf(p, "prism")).toHaveLength(2);
    await expectProjectionMatchesUnits(p);
  });

  it("refuses without enough coins, buying nothing", async () => {
    const p = await makePlayer({}, { currency: 2999 });
    const res = await call(buy, "/inventory/buy", p, {
      itemId: "prism",
      quantity: 1,
    });
    expect(res.status).toBe(400);
    expect(await unitsOf(p, "prism")).toHaveLength(0);
  });

  it("two simultaneous buys can't spend the same coins twice", async () => {
    // Enough for exactly one. Before buying was a locked transaction, both could
    // read the same balance and both succeed.
    const p = await makePlayer({}, { currency: 3000 });
    const results = await Promise.all([
      call(buy, "/inventory/buy", p, { itemId: "prism", quantity: 1 }),
      call(buy, "/inventory/buy", p, { itemId: "prism", quantity: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await unitsOf(p, "prism")).toHaveLength(1);
  });

  it("two simultaneous sells of the same copy pay out once", async () => {
    const p = await makePlayer({ boombox: 1 }, { currency: 0 });
    const [b] = await unitsOf(p, "boombox");
    const results = await Promise.all([
      call(sell, "/inventory/sell", p, { unitIds: [b.id] }),
      call(sell, "/inventory/sell", p, { unitIds: [b.id] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const { data } = await getAdminClient()
      .from("herzies")
      .select("currency")
      .eq("user_id", p.userId)
      .single();
    expect(data?.currency).toBe(250);
  });
});

describe("the legacy columns are derived, and can't be written directly", () => {
  it("rejects a direct write to inventory_v2, equipped or item_upgrades", async () => {
    const p = await makePlayer({ cd: 1 });
    const admin = getAdminClient();

    for (const patch of [
      { inventory_v2: { cd: 999 } },
      { equipped: { head: "headphones" } },
      { item_upgrades: { boombox: 3 } },
    ]) {
      const { error } = await admin
        .from("herzies")
        .update(patch)
        .eq("user_id", p.userId);
      expect(error?.message).toMatch(/derived from item_units/);
    }
    expect(await unitsOf(p, "cd")).toHaveLength(1);
  });

  it("still allows writes to the rest of the row", async () => {
    const p = await makePlayer({ cd: 1 });
    const { error } = await getAdminClient()
      .from("herzies")
      .update({ currency: 42 })
      .eq("user_id", p.userId);
    expect(error).toBeNull();
  });

  it("GET /inventory returns units and the derived views together", async () => {
    const p = await makePlayer(
      { boombox: 2, cd: 3 },
      { equipped: { ground_left: "boombox" }, levels: { boombox: 2 } },
    );
    const res = await getInventory(
      authenticatedRequest("/inventory", p.accessToken, undefined, "GET"),
    );
    const body = await res.json();

    expect(body.units).toHaveLength(5);
    expect(body.inventory).toEqual({ boombox: 2, cd: 3 });
    expect(body.equipped).toEqual({ ground_left: "boombox" });
    expect(body.itemUpgrades).toEqual({ boombox: 2 });
  });

  it("a granted item is a real owned copy", async () => {
    const p = await makePlayer({});
    const admin = getAdminClient();
    await admin.rpc("grant_inventory_item", {
      p_user_id: p.userId,
      p_item_id: "cd",
      p_quantity: 3,
    });
    expect(await unitsOf(p, "cd")).toHaveLength(3);
    await expectProjectionMatchesUnits(p);
  });
});

describe("collecting a drop", () => {
  it("mints the copy under the drop's own id", async () => {
    const p = await makePlayer({});
    const admin = getAdminClient();

    const { data: drop } = await admin
      .from("pending_drops")
      .insert({ user_id: p.userId, item_id: "headphones" })
      .select("id")
      .single();

    const { data: collected } = await admin.rpc("collect_pending_drop", {
      p_user_id: p.userId,
      p_drop_id: drop!.id,
    });
    expect(collected).toBe("headphones");

    // Identity runs unbroken from the ground to the bank.
    const units = await unitsOf(p, "headphones");
    expect(units.map((u) => u.id)).toEqual([drop!.id]);
    await expectProjectionMatchesUnits(p);
  });

  it("collecting the same drop twice grants one copy", async () => {
    const p = await makePlayer({});
    const admin = getAdminClient();
    const { data: drop } = await admin
      .from("pending_drops")
      .insert({ user_id: p.userId, item_id: "headphones" })
      .select("id")
      .single();

    const args = { p_user_id: p.userId, p_drop_id: drop!.id };
    const results = await Promise.all([
      admin.rpc("collect_pending_drop", args),
      admin.rpc("collect_pending_drop", args),
    ]);
    expect(
      results
        .map((r) => r.data)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["headphones", null]);
    expect(await unitsOf(p, "headphones")).toHaveLength(1);
  });
});

describe("sync carries the units", () => {
  it("returns every copy with its level and worn slot", async () => {
    const p = await makePlayer(
      { boombox: 2, cd: 2 },
      { equipped: { ground_left: "boombox" }, levels: { boombox: 2 } },
    );
    const res = await call(syncRoute, "/sync", p, {
      nowPlaying: null,
      minutesListened: 0,
      genres: [],
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.units).toHaveLength(4);
    const boomboxes = body.units.filter(
      (u: { itemId: string }) => u.itemId === "boombox",
    );
    expect(
      boomboxes
        .map((u: { upgradeLevel: number; equippedSlot: string | null }) => [
          u.upgradeLevel,
          u.equippedSlot,
        ])
        .sort(),
    ).toEqual([
      [0, null],
      [2, "ground_left"],
    ]);
    // Older clients still get the derived views.
    expect(body.inventory).toEqual({ boombox: 2, cd: 2 });
    expect(body.equipped).toEqual({ ground_left: "boombox" });
    expect(body.itemUpgrades).toEqual({ boombox: 2 });
  });
});

describe("trading specific copies", () => {
  async function openTrade(a: Player, b: Player): Promise<string> {
    const admin = getAdminClient();
    await admin
      .from("herzies")
      .update({ friend_codes: [b.friendCode] })
      .eq("user_id", a.userId);
    await admin
      .from("herzies")
      .update({ friend_codes: [a.friendCode] })
      .eq("user_id", b.userId);

    const created = await call(createTrade, "/trade/create", a, {
      targetFriendCode: b.friendCode,
    });
    expect(created.status).toBe(200);
    const { tradeId } = await created.json();
    expect((await call(joinTrade, "/trade/join", b, { tradeId })).status).toBe(
      200,
    );
    return tradeId;
  }

  async function lockAndAccept(tradeId: string, a: Player, b: Player) {
    for (const who of [a, b]) {
      expect(
        (await call(lockTrade, "/trade/lock", who, { tradeId })).status,
      ).toBe(200);
    }
    await call(acceptTrade, "/trade/accept", a, { tradeId });
    const done = await call(acceptTrade, "/trade/accept", b, { tradeId });
    // A trade that can't settle is a 409 with an error, not completed: false.
    return done.status === 200 && (await done.json()).completed === true;
  }

  // The second bug the old model had: a level was a property of the item id,
  // so trading a +3 card away left the level behind and the buyer got a +0.
  it("an upgraded copy arrives with its level", async () => {
    const seller = await makePlayer({ boombox: 2 }, { levels: { boombox: 3 } });
    const buyer = await makePlayer({}, { currency: 500 });
    const units = await unitsOf(seller, "boombox");
    const plus3 = units.find((u) => u.upgrade_level === 3)!;
    const plain = units.find((u) => u.upgrade_level === 0)!;

    const tradeId = await openTrade(seller, buyer);
    expect(
      (
        await call(offerTrade, "/trade/offer", seller, {
          tradeId,
          offer: { units: [plus3.id], currency: 0 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(offerTrade, "/trade/offer", buyer, {
          tradeId,
          offer: { units: [], currency: 300 },
        })
      ).status,
    ).toBe(200);

    expect(await lockAndAccept(tradeId, seller, buyer)).toBe(true);

    // The very same copy, level intact, now belongs to the buyer...
    const bought = await unitsOf(buyer, "boombox");
    expect(bought.map((u) => [u.id, u.upgrade_level])).toEqual([[plus3.id, 3]]);
    // ...and the seller kept the other one.
    const kept = await unitsOf(seller, "boombox");
    expect(kept.map((u) => [u.id, u.upgrade_level])).toEqual([[plain.id, 0]]);
    // The derived level follows the copy: the seller has no +3 left to report.
    await expectProjectionMatchesUnits(seller);
    await expectProjectionMatchesUnits(buyer);

    const { data } = await getAdminClient()
      .from("herzies")
      .select("currency, item_upgrades")
      .eq("user_id", seller.userId)
      .single();
    expect(data?.currency).toBe(400);
    expect(data?.item_upgrades).toEqual({});
  });

  it("stores what the other side needs to see the level before accepting", async () => {
    const seller = await makePlayer({ boombox: 1 }, { levels: { boombox: 2 } });
    const buyer = await makePlayer({});
    const [b] = await unitsOf(seller, "boombox");
    const tradeId = await openTrade(seller, buyer);

    await call(offerTrade, "/trade/offer", seller, {
      tradeId,
      offer: { units: [b.id], currency: 0 },
    });

    const { data } = await getAdminClient()
      .from("trades")
      .select("initiator_offer")
      .eq("id", tradeId)
      .single();
    expect(data?.initiator_offer).toEqual({
      units: [{ unitId: b.id, itemId: "boombox", upgradeLevel: 2 }],
      items: { boombox: 1 },
      currency: 0,
    });
  });

  // Nothing used to stop this: the offer only checked counts.
  it("a worn copy can't be offered", async () => {
    const seller = await makePlayer(
      { boombox: 1 },
      { equipped: { ground_left: "boombox" } },
    );
    const buyer = await makePlayer({});
    const [worn] = await unitsOf(seller, "boombox");
    const tradeId = await openTrade(seller, buyer);

    const res = await call(offerTrade, "/trade/offer", seller, {
      tradeId,
      offer: { units: [worn.id], currency: 0 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unequip/i);
  });

  it("and if one slipped into an offer anyway, execute_trade refuses it", async () => {
    // Bypass the route to prove the transaction is the backstop, not just the
    // route's check: write a fully accepted trade naming a worn copy directly.
    const seller = await makePlayer(
      { boombox: 1 },
      { equipped: { ground_left: "boombox" } },
    );
    const buyer = await makePlayer({});
    const [worn] = await unitsOf(seller, "boombox");
    const admin = getAdminClient();

    const { data: trade } = await admin
      .from("trades")
      .insert({
        initiator_id: seller.userId,
        target_id: buyer.userId,
        state: "both_locked",
        initiator_accepted: true,
        target_accepted: true,
        initiator_offer: {
          units: [{ unitId: worn.id, itemId: "boombox", upgradeLevel: 0 }],
          items: { boombox: 1 },
          currency: 0,
        },
        target_offer: { units: [], items: {}, currency: 0 },
      })
      .select("id")
      .single();

    const { data: executed } = await admin.rpc("execute_trade", {
      trade_id: trade!.id,
    });
    expect(executed).toBe(false);
    expect(await unitsOf(seller, "boombox")).toHaveLength(1);
    expect(await unitsOf(buyer, "boombox")).toHaveLength(0);
  });

  it("refuses to move a copy the offerer no longer owns", async () => {
    const seller = await makePlayer({ boombox: 1 });
    const buyer = await makePlayer({});
    const [b] = await unitsOf(seller, "boombox");
    const tradeId = await openTrade(seller, buyer);
    await call(offerTrade, "/trade/offer", seller, {
      tradeId,
      offer: { units: [b.id], currency: 0 },
    });

    // Sold out from under the trade before it settles.
    await call(sell, "/inventory/sell", seller, { unitIds: [b.id] });

    expect(await lockAndAccept(tradeId, seller, buyer)).toBe(false);
    expect(await unitsOf(buyer, "boombox")).toHaveLength(0);
  });

  it("an older client offering item counts still completes a trade", async () => {
    const seller = await makePlayer({ cd: 4 });
    const buyer = await makePlayer({ cd: 1 });
    const tradeId = await openTrade(seller, buyer);

    await call(offerTrade, "/trade/offer", seller, {
      tradeId,
      offer: { items: { cd: 3 }, currency: 0 },
    });
    await call(offerTrade, "/trade/offer", buyer, {
      tradeId,
      offer: { items: {}, currency: 0 },
    });

    expect(await lockAndAccept(tradeId, seller, buyer)).toBe(true);
    expect(await unitsOf(seller, "cd")).toHaveLength(1);
    expect(await unitsOf(buyer, "cd")).toHaveLength(4);
  });

  it("swapping to a different copy of the same item resets the other side's accept", async () => {
    const seller = await makePlayer({ boombox: 2 }, { levels: { boombox: 3 } });
    const buyer = await makePlayer({});
    const units = await unitsOf(seller, "boombox");
    const plus3 = units.find((u) => u.upgrade_level === 3)!;
    const plain = units.find((u) => u.upgrade_level === 0)!;
    const tradeId = await openTrade(seller, buyer);

    const offerUnit = (id: string) =>
      call(offerTrade, "/trade/offer", seller, {
        tradeId,
        offer: { units: [id], currency: 0 },
      });
    await offerUnit(plain.id);
    await call(offerTrade, "/trade/offer", buyer, {
      tradeId,
      offer: { units: [], currency: 0 },
    });
    await call(lockTrade, "/trade/lock", seller, { tradeId });
    await call(lockTrade, "/trade/lock", buyer, { tradeId });

    // Quietly swapping the +0 for the +3 is a different deal.
    await offerUnit(plus3.id);

    const { data } = await getAdminClient()
      .from("trades")
      .select("state, initiator_accepted, target_accepted")
      .eq("id", tradeId)
      .single();
    expect(data?.state).not.toBe("both_locked");
    expect(data?.initiator_accepted).toBe(false);
    expect(data?.target_accepted).toBe(false);
  });
});
