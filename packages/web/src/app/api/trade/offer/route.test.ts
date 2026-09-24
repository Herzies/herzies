import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockAdmin,
  fakeRequest,
  responseJson,
} from "@/__tests__/helpers";

vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
  isAuthError: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/supabase-admin", () => ({
  createAdminClient: vi.fn(),
}));

import { authenticateRequest } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { POST } from "./route";

const mockAuth = vi.mocked(authenticateRequest);
const mockAdmin = vi.mocked(createAdminClient);

// Real-shaped ids: the request schema parses unit ids as GUIDs.
const CD_1 = "11111111-1111-1111-1111-111111111111";
const CD_2 = "11111111-1111-1111-1111-111111111112";
const BOOM_PLAIN = "22222222-2222-2222-2222-222222222221";
const BOOM_PLUS3 = "22222222-2222-2222-2222-222222222223";
const BOOM_WORN = "22222222-2222-2222-2222-222222222229";
const GHOST = "99999999-9999-9999-9999-999999999999";

type UnitRow = {
  id: string;
  item_id: string;
  upgrade_level?: number;
  equipped_slot?: string | null;
};

const row = (
  id: string,
  item_id: string,
  upgrade_level = 0,
  equipped_slot: string | null = null,
): UnitRow => ({ id, item_id, upgrade_level, equipped_slot });

/** A mock admin serving one trade, the caller's coins, and their item units. */
function adminWith(opts: {
  trade: Record<string, unknown> | null;
  currency?: number;
  units?: UnitRow[];
}) {
  const admin = createMockAdmin();
  const originalFrom = admin.from;
  admin.from = vi.fn((table: string) => {
    const respond = (data: unknown) => {
      const chain = originalFrom("__empty__");
      (chain as Record<string, unknown>).then = (
        resolve: (v: unknown) => void,
      ) => resolve({ data, error: null });
      return chain;
    };
    if (table === "trades") return respond(opts.trade);
    if (table === "herzies") return respond({ currency: opts.currency ?? 100 });
    if (table === "item_units") return respond(opts.units ?? []);
    return originalFrom(table);
  }) as typeof admin.from;
  return admin;
}

const activeTrade = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  initiator_id: "user-1",
  target_id: "user-2",
  state: "active",
  ...over,
});

