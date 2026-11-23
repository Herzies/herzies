import type { ItemUnit } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { compareWithWorn } from "./compare";

const unit = (
  id: string,
  itemId: string,
  equippedSlot: ItemUnit["equippedSlot"] = null,
  upgradeLevel = 0,
): ItemUnit => ({ id, itemId, upgradeLevel, equippedSlot });

describe("compareWithWorn", () => {
  it("weighs a bag copy against the one worn in its slot", () => {
    const units = [unit("a", "bowtie", "body"), unit("b", "bowtie", null, 3)];
    const c = compareWithWorn("b", units);
    expect(c?.slot).toBe("body");
    expect(c?.worn?.id).toBe("a");
    // The same card, three dice levels up: +3 luck.
    expect(c?.changes).toEqual(["luck"]);
    expect((c?.then.luck ?? 0) - (c?.now.luck ?? 0)).toBe(3);
  });

  it("counts everything it adds when the slot is empty", () => {
    const c = compareWithWorn("f", [unit("f", "fangs")]);
    expect(c?.worn).toBeNull();
    expect((c?.then.luck ?? 0) - (c?.now.luck ?? 0)).toBe(5);
  });

  it("has nothing to compare for an id it doesn't know", () => {
    expect(compareWithWorn("nope", [unit("a", "bowtie")])).toBeNull();
  });
});
