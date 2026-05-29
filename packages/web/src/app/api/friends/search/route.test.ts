import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAdmin, responseJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
  isAuthError: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/supabase-admin", () => ({
  createAdminClient: vi.fn(),
}));

import type { FriendSearchResult } from "@herzies/shared";
import { authenticateRequest } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { GET } from "./route";

const mockAuth = vi.mocked(authenticateRequest);
const mockAdmin = vi.mocked(createAdminClient);

function getRequest(q: string): Request {
  return new Request(
    `http://localhost/api/friends/search?q=${encodeURIComponent(q)}`,
    { headers: { Authorization: "Bearer valid-token" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/friends/search", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );
    const res = await GET(getRequest("bob"));
    expect(res.status).toBe(401);
  });

  it("returns an empty list for a blank query", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);
    const res = await GET(getRequest("   "));
    const body = (await responseJson(res)) as { results: FriendSearchResult[] };
    expect(body.results).toEqual([]);
  });

  it("annotates matches with the caller's relationship", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    const admin = createMockAdmin();
    const originalFrom = admin.from;
    let herzieCalls = 0;
    admin.from = vi.fn((table: string) => {
      if (table === "herzies") {
        herzieCalls++;
        const chain = originalFrom("__e__") as Record<string, unknown>;
        if (herzieCalls === 1) {
          chain.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: {
                user_id: "user-1",
                friend_code: "HERZ-ME",
                friend_codes: ["HERZ-FRIEND"],
              },
              error: null,
            });
        } else {
          chain.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                {
                  user_id: "user-2",
                  name: "Bob",
                  friend_code: "HERZ-BOB",
                  level: 3,
                },
                {
                  user_id: "user-3",
                  name: "Friendly",
                  friend_code: "HERZ-FRIEND",
                  level: 5,
                },
              ],
              error: null,
            });
        }
        return chain;
      }
      if (table === "friend_requests") {
        const chain = originalFrom("__e__") as Record<string, unknown>;
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({
            data: [{ from_user_id: "user-1", to_user_id: "user-2" }],
            error: null,
          });
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;
    mockAdmin.mockReturnValue(admin as never);

    const res = await GET(getRequest("Friend"));
    const body = (await responseJson(res)) as { results: FriendSearchResult[] };

    const bob = body.results.find((r) => r.friendCode === "HERZ-BOB");
    const friend = body.results.find((r) => r.friendCode === "HERZ-FRIEND");
    expect(bob?.relationship).toBe("pending_sent");
    expect(friend?.relationship).toBe("friends");
  });
});
