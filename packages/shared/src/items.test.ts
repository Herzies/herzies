import { describe, expect, it } from "vitest";
import {
  applyEquip,
  applyItemUpgrade,
  applySell,
  BANK_SLOT_COUNT,
  type BankItemLookup,
  bankSlotsUsed,
  bankTiles,
  bestUnitOf,
  bossDamagePerMinute,
  EQUIP_SLOTS,
  EQUIPPED_SLOTS,
  equippedItemIds,
  findEquippedSlot,
  getHerzieStats,
  getHerzieStatsFromUnits,
  getItem,
  getItemType,
  hasRoomFor,
  ITEM_DROP_WEIGHT_OVERRIDES,
  ITEMS,
  type ItemUnit,
  isBankFull,
  isModifierEquipped,
  MAX_ITEM_UPGRADE_LEVEL,
  MAX_MODIFIERS,
  NON_DROPPABLE_ITEM_IDS,
  normalizeEquipped,
  normalizeUnits,
  pickPlainestUnitIds,
  pickWeightedDrop,
  RARITY_DROP_WEIGHTS,
  RARITY_LUCK_WEIGHT_BONUS,
  type Rarity,
  unitsBestFirst,
  unitsPlainestFirst,
  unitsToEquipped,
  unitsToInventory,
} from "./items.js";

/** A unit with sensible defaults, so a test only states what it cares about. */
const unit = (
  id: string,
  itemId: string,
  upgradeLevel = 0,
  equippedSlot: ItemUnit["equippedSlot"] = null,
): ItemUnit => ({ id, itemId, upgradeLevel, equippedSlot });

describe("color equip slot", () => {
  it("is a catalog category", () => {
    expect(EQUIP_SLOTS).toContain("color");
  });

  it("is a storable equipped slot", () => {
    expect(EQUIPPED_SLOTS).toContain("color");
  });

  it("survives normalizeEquipped", () => {
    expect(normalizeEquipped({ color: "prism", head: "headphones" })).toEqual({
      color: "prism",
      head: "headphones",
    });
  });

  it("is discoverable by item id", () => {
    expect(findEquippedSlot({ color: "prism" }, "prism")).toBe("color");
  });

  it("counts toward equipped item ids", () => {
    expect(equippedItemIds({ color: "prism" })).toEqual(["prism"]);
  });
});

