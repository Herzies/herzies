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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/trade/offer", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: {}, currency: 0 } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(fakeRequest({ tradeId: "t1" })); // missing offer
    expect(res.status).toBe(400);
  });

  it("returns 404 when trade not found", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: { data: null },
      }) as never,
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: {}, currency: 0 } }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when not a participant", async () => {
    mockAuth.mockResolvedValue({ userId: "user-3" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: {
          data: {
            id: "t1",
            initiator_id: "user-1",
            target_id: "user-2",
            state: "active",
          },
        },
      }) as never,
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: {}, currency: 0 } }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when trade is in wrong state", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: {
          data: {
            id: "t1",
            initiator_id: "user-1",
            target_id: "user-2",
            state: "pending",
          },
        },
      }) as never,
    );

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: {}, currency: 0 } }),
    );
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/pending/);
  });

  it("returns 400 when offering more currency than available", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    const admin = createMockAdmin();
    const callIndex = 0;
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "trades") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: {
              id: "t1",
              initiator_id: "user-1",
              target_id: "user-2",
              state: "active",
            },
            error: null,
          });
        return chain;
      }
      if (table === "herzies") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) => resolve({ data: { inventory_v2: {}, currency: 50 }, error: null });
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: {}, currency: 100 } }),
    );
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/currency/i);
  });

  it("preserves locked state when offer is unchanged (no-op resend)", async () => {
    mockAuth.mockResolvedValue({ userId: "user-2" });

    const sameOffer = { items: { cd: 1 }, currency: 10 };
    const admin = createMockAdmin();
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "trades") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: {
              id: "t1",
              initiator_id: "user-1",
              target_id: "user-2",
              state: "initiator_locked",
              initiator_offer: { items: {}, currency: 0 },
              target_offer: sameOffer,
            },
            error: null,
          });
        return chain;
      }
      if (table === "herzies") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: { inventory_v2: { cd: 5 }, currency: 100 },
            error: null,
          });
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest({ tradeId: "t1", offer: sameOffer }));
    expect(res.status).toBe(200);

    // The update must NOT touch state/lock flags when the offer didn't change.
    // Otherwise simultaneous locks ping-pong each other: each lock re-sends the offer
    // and resets the other side's lock, so neither side ever reaches both_locked.
    const updateArg = admin._updateFn.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateArg).toBeDefined();
    expect(updateArg).not.toHaveProperty("state");
    expect(updateArg).not.toHaveProperty("initiator_accepted");
    expect(updateArg).not.toHaveProperty("target_accepted");
  });

  it("resets locks when offer actually changes", async () => {
    mockAuth.mockResolvedValue({ userId: "user-2" });

    const admin = createMockAdmin();
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "trades") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: {
              id: "t1",
              initiator_id: "user-1",
              target_id: "user-2",
              state: "both_locked",
              initiator_offer: { items: {}, currency: 0 },
              target_offer: { items: { cd: 1 }, currency: 0 },
            },
            error: null,
          });
        return chain;
      }
      if (table === "herzies") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: { inventory_v2: { cd: 5 }, currency: 100 },
            error: null,
          });
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: { cd: 2 }, currency: 0 } }),
    );
    expect(res.status).toBe(200);

    const updateArg = admin._updateFn.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updateArg.state).toBe("active");
    expect(updateArg.initiator_accepted).toBe(false);
    expect(updateArg.target_accepted).toBe(false);
  });

  it("returns 400 when offering items not in inventory", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    const admin = createMockAdmin();
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "trades") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: {
              id: "t1",
              initiator_id: "user-1",
              target_id: "user-2",
              state: "active",
            },
            error: null,
          });
        return chain;
      }
      if (table === "herzies") {
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: { inventory_v2: { cd: 2 }, currency: 100 },
            error: null,
          });
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(
      fakeRequest({ tradeId: "t1", offer: { items: { cd: 5 }, currency: 0 } }),
    );
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/cd/);
  });
});
