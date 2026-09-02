import { describe, expect, it } from "vitest";
import {
  EQUIP_SLOTS,
  EQUIPPED_SLOTS,
  equippedItemIds,
  findEquippedSlot,
  getItem,
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