const updateArg = (admin: ReturnType<typeof adminWith>) =>
  admin._updateFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/trade/offer", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { units: [], currency: 0 } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(fakeRequest({ tradeId: "t1" })); // missing offer
    expect(res.status).toBe(400);
  });

  it("returns 400 when an offer names neither units nor items", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { currency: 0 } }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when trade not found", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({ trades: { data: null } }) as never,
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { units: [], currency: 0 } }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when not a participant", async () => {
    mockAuth.mockResolvedValue({ userId: "user-3" });
    mockAdmin.mockReturnValue(adminWith({ trade: activeTrade() }) as never);

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { units: [], currency: 0 } }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when trade is in wrong state", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      adminWith({ trade: activeTrade({ state: "pending" }) }) as never,
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { units: [], currency: 0 } }),
    );
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/pending/);
  });

  it("returns 400 when offering more currency than available", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      adminWith({ trade: activeTrade(), currency: 50 }) as never,
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { units: [], currency: 100 } }),
    );
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/currency/i);
  });

  describe("offering specific copies", () => {
    it("stores the copies with their levels, plus the same offer counted by item", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      const admin = adminWith({
        trade: activeTrade(),
        units: [
          row(BOOM_PLAIN, "boombox"),
          row(BOOM_PLUS3, "boombox", 3),
          row(CD_1, "cd"),
        ],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [BOOM_PLUS3, CD_1], currency: 5 },
        }),
      );
      expect(res.status).toBe(200);

      // The other player must be able to see "+3 Box of Boom" without a live
      // look into this player's inventory, so the level is snapshotted here.
      expect(updateArg(admin)?.initiator_offer).toEqual({
        units: [
          { unitId: BOOM_PLUS3, itemId: "boombox", upgradeLevel: 3 },
          { unitId: CD_1, itemId: "cd", upgradeLevel: 0 },
        ],
        // The same offer counted by id, for clients that predate copies.
        items: { boombox: 1, cd: 1 },
        currency: 5,
      });
    });

    it("refuses a copy the player doesn't own", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockAdmin.mockReturnValue(
        adminWith({
          trade: activeTrade(),
          units: [row(BOOM_PLAIN, "boombox")],
        }) as never,
      );

      const res = await POST(
        fakeRequest({ tradeId: "t1", offer: { units: [GHOST], currency: 0 } }),
      );
      expect(res.status).toBe(400);
      const body = (await responseJson(res)) as { error: string };
      expect(body.error).toMatch(/don't own/);
    });

    // Nothing else stops you giving away the hat you have on.
    it("refuses a copy that is currently worn", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockAdmin.mockReturnValue(
        adminWith({
          trade: activeTrade(),
          units: [row(BOOM_WORN, "boombox", 0, "ground_left")],
        }) as never,
      );

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [BOOM_WORN], currency: 0 },
        }),
      );
      expect(res.status).toBe(400);
      const body = (await responseJson(res)) as { error: string };
      expect(body.error).toMatch(/unequip/i);
    });

    it("counts a copy named twice once", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      const admin = adminWith({
        trade: activeTrade(),
        units: [row(CD_1, "cd")],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [CD_1, CD_1], currency: 0 },
        }),
      );
      expect(res.status).toBe(200);
      expect(
        (updateArg(admin)?.initiator_offer as { units: unknown[] }).units,
      ).toHaveLength(1);
    });
  });

  // Clients that predate copies offer "2 cd"; the route picks the copies.
  describe("an offer from a client that only knows item ids", () => {
    it("resolves to the plainest unworn copies first", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      const admin = adminWith({
        trade: activeTrade(),
        units: [row(BOOM_PLUS3, "boombox", 3), row(BOOM_PLAIN, "boombox")],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { items: { boombox: 1 }, currency: 0 },
        }),
      );
      expect(res.status).toBe(200);
      // The spare goes, not the +3 the player has invested in.
      expect(updateArg(admin)?.initiator_offer).toMatchObject({
        units: [{ unitId: BOOM_PLAIN, itemId: "boombox", upgradeLevel: 0 }],
        items: { boombox: 1 },
      });
    });

    it("returns 400 when offering more than the player owns", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockAdmin.mockReturnValue(
        adminWith({
          trade: activeTrade(),
          units: [row(CD_1, "cd"), row(CD_2, "cd")],
        }) as never,
      );

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { items: { cd: 5 }, currency: 0 },
        }),
      );
      expect(res.status).toBe(400);
      const body = (await responseJson(res)) as { error: string };
      expect(body.error).toMatch(/cd/);
    });

    it("won't satisfy a count by reaching for a worn copy", async () => {
      mockAuth.mockResolvedValue({ userId: "user-1" });
      mockAdmin.mockReturnValue(
        adminWith({
          trade: activeTrade(),
          units: [
            row(BOOM_PLAIN, "boombox"),
            row(BOOM_WORN, "boombox", 0, "ground_left"),
          ],
        }) as never,
      );

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { items: { boombox: 2 }, currency: 0 },
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("locks", () => {
    it("preserves locked state when the offer is unchanged (no-op resend)", async () => {
      mockAuth.mockResolvedValue({ userId: "user-2" });
      const stored = {
        units: [{ unitId: CD_1, itemId: "cd", upgradeLevel: 0 }],
        items: { cd: 1 },
        currency: 10,
      };
      const admin = adminWith({
        trade: activeTrade({
          state: "initiator_locked",
          initiator_offer: { units: [], items: {}, currency: 0 },
          target_offer: stored,
        }),
        units: [row(CD_1, "cd")],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [CD_1], currency: 10 },
        }),
      );
      expect(res.status).toBe(200);

      // The update must NOT touch state/lock flags when the offer didn't
      // change. Otherwise simultaneous locks ping-pong each other: each lock
      // re-sends the offer and resets the other side's lock, so neither side
      // ever reaches both_locked.
      const arg = updateArg(admin);
      expect(arg).toBeDefined();
      expect(arg).not.toHaveProperty("state");
      expect(arg).not.toHaveProperty("initiator_accepted");
      expect(arg).not.toHaveProperty("target_accepted");
    });

    // Copies are compared by id, not by item: swapping your +0 Box of Boom for
    // your +3 one is a different deal and must reset the other side's accept.
    it("treats swapping one copy for another of the same item as a change", async () => {
      mockAuth.mockResolvedValue({ userId: "user-2" });
      const admin = adminWith({
        trade: activeTrade({
          state: "both_locked",
          initiator_offer: { units: [], items: {}, currency: 0 },
          target_offer: {
            units: [{ unitId: BOOM_PLAIN, itemId: "boombox", upgradeLevel: 0 }],
            items: { boombox: 1 },
            currency: 0,
          },
        }),
        units: [row(BOOM_PLAIN, "boombox"), row(BOOM_PLUS3, "boombox", 3)],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [BOOM_PLUS3], currency: 0 },
        }),
      );
      expect(res.status).toBe(200);
      const arg = updateArg(admin);
      expect(arg?.initiator_accepted).toBe(false);
      expect(arg?.target_accepted).toBe(false);
    });

    it("treats an offer stored before copies existed as changed", async () => {
      mockAuth.mockResolvedValue({ userId: "user-2" });
      const admin = adminWith({
        trade: activeTrade({
          state: "target_locked",
          initiator_offer: { items: {}, currency: 0 },
          // The old shape: counts only, no `units`.
          target_offer: { items: { cd: 1 }, currency: 0 },
        }),
        units: [row(CD_1, "cd")],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [CD_1], currency: 0 },
        }),
      );
      expect(res.status).toBe(200);
      expect(updateArg(admin)?.state).toBe("active");
    });

    it("releases only the changer's lock when the offer changes (both_locked)", async () => {
      mockAuth.mockResolvedValue({ userId: "user-2" });
      const admin = adminWith({
        trade: activeTrade({
          state: "both_locked",
          initiator_offer: { units: [], items: {}, currency: 0 },
          target_offer: {
            units: [{ unitId: CD_1, itemId: "cd", upgradeLevel: 0 }],
            items: { cd: 1 },
            currency: 0,
          },
        }),
        units: [row(CD_1, "cd"), row(CD_2, "cd")],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [CD_1, CD_2], currency: 0 },
        }),
      );
      expect(res.status).toBe(200);

      const arg = updateArg(admin) as Record<string, unknown>;
      // The target changed their offer, so only the target's lock is released;
      // the initiator stays locked on their own (unchanged) offer.
      expect(arg.state).toBe("initiator_locked");
      expect(arg.initiator_accepted).toBe(false);
      expect(arg.target_accepted).toBe(false);
      expect(arg.expires_at).toBeDefined();
    });

    it("preserves the partner's lock when the other side first sends an offer", async () => {
      mockAuth.mockResolvedValue({ userId: "user-2" });
      const admin = adminWith({
        trade: activeTrade({
          state: "initiator_locked",
          initiator_offer: { units: [], items: {}, currency: 0 },
          // Target has never sent an offer yet (null) — their first send
          // counts as a change but must NOT unlock the initiator.
          target_offer: null,
        }),
        units: [row(CD_1, "cd")],
      });
      mockAdmin.mockReturnValue(admin as never);

      const res = await POST(
        fakeRequest({
          tradeId: "t1",
          offer: { units: [CD_1], currency: 0 },
        }),
      );
      expect(res.status).toBe(200);

      const arg = updateArg(admin) as Record<string, unknown>;
      // Target isn't locked, so no lock state changes — initiator_locked stands.
      expect(arg).not.toHaveProperty("state");
      expect(arg.initiator_accepted).toBe(false);
      expect(arg.target_accepted).toBe(false);
    });
  });
});
