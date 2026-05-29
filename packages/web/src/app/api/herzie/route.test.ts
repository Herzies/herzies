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

const validBody = {
  name: "TestHerzie",
  appearance: {
    headIndex: 0,
    eyesIndex: 0,
    mouthIndex: 0,
    accessoryIndex: 0,
    limbsIndex: 0,
    bodyIndex: 0,
    legsIndex: 0,
    colorScheme: "pink",
  },
  friendCode: "HERZ-TEST",
};

describe("POST /api/herzie", () => {
  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST(fakeRequest(validBody));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body (missing name)", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(
      fakeRequest({ appearance: {}, friendCode: "HERZ-1" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid name characters", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockAdmin.mockReturnValue(createMockAdmin() as never);

    const res = await POST(fakeRequest({ ...validBody, name: "test@bad!" }));
    expect(res.status).toBe(400);
  });

  it("returns existing herzie if already registered (idempotent)", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    const existingHerzie = {
      id: "h-1",
      user_id: "user-1",
      name: "Existing",
      friend_code: "HERZ-1",
      appearance: {},
      xp: 100,
      level: 2,
      stage: 1,
      total_minutes_listened: 50,
      genre_minutes: {},
      friend_codes: [],
      last_craving_date: "",
      last_craving_genre: "",
      streak_days: 0,
      streak_last_date: null,
      currency: 10,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };

    let herzieCallCount = 0;
    const admin = createMockAdmin();
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "herzies") {
        herzieCallCount++;
        const chain = originalFrom("__empty__");
        if (herzieCallCount === 1) {
          // First call: check if user already has a herzie
          (chain as Record<string, unknown>).then = (
            resolve: (v: unknown) => void,
          ) => resolve({ data: { id: "h-1" }, error: null });
        } else {
          // Second call: fetch full herzie
          (chain as Record<string, unknown>).then = (
            resolve: (v: unknown) => void,
          ) => resolve({ data: existingHerzie, error: null });
        }
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest(validBody));
    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as { herzie: { name: string } };
    expect(body.herzie.name).toBe("Existing");
  });

  it("returns 409 when name is already taken", async () => {
    mockAuth.mockResolvedValue({ userId: "user-1" });

    let herzieCallCount = 0;
    const admin = createMockAdmin();
    const originalFrom = admin.from;
    admin.from = vi.fn((table: string) => {
      if (table === "herzies") {
        herzieCallCount++;
        const chain = originalFrom("__empty__");
        if (herzieCallCount === 1) {
          // No existing herzie for this user
          (chain as Record<string, unknown>).then = (
            resolve: (v: unknown) => void,
          ) => resolve({ data: null, error: null });
        } else if (herzieCallCount === 2) {
          // Name check: found a match
          (chain as Record<string, unknown>).then = (
            resolve: (v: unknown) => void,
          ) => resolve({ data: { id: "other-herzie" }, error: null });
        }
        return chain;
      }
      return originalFrom(table);
    }) as typeof admin.from;

    mockAdmin.mockReturnValue(admin as never);

    const res = await POST(fakeRequest(validBody));
    expect(res.status).toBe(409);
    const body = (await responseJson(res)) as { error: string };
    expect(body.error).toMatch(/name/i);
  });
});
