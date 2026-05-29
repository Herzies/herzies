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

describe("POST /api/friends/add (send friend request)", () => {
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
        herzies: { data: { friend_code: "HERZ-REAL", friend_codes: [] } },
      }) as never,
    );

    const res = await POST(
      fakeRequest({ myCode: "HERZ-FAKE", theirCode: "HERZ-THEM" }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when already friends", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        herzies: {
          data: { friend_code: "HERZ-ME", friend_codes: ["HERZ-THEM"] },
        },
      }) as never,
    );

    const res = await POST(
      fakeRequest({ myCode: "HERZ-ME", theirCode: "HERZ-THEM" }),
    );
    expect(res.status).toBe(409);
  });

  it("creates a pending request without making them friends yet", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    const admin = createMockAdmin({
      herzies: {
        data: { friend_code: "HERZ-ME", friend_codes: [], user_id: "user-2" },
      },
      friend_requests: { data: null, error: null },
    });
    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(
      fakeRequest({ myCode: "HERZ-ME", theirCode: "HERZ-THEM" }),
    );
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(admin._insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        from_user_id: "user-1",
        to_user_id: "user-2",
        status: "pending",
      }),
    );
    // Friendship is not created on send.
    expect(admin.rpc).not.toHaveBeenCalledWith(
      "add_friend",
      expect.anything(),
    );
  });
});