describe("prism", () => {
  const prism = getItem("prism");

  it("exists in the catalog", () => {
    expect(prism).toBeDefined();
  });

  it("matches the database row", () => {
    expect(prism).toMatchObject({
      id: "prism",
      name: "Prismatic Surrenderer",
      rarity: "uncommon",
      equipable: true,
      equipSlot: "color",
    });
  });

  it("is not stackable", () => {
    expect(prism?.stackable).toBeFalsy();
  });

  it("has renderable card art", () => {
    expect(prism?.frames.length).toBeGreaterThan(0);
    for (const frame of prism?.frames ?? []) {
      expect(frame.length).toBeGreaterThan(0);
    }
  });

  it("renders colour in its card art", () => {
    // The gradient should emit more than one distinct hue.
    const hues = new Set(
      (prism?.frames[0].join("") ?? "").match(/#[0-9A-Fa-f]{6}/g) ?? [],
    );
    expect(hues.size).toBeGreaterThan(2);
  });
});

describe("getItemType", () => {
  it("classifies color-slot items as skins", () => {
    expect(getItemType({ equipable: true, equipSlot: "color" })).toBe("skin");
  });

  it("classifies modifier-slot items as modifiers", () => {
    expect(
      getItemType({
        equipable: true,
        equipSlot: "modifier",
        modifier: { label: "Exp boost", tooltip: "2% per song hunt won" },
      }),
    ).toBe("modifier");
  });

  it("classifies head/face/body items as equipables", () => {
    expect(getItemType({ equipable: true, equipSlot: "head" })).toBe(
      "equipable",
    );
  });

  it("classifies scenery-slot items as scenery cards", () => {
    expect(getItemType({ equipable: true, equipSlot: "scenery" })).toBe(
      "sceneryCard",
    );
  });

  it("classifies non-modifier ground-slot items as accessories", () => {
    expect(getItemType({ equipable: true, equipSlot: "ground" })).toBe(
      "accessory",
    );
  });

  it("classifies non-equipable items as artefacts", () => {
    expect(getItemType({})).toBe("artefact");
  });

  it("good-eye-sniper is a modifier", () => {
    expect(getItemType(getItem("good-eye-sniper")!)).toBe("modifier");
  });

  it("classifies dice items as dice, ahead of the equipable fields", () => {
    expect(getItemType({ dice: true })).toBe("dice");
  });

  it("power-dice-1 is a dice, stackable, statted, and not equipable", () => {
    const item = getItem("power-dice-1");
    expect(getItemType(item!)).toBe("dice");
    expect(item?.stackable).toBe(true);
    expect(item?.equipable).toBeFalsy();
    expect(item?.stats).toBeUndefined();
  });
});

describe("modifier slot", () => {
  it("is a catalog category", () => {
    expect(EQUIP_SLOTS).toContain("modifier");
  });

  it("is not one of the single-value equipped slots", () => {
    expect(EQUIPPED_SLOTS).not.toContain("modifier");
  });

  it("good-eye-sniper equips into the modifier slot, not ground", () => {
    expect(getItem("good-eye-sniper")).toMatchObject({ equipSlot: "modifier" });
  });

  it("accumulates multiple ids rather than overwriting", () => {
    const equipped = normalizeEquipped({ modifier: ["a"] });
    equipped.modifier = [...(equipped.modifier ?? []), "b"];
    expect(equipped.modifier).toEqual(["a", "b"]);
  });

  it("survives normalizeEquipped as an array", () => {
    expect(normalizeEquipped({ modifier: ["good-eye-sniper"] })).toEqual({
      modifier: ["good-eye-sniper"],
    });
  });

  it("coerces a legacy scalar modifier value into a one-element array", () => {
    expect(normalizeEquipped({ modifier: "good-eye-sniper" })).toEqual({
      modifier: ["good-eye-sniper"],
    });
  });

  it("counts every modifier id toward equipped item ids", () => {
    expect(
      equippedItemIds({ head: "headphones", modifier: ["a", "b"] }),
    ).toEqual(["headphones", "a", "b"]);
  });

  it("is discoverable via isModifierEquipped", () => {
    expect(
      isModifierEquipped({ modifier: ["good-eye-sniper"] }, "good-eye-sniper"),
    ).toBe(true);
    expect(isModifierEquipped({ modifier: ["good-eye-sniper"] }, "other")).toBe(
      false,
    );
    expect(isModifierEquipped({}, "good-eye-sniper")).toBe(false);
  });
});

describe("spirit-orb", () => {
  const spiritOrb = getItem("spirit-orb");

  it("exists in the catalog as a ground-slot accessory", () => {
    expect(spiritOrb).toMatchObject({
      id: "spirit-orb",
      equipable: true,
      equipSlot: "ground",
    });
  });

  it("has no coin price, being the one money-only item", () => {
    // Deliberately unbuyable with coins: it is also the only equipable that
    // can never drop (see the exclusion test below), so a coin price would
    // make the one thing you cannot earn by playing earnable after all. It is
    // sold as a Stripe product joined by metadata.item_id — see the
    // /api/store/premium route — which is why no price lives here.
    expect(spiritOrb?.buyPrice).toBeUndefined();
  });

  it("has renderable card art", () => {
    expect(spiritOrb?.frames.length).toBeGreaterThan(0);
    for (const frame of spiritOrb?.frames ?? []) {
      expect(frame.length).toBeGreaterThan(0);
    }
  });

  it("is excluded from the world-drop pool (store-only)", () => {
    expect(NON_DROPPABLE_ITEM_IDS).toContain("spirit-orb");
  });
});

describe("NON_DROPPABLE_ITEM_IDS", () => {
  it("excludes first-edition, per 'any card but first edition can drop'", () => {
    expect(NON_DROPPABLE_ITEM_IDS).toContain("first-edition");
  });

  it("only references real catalog ids", () => {
    for (const id of NON_DROPPABLE_ITEM_IDS) {
      expect(getItem(id)).toBeDefined();
    }
  });
});

describe("pickWeightedDrop", () => {
  const candidates: { id: string; rarity: Rarity }[] = [
    { id: "a", rarity: "common" },
    { id: "b", rarity: "uncommon" },
    { id: "c", rarity: "rare" },
    { id: "d", rarity: "legendary" },
  ];

  it("returns undefined for an empty pool", () => {
    expect(pickWeightedDrop([])).toBeUndefined();
  });

  it("picks the first (heaviest) candidate when rng returns 0", () => {
    expect(pickWeightedDrop(candidates, 0, () => 0)?.id).toBe("a");
  });

  it("picks the last candidate when rng returns just under 1", () => {
    expect(pickWeightedDrop(candidates, 0, () => 0.999999)?.id).toBe("d");
  });

  it("skews toward common over legendary across many rolls", () => {
    let commonCount = 0;
    let legendaryCount = 0;
    for (let i = 0; i < 10_000; i++) {
      const picked = pickWeightedDrop(candidates);
      if (picked?.rarity === "common") commonCount++;
      if (picked?.rarity === "legendary") legendaryCount++;
    }
    expect(commonCount).toBeGreaterThan(legendaryCount);
  });

  it("weight table orders common > uncommon > rare > legendary", () => {
    expect(RARITY_DROP_WEIGHTS.common).toBeGreaterThan(
      RARITY_DROP_WEIGHTS.uncommon,
    );
    expect(RARITY_DROP_WEIGHTS.uncommon).toBeGreaterThan(
      RARITY_DROP_WEIGHTS.rare,
    );
    expect(RARITY_DROP_WEIGHTS.rare).toBeGreaterThan(
      RARITY_DROP_WEIGHTS.legendary,
    );
  });

  it("never picks a non-droppable item when the caller filters the pool first", () => {
    const nonDroppable: readonly string[] = NON_DROPPABLE_ITEM_IDS;
    const pool = ITEMS.filter((item) => !nonDroppable.includes(item.id));
    for (let i = 0; i < 500; i++) {
      const picked = pickWeightedDrop(pool);
      expect(nonDroppable).not.toContain(picked?.id);
    }
  });

  it("favors CD well above the heaviest rarity weight", () => {
    expect(ITEM_DROP_WEIGHT_OVERRIDES.cd).toBeGreaterThan(
      RARITY_DROP_WEIGHTS.common,
    );
  });

  it("picks CD far more often than any other single item in the full pool", () => {
    const nonDroppable: readonly string[] = NON_DROPPABLE_ITEM_IDS;
    const pool = ITEMS.filter((item) => !nonDroppable.includes(item.id));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const picked = pickWeightedDrop(pool);
      if (picked) counts[picked.id] = (counts[picked.id] ?? 0) + 1;
    }
    const cdCount = counts.cd ?? 0;
    for (const [id, count] of Object.entries(counts)) {
      if (id === "cd") continue;
      expect(cdCount).toBeGreaterThan(count);
    }
  });

  it("luck shifts the pick toward the rarer candidate at a fixed rng boundary", () => {
    const pool: { id: string; rarity: Rarity }[] = [
      { id: "common-thing", rarity: "common" },
      { id: "rare-thing", rarity: "rare" },
    ];
    // weight totals: luck 0 -> 1000 + 25 = 1025, boundary at 1000/1025 ≈ 0.97561
    // luck 10 -> 1000 + 25*1.15 = 1028.75, boundary at 1000/1028.75 ≈ 0.97205
    // 0.974 sits between the two boundaries: common at luck 0, rare at luck 10.
    expect(pickWeightedDrop(pool, 0, () => 0.974)?.id).toBe("common-thing");
    expect(pickWeightedDrop(pool, 10, () => 0.974)?.id).toBe("rare-thing");
  });

  it("never lets luck touch cd's odds (common rarity has a zero luck bonus)", () => {
    expect(RARITY_LUCK_WEIGHT_BONUS.common).toBe(0);
  });
});

