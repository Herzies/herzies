import type { ItemUnit } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import {
  countByItem,
  itemResponse,
  sameOffer,
  unitForLegacyEquip,
  unitForLegacyUnequip,
  unitForLegacyUpgrade,
  unitsForLegacyCount,
} from "./item-units";

const unit = (
  id: string,
  itemId: string,
  upgradeLevel = 0,
  equippedSlot: ItemUnit["equippedSlot"] = null,
): ItemUnit => ({ id, itemId, upgradeLevel, equippedSlot });

describe("unitsForLegacyCount (older client: 'sell/offer N of this item')", () => {
  it("takes the plainest copies first: unworn, then lowest level, then oldest", () => {
    const units = [
      unit("worn", "boombox", 0, "ground_left"),
      unit("plus3", "boombox", 3),
      unit("plus1-old", "boombox", 1),
      unit("plain-old", "boombox"),
      unit("plain-new", "boombox"),
    ];
    // Input order is oldest-first, so of the two +0 copies the older goes first.
    expect(unitsForLegacyCount(units, "boombox", 3)).toEqual([
      "plain-old",
      "plain-new",
      "plus1-old",
    ]);
  });

  it("only reaches for a worn copy once everything else is spoken for", () => {
    const units = [
      unit("worn", "boombox", 0, "ground_left"),
      unit("spare", "boombox"),
    ];
    expect(unitsForLegacyCount(units, "boombox", 1)).toEqual(["spare"]);
    expect(unitsForLegacyCount(units, "boombox", 2)).toEqual(["spare", "worn"]);
  });

  it("ignores other items", () => {
    const units = [unit("c", "cd"), unit("b", "boombox")];
    expect(unitsForLegacyCount(units, "cd", 1)).toEqual(["c"]);
  });

  it("is null when the player doesn't own that many", () => {
    expect(unitsForLegacyCount([unit("c", "cd")], "cd", 2)).toBeNull();
    expect(unitsForLegacyCount([], "cd", 1)).toBeNull();
  });

  it("never mutates its input", () => {
    const units = [unit("a", "cd", 2), unit("b", "cd", 0)];
    const snapshot = structuredClone(units);
    unitsForLegacyCount(units, "cd", 1);
    expect(units).toEqual(snapshot);
  });
});

describe("unitForLegacyEquip", () => {
  it("prefers the copy already worn, so a repeat reports already-equipped", () => {
    const units = [
      unit("plus3", "boombox", 3),
      unit("worn", "boombox", 0, "ground_left"),
    ];
    expect(unitForLegacyEquip(units, "boombox")?.id).toBe("worn");
  });

  it("otherwise picks the best copy, so an older client keeps the stats it saw", () => {
    const units = [unit("plain", "boombox"), unit("plus3", "boombox", 3)];
    expect(unitForLegacyEquip(units, "boombox")?.id).toBe("plus3");
  });

  it("is undefined for an item the player doesn't own", () => {
    expect(unitForLegacyEquip([unit("c", "cd")], "boombox")).toBeUndefined();
  });
});

describe("unitForLegacyUnequip", () => {
  it("finds the worn copy", () => {
    const units = [
      unit("plain", "boombox"),
      unit("worn", "boombox", 2, "ground_right"),
    ];
    expect(unitForLegacyUnequip(units, "boombox")?.id).toBe("worn");
  });

  it("is undefined when none is worn", () => {
    expect(
      unitForLegacyUnequip([unit("a", "boombox")], "boombox"),
    ).toBeUndefined();
  });
});

describe("unitForLegacyUpgrade", () => {
  it("picks the copy furthest along that can still take a level", () => {
    const units = [
      unit("plain", "boombox"),
      unit("plus2", "boombox", 2),
      unit("plus1", "boombox", 1),
    ];
    expect(unitForLegacyUpgrade(units, "boombox")?.id).toBe("plus2");
  });

  it("skips copies already at the cap", () => {
    const units = [unit("maxed", "boombox", 3), unit("plus1", "boombox", 1)];
    expect(unitForLegacyUpgrade(units, "boombox")?.id).toBe("plus1");
  });

  it("lets the worn copy win a tie", () => {
    const units = [
      unit("a", "boombox", 1),
      unit("b", "boombox", 1, "ground_left"),
    ];
    expect(unitForLegacyUpgrade(units, "boombox")?.id).toBe("b");
  });

  it("is undefined when every copy is maxed, or none is owned", () => {
    expect(
      unitForLegacyUpgrade([unit("m", "boombox", 3)], "boombox"),
    ).toBeUndefined();
    expect(unitForLegacyUpgrade([], "boombox")).toBeUndefined();
  });
});

describe("itemResponse", () => {
  it("returns the units alongside the id-keyed views older clients read", () => {
    const out = itemResponse({
      units: [
        {
          id: "a",
          itemId: "boombox",
          upgradeLevel: 3,
          equippedSlot: "ground_left",
        },
      ],
      inventory: { boombox: 1 },
      equipped: { ground_left: "boombox" },
      itemUpgrades: { boombox: 3 },
      currency: 5,
    });
    expect(out).toEqual({
      units: [unit("a", "boombox", 3, "ground_left")],
      inventory: { boombox: 1 },
      equipped: { ground_left: "boombox" },
      itemUpgrades: { boombox: 3 },
    });
  });
});

describe("trade offer helpers", () => {
  it("counts an offer by item id", () => {
    expect(
      countByItem([{ itemId: "cd" }, { itemId: "cd" }, { itemId: "boombox" }]),
    ).toEqual({ cd: 2, boombox: 1 });
    expect(countByItem([])).toEqual({});
  });

  const offer = (ids: string[], currency = 0) => ({
    units: ids.map((unitId) => ({ unitId, itemId: "cd", upgradeLevel: 0 })),
    items: { cd: ids.length },
    currency,
  });

  it("treats the same copies for the same coins as the same offer, in any order", () => {
    expect(sameOffer(offer(["a", "b"], 5), offer(["b", "a"], 5))).toBe(true);
  });

  it("treats a different copy of the same item as a different offer", () => {
    expect(sameOffer(offer(["a"]), offer(["b"]))).toBe(false);
  });

  it("treats a different amount of coin as a different offer", () => {
    expect(sameOffer(offer(["a"], 1), offer(["a"], 2))).toBe(false);
  });

  it("treats a different number of copies as a different offer", () => {
    expect(sameOffer(offer(["a"]), offer(["a", "b"]))).toBe(false);
    expect(sameOffer(offer(["a", "b"]), offer(["a"]))).toBe(false);
  });

  it("never equals an offer stored before copies existed, or none at all", () => {
    expect(sameOffer(null, offer([]))).toBe(false);
    expect(sameOffer(undefined, offer([]))).toBe(false);
    expect(sameOffer({ items: { cd: 1 }, currency: 0 }, offer(["a"]))).toBe(
      false,
    );
  });
});
