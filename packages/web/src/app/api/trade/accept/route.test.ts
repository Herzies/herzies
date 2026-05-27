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

describe("POST /api/trade/accept", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(fakeRequest({ tradeId: "trade-1" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when trade not found", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: { data: null },
      }) as never,
    );

    const res = await POST(fakeRequest({ tradeId: "nonexistent" }));
    expect(res.status).toBe(404);
  });

  it("returns 403 when user is not a participant", async () => {
    mockAuth.mockResolvedValue({ userId: "user-3" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: {
          data: {
            id: "trade-1",
            initiator_id: "user-1",
            target_id: "user-2",
            state: "both_locked",
          },
        },
      }) as never,
    );

    const res = await POST(fakeRequest({ tradeId: "trade-1" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 when trade is not both_locked", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: {
          data: {
            id: "trade-1",
            initiator_id: "user-1",
            target_id: "user-2",
            state: "active",
          },
        },
      }) as never,
    );

    const res = await POST(fakeRequest({ tradeId: "trade-1" }));
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/locked/i);
  });

  it("returns completed: false when only one side accepted", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: {
          data: {
            id: "trade-1",
            initiator_id: "user-1",
            target_id: "user-2",
            state: "both_locked",
            initiator_accepted: false,
            target_accepted: false,
          },
        },
      }) as never,
    );

    const res = await POST(fakeRequest({ tradeId: "trade-1" }));
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as {
      ok: boolean;
      completed: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.completed).toBe(false);
  });

  it("executes trade and returns completed: true when both accepted", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin(
        {
          trades: {
            data: {
              id: "trade-1",
              initiator_id: "user-1",
              target_id: "user-2",
              state: "both_locked",
              initiator_accepted: false,
              target_accepted: true, // other side already accepted
            },
          },
        },
        { execute_trade: { data: true } },
      ) as never,
    );

    const res = await POST(fakeRequest({ tradeId: "trade-1" }));
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as {
      ok: boolean;
      completed: boolean;
    };
    expect(body.completed).toBe(true);
  });

  it("returns 409 when execute_trade RPC fails", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin(
        {
          trades: {
            data: {
              id: "trade-1",
              initiator_id: "user-1",
              target_id: "user-2",
              state: "both_locked",
              initiator_accepted: false,
              target_accepted: true,
            },
          },
        },
        { execute_trade: { data: false } },
      ) as never,
    );

    const res = await POST(fakeRequest({ tradeId: "trade-1" }));
    expect(res.status).toBe(409);
  });
});
