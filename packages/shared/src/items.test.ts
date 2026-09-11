import { describe, expect, it } from "vitest";
import {
  BANK_SLOT_COUNT,
  bankSlotsUsed,
  EQUIP_SLOTS,
  EQUIPPED_SLOTS,
  equippedItemIds,
  findEquippedSlot,
  getItem,
  getItemType,
  ITEM_DROP_WEIGHT_OVERRIDES,
  ITEMS,
  isBankFull,
  isModifierEquipped,
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

  it("exists in the catalog as a purchasable ground-slot accessory", () => {
    expect(spiritOrb).toMatchObject({
      id: "spirit-orb",
      equipable: true,
      equipSlot: "ground",
    });
    expect(spiritOrb?.buyPrice).toBeGreaterThan(0);
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