describe("bank capacity", () => {
  it("counts a stackable item as one slot regardless of quantity", () => {
    expect(bankSlotsUsed({ cd: 12 }, {})).toBe(1);
  });

  it("counts a non-stackable item as one slot per unit owned", () => {
    expect(bankSlotsUsed({ headphones: 3 }, {})).toBe(3);
  });

  it("frees the slot for whichever unit is currently equipped", () => {
    expect(bankSlotsUsed({ headphones: 3 }, { head: "headphones" })).toBe(2);
    expect(bankSlotsUsed({ prism: 1 }, { color: "prism" })).toBe(0);
  });

  it("ignores items owned with a non-positive quantity", () => {
    expect(bankSlotsUsed({ cd: 0, headphones: -1 }, {})).toBe(0);
  });

  it("is full only once every slot is spoken for", () => {
    const inventory = {
      cd: 1,
      "first-edition": 1,
      headphones: BANK_SLOT_COUNT - 2,
    };
    expect(bankSlotsUsed(inventory, {})).toBe(BANK_SLOT_COUNT);
    expect(isBankFull(inventory, {})).toBe(true);
    expect(
      isBankFull({ ...inventory, headphones: BANK_SLOT_COUNT - 3 }, {}),
    ).toBe(false);
  });

  it("treats a null/empty inventory as empty", () => {
    expect(bankSlotsUsed(null, {})).toBe(0);
    expect(isBankFull(null, {})).toBe(false);
  });

  // No catalog item is both stackable and equipable any more (First Edition
  // was the only one), but the rule still has to hold for whichever item is
  // next, so it's exercised through a lookup rather than a real id.
  const stackableHat: BankItemLookup = () => ({
    stackable: true,
    category: "deck",
  });

  it("still charges a bank slot for a stackable item with copies left after one is equipped", () => {
    // Owning 3, equipping 1 — 2 remain in the bank, so the slot is still needed.
    expect(bankSlotsUsed({ hat: 3 }, { modifier: ["hat"] }, stackableHat)).toBe(
      1,
    );
  });

  it("frees the slot once the only remaining copy of a stackable item is equipped", () => {
    expect(bankSlotsUsed({ hat: 1 }, { modifier: ["hat"] }, stackableHat)).toBe(
      0,
    );
  });

  it("charges First Edition Card per copy now that it isn't stackable", () => {
    expect(getItem("first-edition")?.stackable).toBeFalsy();
    expect(bankSlotsUsed({ "first-edition": 3 }, {})).toBe(3);
    expect(
      bankSlotsUsed({ "first-edition": 3 }, { modifier: ["first-edition"] }),
    ).toBe(2);
  });
});

