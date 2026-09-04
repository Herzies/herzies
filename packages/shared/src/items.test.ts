import { describe, expect, it } from "vitest";
import {
  EQUIP_SLOTS,
  EQUIPPED_SLOTS,
  equippedItemIds,
  findEquippedSlot,
  getItem,
  getItemType,
  isModifierEquipped,
  normalizeEquipped,
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
