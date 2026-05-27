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

describe("POST /api/friends/add", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(
      fakeRequest({ myCode: "HERZ-ME", theirCode: "HERZ-THEM" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when adding yourself", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(
      fakeRequest({ myCode: "HERZ-SAME", theirCode: "HERZ-SAME" }),
    );
    expect(res.status).toBe(400);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/yourself/i);
  });

  it("returns 403 when myCode does not match caller's herzie", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        herzies: { data: { friend_code: "HERZ-REAL" } },
      }) as never,
    );

    const res = await POST(
      fakeRequest({ myCode: "HERZ-FAKE", theirCode: "HERZ-THEM" }),
    );
    expect(res.status).toBe(403);
  });

  it("calls add_friend RPC and returns success", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    let herzieCallCount = 0;
    const admin = createMockAdmin(
      {},
      { add_friend: { data: null, error: null } },
    );
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "herzies") {
        herzieCallCount++;
        const chain = originalFrom("__empty__");
        if (herzieCallCount === 1) {
          // Ownership check
          (chain as Record<string, unknown>).then = (
            resolve: (v: unknown) => void,
          ) => resolve({ data: { friend_code: "HERZ-ME" }, error: null });
        } else {
          // Fetch own friend_codes for update
          (chain as Record<string, unknown>).then = (
            resolve: (v: unknown) => void,
          ) => resolve({ data: { friend_codes: [] }, error: null });
        }
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(
      fakeRequest({ myCode: "HERZ-ME", theirCode: "HERZ-THEM" }),
    );
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify RPC was called
    expect(admin.rpc).toHaveBeenCalledWith("add_friend", {
      my_friend_code: "HERZ-ME",
      their_friend_code: "HERZ-THEM",
    });
  });
});