describe("applyEquip", () => {
  const equip = (
    units: ItemUnit[],
    unitId: string,
    slot: Parameters<typeof applyEquip>[3],
    side?: Parameters<typeof applyEquip>[4],
  ) => applyEquip(units, unitId, "equip", slot, side);

  /** Unwraps a success, failing loudly rather than silently typing around it. */
  const after = (outcome: ReturnType<typeof applyEquip>) => {
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    return outcome.units;
  };

  it("puts a single-value item in its own slot", () => {
    const next = after(equip([unit("u1", "headphones")], "u1", "head"));
    expect(unitsToEquipped(next)).toEqual({ head: "headphones" });
  });

  it("displaces the incumbent when its slot is taken", () => {
    // Swapping a hat shouldn't require unequipping the old one first — and the
    // displaced copy must go back to the bank.
    const next = after(
      equip(
        [unit("old", "rainbow-headband", 0, "head"), unit("u1", "headphones")],
        "u1",
        "head",
      ),
    );
    expect(unitsToEquipped(next)).toEqual({ head: "headphones" });
    expect(next.find((u) => u.id === "old")?.equippedSlot).toBeNull();
  });

  it("leaves other slots untouched and never mutates the input", () => {
    const units = [
      unit("a", "rainbow-headband", 0, "head"),
      unit("b", "prism", 0, "color"),
      unit("c", "cd"),
    ];
    const snapshot = structuredClone(units);
    const next = after(equip(units, "c", "face"));
    expect(unitsToEquipped(next)).toEqual({
      head: "rainbow-headband",
      color: "prism",
      face: "cd",
    });
    expect(units).toEqual(snapshot);
  });

  it("routes ground items to the requested side", () => {
    const units = [unit("u1", "spirit-orb")];
    expect(
      unitsToEquipped(after(equip(units, "u1", "ground", "left"))),
    ).toEqual({
      ground_left: "spirit-orb",
    });
    expect(
      unitsToEquipped(after(equip(units, "u1", "ground", "right"))),
    ).toEqual({ ground_right: "spirit-orb" });
  });

  it("requires a side for ground items", () => {
    expect(equip([unit("u1", "spirit-orb")], "u1", "ground")).toEqual({
      ok: false,
      reason: "missing-side",
    });
  });

  it("accumulates modifiers up to the cap", () => {
    let units: ItemUnit[] = Array.from({ length: MAX_MODIFIERS + 1 }, (_, i) =>
      unit(`m${i}`, `mod-${i}`),
    );
    for (let i = 0; i < MAX_MODIFIERS; i++) {
      units = after(equip(units, `m${i}`, "modifier"));
    }
    expect(unitsToEquipped(units).modifier).toHaveLength(MAX_MODIFIERS);
    expect(equip(units, `m${MAX_MODIFIERS}`, "modifier")).toEqual({
      ok: false,
      reason: "max-modifiers",
    });
  });

  it("refuses to equip something already worn in that slot", () => {
    expect(equip([unit("u1", "headphones", 0, "head")], "u1", "head")).toEqual({
      ok: false,
      reason: "already-equipped",
    });
    expect(
      equip([unit("u1", "boost", 0, "modifier")], "u1", "modifier"),
    ).toEqual({ ok: false, reason: "already-equipped" });
  });

  it("refuses an equipable item with no slot", () => {
    expect(equip([unit("u1", "mystery")], "u1", undefined)).toEqual({
      ok: false,
      reason: "no-slot",
    });
  });

  it("refuses a unit the player doesn't own", () => {
    expect(equip([unit("u1", "headphones")], "nope", "head")).toEqual({
      ok: false,
      reason: "not-owned",
    });
  });

  // One copy of an item worn at a time has always been the rule. With copies
  // that can differ it becomes a swap, not a second equip that would count the
  // item's stats twice.
  it("swaps to another copy of an item whose other copy is worn", () => {
    const units = [
      unit("plain", "boombox", 0, "ground_left"),
      unit("plus3", "boombox", 3),
    ];
    const next = after(equip(units, "plus3", "ground", "right"));
    expect(next.find((u) => u.id === "plain")?.equippedSlot).toBeNull();
    expect(next.find((u) => u.id === "plus3")?.equippedSlot).toBe(
      "ground_right",
    );
    expect(unitsToEquipped(next)).toEqual({ ground_right: "boombox" });
  });

  it("moves a worn copy between ground sides", () => {
    const next = after(
      equip([unit("u1", "boombox", 0, "ground_left")], "u1", "ground", "right"),
    );
    expect(unitsToEquipped(next)).toEqual({ ground_right: "boombox" });
  });

  it("lets a swapped-in copy take a full modifier list when it replaces its own twin", () => {
    // The cap counts OTHER items: swapping copies of an item already among the
    // six must not be refused as a seventh.
    const units = [
      ...Array.from({ length: MAX_MODIFIERS - 1 }, (_, i) =>
        unit(`m${i}`, `mod-${i}`, 0, "modifier"),
      ),
      unit("fe-worn", "first-edition", 0, "modifier"),
      unit("fe-spare", "first-edition", 2),
    ];
    const next = after(equip(units, "fe-spare", "modifier"));
    expect(next.find((u) => u.id === "fe-worn")?.equippedSlot).toBeNull();
    expect(next.find((u) => u.id === "fe-spare")?.equippedSlot).toBe(
      "modifier",
    );
  });

  it("unequips a single-value slot", () => {
    const units = [
      unit("a", "headphones", 0, "head"),
      unit("b", "prism", 0, "color"),
    ];
    expect(
      unitsToEquipped(after(applyEquip(units, "a", "unequip", "head"))),
    ).toEqual({ color: "prism" });
  });

  it("unequips one modifier and leaves the rest", () => {
    const units = [
      unit("a", "boost", 0, "modifier"),
      unit("b", "other", 0, "modifier"),
    ];
    const next = after(applyEquip(units, "a", "unequip", "modifier"));
    expect(unitsToEquipped(next)).toEqual({ modifier: ["other"] });
  });

  it("refuses to unequip something that isn't worn", () => {
    expect(
      applyEquip([unit("u1", "headphones")], "u1", "unequip", "head"),
    ).toEqual({ ok: false, reason: "not-equipped" });
  });

  // The whole point of sharing this function: an optimistic client prediction
  // and the server's persisted result must be identical, so the response lands
  // as a no-op instead of a visible correction.
  it("is deterministic for the same input", () => {
    const units = [unit("a", "rainbow-headband", 0, "head"), unit("b", "cd")];
    expect(equip(units, "b", "face")).toEqual(equip(units, "b", "face"));
  });
});

