import type { ItemUnit } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { collectLabel, listableCopies } from "./market";

const unit = (
  id: string,
  itemId: string,
  upgradeLevel = 0,
  equippedSlot: ItemUnit["equippedSlot"] = null,
): ItemUnit => ({ id, itemId, upgradeLevel, equippedSlot });

describe("listableCopies", () => {
  it("leaves out worn copies, class gear and unknown items", () => {
    const units = [
      unit("a", "headphones"),
      unit("b", "headphones", 0, "head"),
      unit("c", "lute"),
      unit("d", "no-such-item"),
    ];
    expect(listableCopies(units)).toEqual([
      { itemId: "headphones", upgradeLevel: 0, unitIds: ["a"] },
    ]);
  });

  it("shares a row between alike copies, by name, most upgraded first", () => {
    const units = [
      unit("p0", "pearl-necklace", 0),
      unit("h1", "headphones", 1),
      unit("p2", "pearl-necklace", 2),
      unit("h0", "headphones", 0),
      unit("h0b", "headphones", 0),
    ];
    expect(
      listableCopies(units).map((r) => [r.itemId, r.upgradeLevel, r.unitIds]),
    ).toEqual([
      // "Hardened Tears of Joy" before "Intimite Music Device".
      ["pearl-necklace", 2, ["p2"]],
      ["pearl-necklace", 0, ["p0"]],
      ["headphones", 1, ["h1"]],
      ["headphones", 0, ["h0", "h0b"]],
    ]);
  });
});

describe("collectLabel", () => {
  it("names what's waiting", () => {
    expect(collectLabel(120, 0)).toBe("Collect 120 coins");
    expect(collectLabel(0, 1)).toBe("Collect 1 item");
    expect(collectLabel(1, 2)).toBe("Collect 1 coin / 2 items");
  });

  it("is null with nothing waiting", () => {
    expect(collectLabel(0, 0)).toBeNull();
  });
});
