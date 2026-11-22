import type { Trade, TradeUpdate } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { mergeTrade } from "./tradeLive";

const offer = { items: {}, currency: 0 };

function update(over: Partial<TradeUpdate> = {}): TradeUpdate {
  return {
    id: "t1",
    initiatorId: "a",
    targetId: "b",
    initiatorOffer: offer,
    targetOffer: offer,
    state: "active",
    initiatorAccepted: false,
    targetAccepted: false,
    createdAt: "2026-11-22T10:00:00+00:00",
    expiresAt: "2026-11-22T10:05:00+00:00",
    version: 3,
    ...over,
  };
}

const held: Trade = {
  ...update(),
  initiatorName: "Ada",
  targetName: "Bo",
};

describe("mergeTrade", () => {
  it("shows nothing until a poll brings the names", () => {
    expect(mergeTrade(null, update())).toBeNull();
    expect(
      mergeTrade(null, update({ initiatorName: "Ada", targetName: "Bo" })),
    ).toEqual(held);
  });

  it("keeps the names when later updates come without them", () => {
    const next = mergeTrade(
      held,
      update({ state: "target_locked", version: 4 }),
    );
    expect(next).toMatchObject({
      state: "target_locked",
      initiatorName: "Ada",
      targetName: "Bo",
    });
  });

  it("never lets an older picture replace a newer one", () => {
    // A poll answered before the lock, arriving after the lock's broadcast.
    const locked = mergeTrade(
      held,
      update({ state: "both_locked", version: 5 }),
    );
    expect(mergeTrade(locked, update({ state: "active", version: 4 }))).toBe(
      locked,
    );
  });

  it("keeps a finished trade finished", () => {
    const done = mergeTrade(held, update({ state: "completed", version: 6 }));
    expect(
      mergeTrade(done, update({ state: "both_locked", version: 6 }))?.state,
    ).toBe("completed");
  });

  it("returns the same trade for a repeat, so nothing re-renders", () => {
    expect(mergeTrade(held, update())).toBe(held);
  });

  it("applies updates from servers that don't send a version yet", () => {
    const old = { ...held, version: undefined };
    expect(
      mergeTrade(old, update({ state: "initiator_locked", version: undefined }))
        ?.state,
    ).toBe("initiator_locked");
  });
});