describe("applySell", () => {
  const price = (id: string) => (id === "junk" ? undefined : 10);
  const sold = (outcome: ReturnType<typeof applySell>) => {
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    return outcome;
  };

  it("removes the sold units and credits the currency", () => {
    const units = [unit("a", "cd"), unit("b", "cd"), unit("c", "cd")];
    const out = sold(applySell(units, 100, ["a", "b"], price));
    expect(out.units.map((u) => u.id)).toEqual(["c"]);
    expect(out.earned).toBe(20);
    expect(out.newCurrency).toBe(120);
  });

  it("sells exactly the copy named, not a different one of the same item", () => {
    // The reason this takes unit ids: sell the plain copy, keep the +3.
    const units = [unit("plain", "boombox"), unit("plus3", "boombox", 3)];
    const out = sold(applySell(units, 0, ["plain"], price));
    expect(out.units).toEqual([unit("plus3", "boombox", 3)]);
  });

  it("never mutates its inputs", () => {
    const units = [unit("a", "cd", 0, "head")];
    const snapshot = structuredClone(units);
    applySell(units, 0, ["a"], price);
    expect(units).toEqual(snapshot);
  });

  // Ownership and equip state must never drift: a copy you no longer own can't
  // stay worn. It falls out of the copy simply no longer existing.
  it("a sold worn copy stops being worn", () => {
    const units = [
      unit("a", "headphones", 0, "head"),
      unit("b", "prism", 0, "color"),
    ];
    const out = sold(applySell(units, 0, ["a"], price));
    expect(unitsToEquipped(out.units)).toEqual({ color: "prism" });
  });

  it("keeps the worn copy while another copy is sold", () => {
    const units = [unit("worn", "cd", 0, "head"), unit("spare", "cd")];
    const out = sold(applySell(units, 0, ["spare"], price));
    expect(unitsToEquipped(out.units)).toEqual({ head: "cd" });
  });

  it("refuses to sell a copy the player doesn't own", () => {
    expect(applySell([unit("a", "cd")], 0, ["a", "ghost"], price)).toEqual({
      ok: false,
      reason: "not-enough",
    });
    expect(applySell([], 0, ["a"], price)).toEqual({
      ok: false,
      reason: "not-enough",
    });
  });

  it("refuses an empty sale", () => {
    expect(applySell([unit("a", "cd")], 0, [], price)).toEqual({
      ok: false,
      reason: "not-enough",
    });
  });

  it("refuses an item with no sell price", () => {
    expect(applySell([unit("a", "junk")], 0, ["a"], price)).toEqual({
      ok: false,
      reason: "not-sellable",
    });
  });

  it("counts a unit named twice once", () => {
    const out = sold(applySell([unit("a", "cd")], 0, ["a", "a"], price));
    expect(out.earned).toBe(10);
  });
});

