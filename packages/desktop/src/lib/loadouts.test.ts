import type { ItemUnit, LoadoutPiece, LoadoutState } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import {
  loadoutRefusalText,
  predictLoadoutSwitch,
  switchReportLine,
} from "./loadouts";

const unit = (
  id: string,
  itemId: string,
  equippedSlot: ItemUnit["equippedSlot"] = null,
  heldBy?: ItemUnit["heldBy"],
): ItemUnit =>
  heldBy === undefined
    ? { id, itemId, upgradeLevel: 0, equippedSlot }
    : { id, itemId, upgradeLevel: 0, equippedSlot, heldBy };

const worn = (units: ItemUnit[]) =>
  Object.fromEntries(
    units.filter((u) => u.equippedSlot).map((u) => [u.id, u.equippedSlot]),
  );

const held = (units: ItemUnit[]) =>
  Object.fromEntries(
    units.filter((u) => u.heldBy !== undefined).map((u) => [u.id, u.heldBy]),
  );

const on1 = (inactive: LoadoutPiece[] | null): LoadoutState => ({
  active: 1,
  inactive,
});

describe("predictLoadoutSwitch", () => {
  it("leaves the herzie bare on the first switch, holding what was worn", () => {
    const units = [unit("a", "headphones", "head"), unit("b", "sixpence")];
    const out = predictLoadoutSwitch(units, on1(null), 3, null);
    expect(worn(out.units)).toEqual({});
    expect(held(out.units)).toEqual({ a: 1 });
  });

  it("puts the other loadout's pieces on and holds the ones taken off", () => {
    const units = [
      unit("a", "headphones", "head"),
      unit("b", "sixpence", null, 2),
      unit("c", "boombox", null, 2),
    ];
    const out = predictLoadoutSwitch(
      units,
      on1([
        { slot: "head", unitId: "b", itemId: "sixpence" },
        { slot: "ground_right", unitId: "c", itemId: "boombox" },
      ]),
      3,
      null,
    );
    expect(worn(out.units)).toEqual({ b: "head", c: "ground_right" });
    expect(held(out.units)).toEqual({ a: 1 });
    expect(out.missing).toEqual([]);
    expect(out.refused).toEqual([]);
    expect(out.bagFull).toBe(false);
  });

  it("keeps a copy both loadouts hold worn and held", () => {
    const out = predictLoadoutSwitch(
      [unit("a", "headphones", "head", 2)],
      on1([{ slot: "head", unitId: "a", itemId: "headphones" }]),
      3,
      null,
    );
    expect(worn(out.units)).toEqual({ a: "head" });
    expect(held(out.units)).toEqual({ a: 1 });
  });

  it("never wears a bag copy in place of a gone one", () => {
    const out = predictLoadoutSwitch(
      [unit("a2", "sixpence")],
      on1([{ slot: "head", unitId: "a1", itemId: "sixpence" }]),
      3,
      null,
    );
    expect(out.missing).toEqual(["sixpence"]);
    expect(worn(out.units)).toEqual({});
  });

  it("sends a piece the herzie is too young for to the bag", () => {
    const out = predictLoadoutSwitch(
      [unit("g", "gold-chain", null, 2)],
      on1([{ slot: "body", unitId: "g", itemId: "gold-chain" }]),
      1,
      null,
    );
    expect(out.refused).toEqual(["gold-chain"]);
    expect(out.units).toEqual([unit("g", "gold-chain")]);
    expect(out.bagFull).toBe(false);
  });

  it("is refused when the bag can't take the refused pieces", () => {
    const out = predictLoadoutSwitch(
      [unit("g", "gold-chain", null, 2), unit("x", "sixpence")],
      on1([{ slot: "body", unitId: "g", itemId: "gold-chain" }]),
      1,
      null,
      1,
    );
    expect(out.bagFull).toBe(true);
  });
});

describe("loadoutRefusalText", () => {
  it("says a full bag in the server's words", () => {
    expect(loadoutRefusalText("bag-full")).toBe(
      "Your bag is full: make room first.",
    );
  });
});

describe("switchReportLine", () => {
  it("says nothing when it all went on", () => {
    expect(switchReportLine({ missing: [], refused: [] })).toBeNull();
  });

  it("names what was left off and why", () => {
    expect(
      switchReportLine({ missing: ["sixpence"], refused: ["gold-chain"] }),
    ).toBe(
      'Left off: "Vagrant Cap" no longer owned; "Ludvig\'s Lariat" can\'t be worn',
    );
  });
});
