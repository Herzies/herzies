import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAdmin, responseJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
  isAuthError: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/supabase-admin", () => ({
  createAdminClient: vi.fn(),
}));

import { authenticateRequest } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { GET } from "./route";

const mockAuth = vi.mocked(authenticateRequest);
const mockAdmin = vi.mocked(createAdminClient);

const HOUR = 3_600_000;

function adminWithTrade(state: string, expiresAt: string) {
  const admin = createMockAdmin();
  const originalFrom = admin.from;
  admin.from = vi.fn((table: string) => {
    const chain = originalFrom("__e__") as Record<string, unknown>;
    chain.then = (resolve: (v: unknown) => void) =>
      resolve({
        data:
          table === "trades"
            ? {
                id: "trade-1",
                initiator_id: "user-me",
                target_id: "user-them",
                initiator_offer: {},
                target_offer: {},
                state,
                initiator_accepted: false,
                target_accepted: false,
                created_at: "2026-09-14T00:00:00Z",
                expires_at: expiresAt,
              }
            : { name: "Someone", friend_code: "HERZ-X" },
        error: null,
      });
    return chain;
  }) as typeof admin.from;
  return admin;
}

function getRequest(): Request {
  return new Request("http://localhost/api/trade/status?tradeId=trade-1", {
    headers: { Authorization: "Bearer valid-token" },
  });
}

async function stateFor(admin: ReturnType<typeof adminWithTrade>) {
  mockAdmin.mockReturnValue(admin as never);
  const res = await GET(getRequest());
  const body = (await responseJson(res)) as { trade: { state: string } };
  return body.trade.state;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user-me" });
});

describe("GET /api/trade/status", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it("reports a live trade's real state", async () => {
    const future = new Date(Date.now() + HOUR).toISOString();
    expect(await stateFor(adminWithTrade("both_locked", future))).toBe(
      "both_locked",
    );
  });

  it("reports an expired trade as cancelled without the sweep having run", async () => {
    // The row in the database still says "pending" — expire_stale_trades()
    // no longer runs on this read path, so expiry has to be derived.
    const past = new Date(Date.now() - HOUR).toISOString();
    expect(await stateFor(adminWithTrade("pending", past))).toBe("cancelled");
  });

  it("does not rewrite a completed trade that is past its expiry", async () => {
    // Terminal states win: a trade that completed before its window ran out
    // must not be relabelled as cancelled once the clock passes expires_at.
    const past = new Date(Date.now() - HOUR).toISOString();
    expect(await stateFor(adminWithTrade("completed", past))).toBe("completed");
  });

  it("never calls expire_stale_trades", async () => {
    // The whole point of the change: this route is polled ~92 times a minute
    // per open trade and must not issue a write on each one.
    const admin = adminWithTrade(
      "pending",
      new Date(Date.now() + HOUR).toISOString(),
    );
    mockAdmin.mockReturnValue(admin as never);

    await GET(getRequest());

    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