describe("hasRoomFor", () => {
  /** Fills the bank to exactly capacity with distinct non-stackable ids. */
  const fullBank = () =>
    Object.fromEntries(
      Array.from({ length: BANK_SLOT_COUNT }, (_, i) => [`filler-${i}`, 1]),
    );

  it("allows a new item while there is a free slot", () => {
    const almost = fullBank();
    delete almost[`filler-0`];
    expect(hasRoomFor(almost, {}, "cd")).toBe(true);
  });

  it("blocks a new non-stackable item at capacity", () => {
    expect(isBankFull(fullBank(), {})).toBe(true);
    expect(hasRoomFor(fullBank(), {}, "cd")).toBe(false);
  });

  /** Treats only the named ids as stackable; everything else is not. */
  const stackableOnly =
    (...ids: string[]): BankItemLookup =>
    (id) => ({ stackable: ids.includes(id), category: "deck" });

  // The reason this exists rather than callers using isBankFull: another copy
  // of an already-stacked item needs no new slot, so a full bank must not
  // block it.
  it("allows another copy of a stackable already owned, even when full", () => {
    const lookup = stackableOnly("stack");
    // 17 one-per-slot fillers plus a stack that occupies exactly one slot.
    const full: Record<string, number> = { ...fullBank(), stack: 3 };
    delete full["filler-0"];
    expect(isBankFull(full, {}, lookup)).toBe(true);
    expect(hasRoomFor(full, {}, "stack", lookup)).toBe(true);
  });

  it("blocks a stackable not yet owned when full", () => {
    const lookup = stackableOnly("brand-new");
    expect(isBankFull(fullBank(), {}, lookup)).toBe(true);
    expect(hasRoomFor(fullBank(), {}, "brand-new", lookup)).toBe(false);
  });

  it("counts an equipped copy as freeing its bank slot", () => {
    // Equipping reserves a unit as worn, so the bank has room again.
    const full = fullBank();
    expect(hasRoomFor(full, { head: "filler-0" }, "cd")).toBe(true);
  });

  it("treats an empty inventory as having room", () => {
    expect(hasRoomFor(null, {}, "cd")).toBe(true);
    expect(hasRoomFor({}, {}, "cd")).toBe(true);
  });
});

describe("herzie stats", () => {
  it("gives Box of Boom +10 and the Intimite Music Device +5 sonic power", () => {
    expect(getItem("boombox")?.stats).toEqual({ sonicPower: 10 });
    expect(getItem("headphones")?.stats).toEqual({ sonicPower: 5 });
  });

  it("is zero for a herzie with nothing equipped", () => {
    expect(getHerzieStats({})).toEqual({ sonicPower: 0, luck: 0 });
    expect(getHerzieStats(null)).toEqual({ sonicPower: 0, luck: 0 });
  });

  it("adds up the stats of equipped items", () => {
    expect(getHerzieStats({ ground_left: "boombox" }).sonicPower).toBe(10);
    expect(getHerzieStats({ head: "headphones" }).sonicPower).toBe(5);
    // Stats add up across slots, and either ground side counts.
    expect(
      getHerzieStats({ ground_right: "boombox", head: "headphones" })
        .sonicPower,
    ).toBe(15);
    // An item with no stats adds nothing.
    expect(
      getHerzieStats({ ground_left: "boombox", head: "rainbow-headband" })
        .sonicPower,
    ).toBe(10);
  });

  it("ignores items that are owned but not equipped, and unknown ids", () => {
    expect(getHerzieStats({ head: "no-such-item" }).sonicPower).toBe(0);
  });

  it("gives First Edition Card +10 luck and makes it a modifier", () => {
    const item = getItem("first-edition");
    expect(item?.stats).toEqual({ luck: 10 });
    // Statted, so its copies can differ in level, so it can't share a tile.
    expect(item?.stackable).toBeFalsy();
    expect(item?.equipable).toBe(true);
    expect(item?.equipSlot).toBe("modifier");
    expect(getItemType(item!)).toBe("modifier");
  });

  it("adds First Edition Card's luck through getHerzieStats", () => {
    expect(getHerzieStats({ modifier: ["first-edition"] }).luck).toBe(10);
    expect(getHerzieStats({}).luck).toBe(0);
  });

  it("adds the dice-upgrade level to every stat key an equipped item defines", () => {
    expect(
      getHerzieStats({ ground_left: "boombox" }, { boombox: 2 }).sonicPower,
    ).toBe(12); // base 10 + level 2
  });

  it("ignores upgrade levels on items that aren't equipped", () => {
    expect(getHerzieStats({}, { boombox: 3 }).sonicPower).toBe(0);
  });

  it("ignores upgrade levels on items with no stats at all", () => {
    expect(
      getHerzieStats(
        { head: "rainbow-headband" },
        {
          "rainbow-headband": 3,
        },
      ),
    ).toEqual({ sonicPower: 0, luck: 0 });
  });
});

