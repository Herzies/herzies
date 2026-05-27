/**
 * Integration test helpers — uses a real local Supabase instance.
 * Requires `npx supabase start` to be running.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Local Supabase credentials (from `npx supabase status`)
const SUPABASE_URL = "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Service-role client (bypasses RLS) for test setup/teardown */
export function getAdminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Anon client for user-scoped operations */
export function getAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

let userCounter = 0;

/** Create a test user in Supabase Auth and return their ID + access token */
export async function createTestUser(): Promise<{
  userId: string;
  accessToken: string;
}> {
  userCounter++;
  const email = `test-${Date.now()}-${userCounter}@herzies.test`;
  const password = "test-password-123";

  const admin = getAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`Failed to create test user: ${error?.message}`);
  }

  // Sign in to get an access token
  const anon = getAnonClient();
  const { data: session, error: signInError } =
    await anon.auth.signInWithPassword({
      email,
      password,
    });

  if (signInError || !session.session) {
    throw new Error(`Failed to sign in test user: ${signInError?.message}`);
  }

  return {
    userId: data.user.id,
    accessToken: session.session.access_token,
  };
}

/** Create a herzie row for a test user */
export async function createTestHerzie(
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const admin = getAdminClient();
  const defaults = {
    user_id: userId,
    name: `TestHerzie-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    friend_code: `HERZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
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
    xp: 0,
    level: 1,
    stage: 1,
    total_minutes_listened: 0,
    genre_minutes: {},
    friend_codes: [],
    inventory_v2: { cd: 5 },
    currency: 100,
  };

  const row = { ...defaults, ...overrides };

  const { data, error } = await admin
    .from("herzies")
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create test herzie: ${error?.message}`);
  }

  return data;
}

/** Clean up all test data (call in afterEach/afterAll) */
export async function cleanupTestData() {
  const admin = getAdminClient();

  // Delete in order to respect foreign keys
  await admin
    .from("event_claims")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  await admin
    .from("trades")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  await admin
    .from("herzies")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  // Delete test users from auth
  const { data: users } = await admin.auth.admin.listUsers();
  if (users?.users) {
    for (const user of users.users) {
      if (user.email?.endsWith("@herzies.test")) {
        await admin.auth.admin.deleteUser(user.id);
      }
    }
  }
}

/** Set env vars so the route handlers use local Supabase */
export function setLocalEnv() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
}

/** Build a Request with a real auth token */
export function authenticatedRequest(
  path: string,
  accessToken: string,
  body?: unknown,
  method = "POST",
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  return new Request(`http://localhost/api${path}`, {
    method,
    headers,
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });
}
