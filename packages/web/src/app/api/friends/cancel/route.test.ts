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

describe("POST /api/friends/cancel", () => {
  it("returns 404 when the caller did not send the request", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(
      createMockAdmin({
        friend_requests: {
          data: { id: "req-1", from_user_id: "other", status: "pending" },
        },
      }) as never,
    );
    const res = await POST(fakeRequest({ requestId: "req-1" }));
    expect(res.status).toBe(404);
  });

  it("cancels a pending outgoing request", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    const admin = createMockAdmin({
      friend_requests: {
        data: { id: "req-1", from_user_id: "user-1", status: "pending" },
      },
    });
    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest({ requestId: "req-1" }));
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(admin._updateFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });
});
