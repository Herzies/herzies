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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/friends/accept", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await POST(fakeRequest({ requestId: "req-1" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the request is not addressed to the caller", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        friend_requests: {
          data: {
            id: "req-1",
            from_user_id: "user-2",
            to_user_id: "someone-else",
            status: "pending",
          },
        },
      }) as never,
    );
    const res = await POST(fakeRequest({ requestId: "req-1" }));
    expect(res.status).toBe(404);
  });

  it("accepts a pending request and creates the friendship", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    const admin = createMockAdmin(
      {
        friend_requests: {
          data: {
            id: "req-1",
            from_user_id: "user-2",
            to_user_id: "user-1",
            status: "pending",
          },
        },
        herzies: { data: { friend_code: "HERZ-ME", friend_codes: [] } },
      },
      { add_friend: { data: null, error: null } },
    );
    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest({ requestId: "req-1" }));
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(admin.rpc).toHaveBeenCalledWith(
      "add_friend",
      expect.objectContaining({ my_friend_code: "HERZ-ME" }),
    );
    expect(admin._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted" }),
    );
  });
});
