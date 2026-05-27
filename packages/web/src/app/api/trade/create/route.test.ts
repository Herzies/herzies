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

describe("POST /api/trade/create", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(fakeRequest({ targetFriendCode: "HERZ-1234" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing targetFriendCode", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(fakeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 409 when initiator already has an active trade", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        trades: { data: { id: "existing-trade" } },
      }) as never,
    );

    const res = await POST(fakeRequest({ targetFriendCode: "HERZ-1234" }));
    expect(res.status).toBe(409);
  });

  it("returns 404 when target friend code not found", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    let tradeCallCount = 0;
    const admin = createMockAdmin();
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "trades") {
        tradeCallCount++;
        // First two calls: check existing trades (return null = no active trade)
        return originalFrom("__empty__");
      }
      if (table === "herzies") {
        // Target lookup returns null
        return originalFrom("__empty__");
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest({ targetFriendCode: "HERZ-NOPE" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when trading with yourself", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    const admin = createMockAdmin();
    let tradeCallCount = 0;
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "trades") {
        tradeCallCount++;
        return originalFrom("__empty__");
      }
      if (table === "herzies") {
        // Return the same user as target
        const chain = originalFrom("__empty__");
        (chain as Record<string, unknown>).then = (
          resolve: (v: unknown) => void,
        ) =>
          resolve({
            data: { user_id: "user-1", name: "Me", friend_code: "HERZ-1234" },
            error: null,
          });
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest({ targetFriendCode: "HERZ-1234" }));
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/yourself/i);
  });
});