describe("applyItemUpgrade", () => {
  const dice = "power-dice-1";

  it("rejects a non-dice id", () => {
    expect(
      applyItemUpgrade([unit("c", "cd"), unit("b", "boombox")], "cd", "b"),
    ).toEqual({ ok: false, reason: "not-dice" });
  });

  it("rejects when no die is owned", () => {
    expect(applyItemUpgrade([unit("b", "boombox")], dice, "b")).toEqual({
      ok: false,
      reason: "dice-not-owned",
    });
  });

  it("rejects when the target copy isn't owned", () => {
    expect(applyItemUpgrade([unit("d", dice)], dice, "b")).toEqual({
      ok: false,
      reason: "target-not-owned",
    });
  });

  it("rejects an unstatted target", () => {
    expect(
      applyItemUpgrade([unit("d", dice), unit("c", "cd")], dice, "c"),
    ).toEqual({ ok: false, reason: "not-statted" });
  });

  it("rejects past the level cap", () => {
    expect(
      applyItemUpgrade(
        [unit("d", dice), unit("b", "boombox", MAX_ITEM_UPGRADE_LEVEL)],
        dice,
        "b",
      ),
    ).toEqual({ ok: false, reason: "max-level" });
  });

  it("consumes one die and raises the level", () => {
    const out = applyItemUpgrade(
      [unit("d1", dice), unit("d2", dice), unit("b", "boombox")],
      dice,
      "b",
    );
    expect(out).toEqual({
      ok: true,
      units: [unit("d2", dice), unit("b", "boombox", 1)],
      newLevel: 1,
    });
  });

  // The bug this whole change exists for: two Box of Booms, one upgraded to +3
  // — the other must NOT change.
  it("raises only the targeted copy, never its twin", () => {
    let units: ItemUnit[] = [
      unit("d1", dice),
      unit("d2", dice),
      unit("d3", dice),
      unit("a", "boombox"),
      unit("b", "boombox"),
    ];
    for (let i = 0; i < 3; i++) {
      const out = applyItemUpgrade(units, dice, "a");
      if (!out.ok) throw new Error(out.reason);
      units = out.units;
    }
    expect(units.find((u) => u.id === "a")?.upgradeLevel).toBe(3);
    expect(units.find((u) => u.id === "b")?.upgradeLevel).toBe(0);
    expect(unitsToInventory(units)).toEqual({ boombox: 2 });
  });

  it("won't spend a die that is somehow worn", () => {
    expect(
      applyItemUpgrade(
        [unit("d", dice, 0, "modifier"), unit("b", "boombox")],
        dice,
        "b",
      ),
    ).toEqual({ ok: false, reason: "dice-not-owned" });
  });

  it("never mutates its inputs", () => {
    const units = [unit("d", dice), unit("b", "boombox", 1)];
    const snapshot = structuredClone(units);
    applyItemUpgrade(units, dice, "b");
    expect(units).toEqual(snapshot);
  });
});

describe("item units", () => {
  it("derives the legacy count and equipped views", () => {
    const units = [
      unit("a", "boombox", 3, "ground_left"),
      unit("b", "boombox"),
      unit("c", "first-edition", 0, "modifier"),
      unit("d", "cd"),
    ];
    expect(unitsToInventory(units)).toEqual({
      boombox: 2,
      "first-edition": 1,
      cd: 1,
    });
    expect(unitsToEquipped(units)).toEqual({
      ground_left: "boombox",
      modifier: ["first-edition"],
    });
  });

  it("derives nothing from no units", () => {
    expect(unitsToInventory([])).toEqual({});
    expect(unitsToEquipped([])).toEqual({});
  });

  it("normalizes an untrusted payload, dropping the malformed", () => {
    expect(
      normalizeUnits([
        { id: "a", itemId: "boombox", upgradeLevel: 2, equippedSlot: "head" },
        { id: "b", itemId: "cd" },
        { id: "c", itemId: "cd", equippedSlot: "not-a-slot" },
        { itemId: "cd" },
        null,
        "junk",
      ]),
    ).toEqual([
      unit("a", "boombox", 2, "head"),
      unit("b", "cd"),
      unit("c", "cd"),
    ]);
    expect(normalizeUnits(undefined)).toEqual([]);
    expect(normalizeUnits({})).toEqual([]);
  });

  it("adds each worn copy's OWN level to its stats", () => {
    // Two boomboxes, one +3: only the worn one counts, at its own level.
    const wornPlus3 = [
      unit("a", "boombox", 3, "ground_left"),
      unit("b", "boombox"),
    ];
    expect(getHerzieStatsFromUnits(wornPlus3).sonicPower).toBe(13);
    const wornPlain = [
      unit("a", "boombox", 3),
      unit("b", "boombox", 0, "ground_left"),
    ];
    expect(getHerzieStatsFromUnits(wornPlain).sonicPower).toBe(10);
  });

  it("agrees with the id-keyed getHerzieStats for the same wardrobe", () => {
    const units = [
      unit("a", "boombox", 2, "ground_right"),
      unit("b", "headphones", 1, "head"),
      unit("c", "first-edition", 0, "modifier"),
    ];
    expect(getHerzieStatsFromUnits(units)).toEqual(
      getHerzieStats(unitsToEquipped(units), { boombox: 2, headphones: 1 }),
    );
  });

  it("is zero with nothing worn", () => {
    expect(getHerzieStatsFromUnits(null)).toEqual({ sonicPower: 0, luck: 0 });
    expect(getHerzieStatsFromUnits([unit("a", "boombox", 3)])).toEqual({
      sonicPower: 0,
      luck: 0,
    });
  });
});

