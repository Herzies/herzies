/**
 * Integration tests for the events table — verifies the public RLS lockdown
 * (00016_events_rls_lockdown.sql) prevents anon clients from reading sensitive
 * config fields like trackTitle / trackArtist while the API still works.
 *
 * Requires: `npx supabase start`
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getActiveEvents } from "@/app/api/events/active/route";
import {
  cleanupTestData,
  createTestUser,
  getAdminClient,
  getAnonClient,
  setLocalEnv,
} from "./integration-helpers";

let user: { userId: string; accessToken: string };
let eventId: string;

beforeAll(async () => {
  setLocalEnv();
  user = await createTestUser();

  const admin = getAdminClient();
  const { data } = await admin
    .from("events")
    .insert({
      type: "song_hunt",
      title: "Leak Test Hunt",
      description: "Find it",
      active: true,
      starts_at: new Date(Date.now() - 86400_000).toISOString(),
      ends_at: new Date(Date.now() + 86400_000).toISOString(),
      config: {
        trackTitle: "Yess!",
        trackArtist: "Folk & Røvere",
        rewardItemId: "cd",
        maxClaims: 5,
        hints: [
          {
            text: "first hint",
            unlocksAt: new Date(Date.now() - 3600_000).toISOString(),
          },
          {
            text: "future hint",
            unlocksAt: new Date(Date.now() + 86400_000).toISOString(),
          },
        ],
      },
    })
    .select("id")
    .single();

  if (!data) throw new Error("Failed to insert event");
  eventId = data.id as string;
}, 15000);

afterAll(async () => {
  const admin = getAdminClient();
  await admin.from("events").delete().eq("id", eventId);
  await cleanupTestData();
}, 10000);

describe("events table RLS", () => {
  it("anon client cannot read events directly (PostgREST returns empty)", async () => {
    const anon = getAnonClient();
    const { data, error } = await anon
      .from("events")
      .select("*")
      .eq("id", eventId);

    // Either the request errors (permission denied) or RLS hides the row entirely.
    // Both are acceptable — what matters is that no row is visible.
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data).toEqual([]);
    }
  });

  it("authenticated client cannot read events directly either", async () => {
    const anon = getAnonClient();
    await anon.auth.setSession({
      access_token: user.accessToken,
      refresh_token: "",
    });

    const { data, error } = await anon
      .from("events")
      .select("*")
      .eq("id", eventId);
    if (error) {
      expect(error).not.toBeNull();
    } else {
      expect(data).toEqual([]);
    }

    await anon.auth.signOut();
  });

  it("/api/events/active still returns the event with redacted config", async () => {
    const res = await getActiveEvents();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      events: Array<{ id: string; config: Record<string, unknown> }>;
    };
    const found = body.events.find((e) => e.id === eventId);
    expect(found).toBeDefined();

    // Sanity check: the API filters trackTitle / trackArtist out.
    expect(found!.config.trackTitle).toBeUndefined();
    expect(found!.config.trackArtist).toBeUndefined();
    // Non-sensitive fields are still present.
    expect(found!.config.rewardItemId).toBe("cd");
    expect(found!.config.maxClaims).toBe(5);
  });
});
