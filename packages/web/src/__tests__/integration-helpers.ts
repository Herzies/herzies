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

/** How many of each item a test wants a player to own. */
export type InventorySpec = Record<string, number>;

/**
 * Give a player exactly this inventory, replacing whatever they own: one owned
 * copy (an item_units row) per unit, so a test can think in counts.
 *
 * `equipped` wears one copy of each named item, in the same shape the legacy
 * `equipped` column had (`{ground_left: "boombox", modifier: ["a", "b"]}`).
 * `levels` sets the upgrade level of the WORN copy of an item, or of one copy
 * if it isn't worn.
 *
 * Owned items are rows, not a column you can write: inventory_v2/equipped/
 * item_upgrades are derived from item_units by a trigger and a direct write to
 * them is rejected.
 */
export async function seedInventory(
  userId: string,
  inventory: InventorySpec,
  opts: {
    equipped?: Record<string, string | string[]>;
    levels?: Record<string, number>;
  } = {},
): Promise<void> {
  const admin = getAdminClient();
  const { error: delError } = await admin
    .from("item_units")
    .delete()
    .eq("user_id", userId);
  if (delError) throw new Error(`seedInventory delete: ${delError.message}`);

  const worn = new Map<string, string>(); // itemId -> slot
  for (const [slot, value] of Object.entries(opts.equipped ?? {})) {
    for (const itemId of Array.isArray(value) ? value : [value]) {
      worn.set(itemId, slot);
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (const [itemId, qty] of Object.entries(inventory)) {
    for (let i = 0; i < qty; i++) {
      // The first copy of an item is the worn / levelled one.
      rows.push({
        user_id: userId,
        item_id: itemId,
        equipped_slot: i === 0 ? (worn.get(itemId) ?? null) : null,
        equipped_at:
          i === 0 && worn.has(itemId) ? new Date().toISOString() : null,
        upgrade_level: i === 0 ? (opts.levels?.[itemId] ?? 0) : 0,
      });
    }
  }
  if (rows.length === 0) return;
  const { error } = await admin.from("item_units").insert(rows);
  if (error) throw new Error(`seedInventory insert: ${error.message}`);
}

/** A player's owned copies, oldest first. */
export async function getUnits(userId: string): Promise<
  {
    id: string;
    item_id: string;
    upgrade_level: number;
    equipped_slot: string | null;
  }[]
> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("item_units")
    .select("id, item_id, upgrade_level, equipped_slot")
    .eq("user_id", userId)
    .order("acquired_at")
    .order("id");
  if (error) throw new Error(`getUnits: ${error.message}`);
  return data ?? [];
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
    currency: 100,
  };

  // Tests still think in counts: `inventory_v2`, `equipped` and `item_upgrades`
  // overrides are turned into owned copies rather than written to the columns
  // (which are derived from item_units and reject direct writes).
  const {
    inventory_v2: inventory = { cd: 5 },
    equipped = {},
    item_upgrades: levels = {},
    ...rest
  } = overrides as {
    inventory_v2?: InventorySpec;
    equipped?: Record<string, string | string[]>;
    item_upgrades?: Record<string, number>;
  } & Record<string, unknown>;

  const row = { ...defaults, ...rest };

  const { data, error } = await admin
    .from("herzies")
    .insert(row)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create test herzie: ${error?.message}`);
  }

  await seedInventory(userId, inventory, { equipped, levels });

  // Re-read so the returned row reflects the projection the seed just wrote.
  const { data: fresh } = await admin
    .from("herzies")
    .select("*")
    .eq("user_id", userId)
    .single();
  return fresh ?? data;
}

/** Clean up all test data (call in afterEach/afterAll) */
export async function cleanupTestData() {
  const admin = getAdminClient();

  // Delete in order to respect foreign keys
  await admin
    .from("event_claims")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  // Events themselves, which nothing used to clean up. Harmless while event
  // tests only asserted RLS, but spawn_boss_fight() no-ops when a boss is
  // already live — so a leftover boss makes the NEXT run's spawn test fail
  // looking like a logic bug. boss_state/boss_damage cascade from here.
  await admin
    .from("events")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  // Back to 00076's defaults: a test that turns the weekly spawn off or sets a
  // default HP must not change what the next test's spawn does.
  await admin.from("boss_fight_settings").upsert({
    id: true,
    auto_spawn: true,
    default_hp: null,
    reward_item_id: "cd",
    top_reward_item_id: "cd",
    top_count: 3,
  });
  await admin.from("boss_fight_skips").delete().gte("week_of", "1970-01-01");
  await admin
    .from("trades")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  // Orders reference auth.users with no ON DELETE CASCADE, so a player who has
  // one can't be deleted below — the delete fails quietly and the user (and
  // their fixed-session-id orders) leak into the next run.
  await admin
    .from("store_orders")
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