describe("bossDamagePerMinute", () => {
  it("is the base rate with no sonic power", () => {
    expect(bossDamagePerMinute({ sonicPower: 0, luck: 0 })).toBe(1);
  });

  it("treats sonic power as a percentage on top of the base rate", () => {
    expect(bossDamagePerMinute({ sonicPower: 10, luck: 0 })).toBeCloseTo(
      1.1,
      10,
    );
    expect(bossDamagePerMinute({ sonicPower: 50, luck: 0 })).toBeCloseTo(
      1.5,
      10,
    );
  });
});

describe("bank tiles", () => {
  it("folds a stack into one tile and gives every other copy its own", () => {
    const tiles = bankTiles([
      unit("c1", "cd"),
      unit("c2", "cd"),
      unit("b1", "boombox", 3),
      unit("b2", "boombox"),
    ]);
    expect(tiles).toEqual([
      { key: "stack:cd", itemId: "cd", unitIds: ["c1", "c2"], upgradeLevel: 0 },
      { key: "b1", itemId: "boombox", unitIds: ["b1"], upgradeLevel: 3 },
      { key: "b2", itemId: "boombox", unitIds: ["b2"], upgradeLevel: 0 },
    ]);
  });

  it("leaves worn copies out of the bank", () => {
    const tiles = bankTiles([
      unit("worn", "boombox", 3, "ground_left"),
      unit("spare", "boombox"),
    ]);
    expect(tiles.map((t) => t.key)).toEqual(["spare"]);
  });

  it("keeps a stack's tile while any copy of it is unworn", () => {
    const stackable: BankItemLookup = () => ({
      stackable: true,
      category: "deck",
    });
    expect(
      bankTiles(
        [unit("a", "hat", 0, "modifier"), unit("b", "hat")],
        stackable,
      ).map((t) => t.key),
    ).toEqual(["stack:hat"]);
    expect(bankTiles([unit("a", "hat", 0, "modifier")], stackable)).toEqual([]);
  });

  it("skips items outside the deck category", () => {
    const misc: BankItemLookup = () => ({ category: "misc" });
    expect(bankTiles([unit("a", "thing")], misc)).toEqual([]);
  });

  // The tile list and the capacity rule are one rule: however the copies are
  // arranged, the grid must show exactly as many tiles as bankSlotsUsed counts.
  it("always has as many tiles as bankSlotsUsed counts slots", () => {
    const wardrobes: ItemUnit[][] = [
      [],
      [unit("a", "cd"), unit("b", "cd"), unit("c", "cd")],
      [unit("a", "boombox", 1), unit("b", "boombox", 3)],
      [
        unit("a", "boombox", 1, "ground_left"),
        unit("b", "boombox", 3),
        unit("c", "headphones", 0, "head"),
        unit("d", "first-edition", 0, "modifier"),
        unit("e", "first-edition", 2),
        unit("f", "cd"),
        unit("g", "cd"),
        unit("h", "power-dice-1"),
      ],
    ];
    for (const units of wardrobes) {
      expect(bankTiles(units)).toHaveLength(
        bankSlotsUsed(unitsToInventory(units), unitsToEquipped(units)),
      );
    }
  });
});

describe("choosing copies from an item id", () => {
  const units = [
    unit("worn", "boombox", 0, "ground_left"),
    unit("plus3", "boombox", 3),
    unit("plus1", "boombox", 1),
    unit("plain", "boombox"),
    unit("cd", "cd"),
  ];

  it("orders copies plainest first: unworn, then lowest level, then oldest", () => {
    expect(unitsPlainestFirst(units, "boombox").map((u) => u.id)).toEqual([
      "plain",
      "plus1",
      "plus3",
      "worn",
    ]);
  });

  it("picks the plainest N, or null if there aren't N", () => {
    expect(pickPlainestUnitIds(units, "boombox", 2)).toEqual([
      "plain",
      "plus1",
    ]);
    expect(pickPlainestUnitIds(units, "boombox", 5)).toBeNull();
    expect(pickPlainestUnitIds(units, "nothing", 1)).toBeNull();
  });

  it("orders copies best first: worn, then highest level", () => {
    expect(unitsBestFirst(units, "boombox").map((u) => u.id)).toEqual([
      "worn",
      "plus3",
      "plus1",
      "plain",
    ]);
  });

  it("finds the copy an item id most plausibly means", () => {
    expect(bestUnitOf(units, "boombox")?.id).toBe("worn");
    expect(bestUnitOf(units.slice(1), "boombox")?.id).toBe("plus3");
    expect(bestUnitOf(units, "nothing")).toBeUndefined();
  });

  it("never mutates its input", () => {
    const snapshot = structuredClone(units);
    unitsPlainestFirst(units, "boombox");
    unitsBestFirst(units, "boombox");
    expect(units).toEqual(snapshot);
  });
});
