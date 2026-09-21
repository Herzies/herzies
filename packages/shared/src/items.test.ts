import { describe, expect, it } from "vitest";
import {
  applyEquip,
  applySell,
  BANK_SLOT_COUNT,
  type BankItemLookup,
  bankSlotsUsed,
  bossDamagePerMinute,
  EQUIP_SLOTS,
  EQUIPPED_SLOTS,
  equippedItemIds,
  findEquippedSlot,
  getHerzieStats,
  getItem,
  getItemType,
  hasRoomFor,
  ITEM_DROP_WEIGHT_OVERRIDES,
  ITEMS,
  isBankFull,
  isModifierEquipped,
  MAX_MODIFIERS,
  NON_DROPPABLE_ITEM_IDS,
  normalizeEquipped,
  pickWeightedDrop,
  RARITY_DROP_WEIGHTS,
  type Rarity,
} from "./items.js";

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
    expect(pickWeightedDrop(candidates, () => 0)?.id).toBe("a");
  });

  it("picks the last candidate when rng returns just under 1", () => {
    expect(pickWeightedDrop(candidates, () => 0.999999)?.id).toBe("d");
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
});

describe("applyEquip", () => {
  const equip = (
    current: Parameters<typeof applyEquip>[0],
    itemId: string,
    slot: Parameters<typeof applyEquip>[3],
    side?: Parameters<typeof applyEquip>[4],
  ) => applyEquip(current, itemId, "equip", slot, side);

  /** Unwraps a success, failing loudly rather than silently typing around it. */
  const equipped = (outcome: ReturnType<typeof applyEquip>) => {
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    return outcome.equipped;
  };

  it("puts a single-value item in its own slot", () => {
    expect(equipped(equip({}, "headphones", "head"))).toEqual({
      head: "headphones",
    });
  });

  it("displaces the incumbent when its slot is taken", () => {
    // Swapping a hat shouldn't require unequipping the old one first — and the
    // displaced id must vanish from Equipped so it returns to the bank.
    const next = equipped(equip({ head: "old-hat" }, "headphones", "head"));
    expect(next).toEqual({ head: "headphones" });
    expect(findEquippedSlot(next, "old-hat")).toBeNull();
  });

  it("leaves other slots untouched and never mutates the input", () => {
    const current = { head: "old-hat", color: "prism" };
    const next = equipped(equip(current, "cd", "face"));
    expect(next).toEqual({ head: "old-hat", color: "prism", face: "cd" });
    expect(current).toEqual({ head: "old-hat", color: "prism" });
  });

  it("routes ground items to the requested side", () => {
    expect(equipped(equip({}, "spirit-orb", "ground", "left"))).toEqual({
      ground_left: "spirit-orb",
    });
    expect(equipped(equip({}, "spirit-orb", "ground", "right"))).toEqual({
      ground_right: "spirit-orb",
    });
  });

  it("requires a side for ground items", () => {
    expect(equip({}, "spirit-orb", "ground")).toEqual({
      ok: false,
      reason: "missing-side",
    });
  });

  it("accumulates modifiers up to the cap", () => {
    let current = {};
    for (let i = 0; i < MAX_MODIFIERS; i++) {
      current = equipped(equip(current, `mod-${i}`, "modifier"));
    }
    expect(current).toEqual({
      modifier: Array.from({ length: MAX_MODIFIERS }, (_, i) => `mod-${i}`),
    });
    expect(equip(current, "one-too-many", "modifier")).toEqual({
      ok: false,
      reason: "max-modifiers",
    });
  });

  it("refuses to equip something already worn", () => {
    expect(equip({ head: "headphones" }, "headphones", "head")).toEqual({
      ok: false,
      reason: "already-equipped",
    });
    expect(equip({ modifier: ["boost"] }, "boost", "modifier")).toEqual({
      ok: false,
      reason: "already-equipped",
    });
  });

  it("refuses an equipable item with no slot", () => {
    expect(equip({}, "mystery", undefined)).toEqual({
      ok: false,
      reason: "no-slot",
    });
  });

  it("unequips from a single-value slot", () => {
    expect(
      equipped(
        applyEquip(
          { head: "headphones", color: "prism" },
          "headphones",
          "unequip",
          "head",
        ),
      ),
    ).toEqual({ color: "prism" });
  });

  it("unequips one modifier and drops the key once empty", () => {
    const two = { modifier: ["a", "b"] };
    expect(equipped(applyEquip(two, "a", "unequip", "modifier"))).toEqual({
      modifier: ["b"],
    });
    // An empty modifier list is normalized away, so don't persist one.
    expect(
      equipped(applyEquip({ modifier: ["a"] }, "a", "unequip", "modifier")),
    ).toEqual({});
  });

  it("refuses to unequip something that isn't worn", () => {
    expect(applyEquip({}, "headphones", "unequip", "head")).toEqual({
      ok: false,
      reason: "not-equipped",
    });
  });

  // The whole point of sharing this function: an optimistic client prediction
  // and the server's persisted result must be identical, so the response lands
  // as a no-op instead of a visible correction.
  it("is deterministic for the same input", () => {
    const current = { head: "old-hat", modifier: ["a"] };
    expect(equip(current, "cd", "face")).toEqual(equip(current, "cd", "face"));
  });
});

describe("applySell", () => {
  const PRICE = 10;
  const sold = (outcome: ReturnType<typeof applySell>) => {
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    return outcome;
  };

  it("removes the sold units and credits the currency", () => {
    const out = sold(applySell({ cd: 3 }, 100, {}, "cd", 2, PRICE));
    expect(out.inventory).toEqual({ cd: 1 });
    expect(out.earned).toBe(20);
    expect(out.newCurrency).toBe(120);
    expect(out.unequipped).toBe(false);
  });

  it("drops the id entirely when the last copy goes", () => {
    const out = sold(applySell({ cd: 1 }, 0, {}, "cd", 1, PRICE));
    expect(out.inventory).toEqual({});
    expect("cd" in out.inventory).toBe(false);
  });

  it("never mutates its inputs", () => {
    const inventory = { cd: 2 };
    const equipped = { head: "cd" };
    applySell(inventory, 0, equipped, "cd", 2, PRICE);
    expect(inventory).toEqual({ cd: 2 });
    expect(equipped).toEqual({ head: "cd" });
  });

  // Ownership and equip state must never drift: an item you no longer own
  // cannot stay worn, and this has to agree with applyEquip's unequip branch.
  it("unequips when the last copy is sold", () => {
    const out = sold(
      applySell({ cd: 1 }, 0, { head: "cd", color: "prism" }, "cd", 1, PRICE),
    );
    expect(out.equipped).toEqual({ color: "prism" });
    expect(out.unequipped).toBe(true);
  });

  it("unequips a modifier when its last copy is sold", () => {
    const out = sold(
      applySell({ boost: 1 }, 0, { modifier: ["boost"] }, "boost", 1, PRICE),
    );
    expect(out.equipped).toEqual({});
    expect(out.unequipped).toBe(true);
  });

  it("keeps it equipped while a copy remains", () => {
    const out = sold(applySell({ cd: 2 }, 0, { head: "cd" }, "cd", 1, PRICE));
    expect(out.equipped).toEqual({ head: "cd" });
    expect(out.unequipped).toBe(false);
  });

  it("refuses to sell more than is owned", () => {
    expect(applySell({ cd: 1 }, 0, {}, "cd", 2, PRICE)).toEqual({
      ok: false,
      reason: "not-enough",
    });
    expect(applySell({}, 0, {}, "cd", 1, PRICE)).toEqual({
      ok: false,
      reason: "not-enough",
    });
  });

  it("refuses an item with no sell price", () => {
    expect(applySell({ cd: 1 }, 0, {}, "cd", 1, undefined)).toEqual({
      ok: false,
      reason: "not-sellable",
    });
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
    expect(getHerzieStats({})).toEqual({ sonicPower: 0 });
    expect(getHerzieStats(null)).toEqual({ sonicPower: 0 });
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
});

describe("bossDamagePerMinute", () => {
  it("is the base rate with no sonic power", () => {
    expect(bossDamagePerMinute({ sonicPower: 0 })).toBe(1);
  });

  it("treats sonic power as a percentage on top of the base rate", () => {
    expect(bossDamagePerMinute({ sonicPower: 10 })).toBeCloseTo(1.1, 10);
    expect(bossDamagePerMinute({ sonicPower: 50 })).toBeCloseTo(1.5, 10);
  });
});
