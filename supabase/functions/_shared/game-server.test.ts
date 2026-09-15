import { assertEquals } from "jsr:@std/assert@^1";
import { processSync } from "./shared/game-server.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Covers processSync's read path, which moved from 7-9 separate queries to the
 * single sync_context RPC (00060_sync_context.sql). The game logic itself was
 * not changed by that work; these assert that every field the old queries fed
 * still reaches the response, and — the part that would fail silently in
 * production — that nothing goes back to the database for data the context
 * already carried.
 */

const USER = "11111111-1111-1111-1111-111111111111";

function herzieRow(over: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    user_id: USER,
    name: "Testie",
    created_at: "2026-01-01T00:00:00+00:00",
    appearance: null,
    xp: 1000,
    level: 5,
    stage: 2,
    total_minutes_listened: 100,
    genre_minutes: {},
    friend_code: "HERZ-TEST",
    friend_codes: [],
    last_craving_date: "",
    last_craving_genre: "",
    boost_until: null,
    streak_days: 0,
    streak_last_date: null,
    currency: 50,
    drop_rolls_done: 10,
    notified_hunts: [],
    inventory_v2: { cd: 3 },
    equipped: {},
    now_playing: null,
    ...over,
  };
}

function context(over: Record<string, unknown> = {}) {
  return {
    herzie: herzieRow(),
    multipliers: [],
    pending_drops: [],
    active_hunts: [],
    pending_trade: null,
    friend_requests: [],
    ...over,
  };
}

/**
 * Minimal admin double. Records every table touched and RPC called so a test
 * can assert on what did NOT happen, and returns empty results for anything
 * the sync still legitimately reaches for.
 */
function fakeAdmin(ctx: Record<string, unknown>) {
  const tablesTouched: string[] = [];
  const rpcsCalled: string[] = [];

  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of [
      "select", "insert", "update", "delete", "upsert", "eq", "neq", "gt",
      "gte", "lt", "lte", "in", "not", "is", "or", "order", "limit",
    ]) {
      c[m] = () => c;
    }
    c.single = () => Promise.resolve(result);
    c.maybeSingle = () => Promise.resolve(result);
    c.then = (res: (v: unknown) => void) => res(result);
    return c;
  };

  const admin = {
    from(table: string) {
      tablesTouched.push(table);
      // The post-update returning select in step 7.
      if (table === "herzies") {
        return chain({
          data: { inventory_v2: { cd: 3 }, equipped: {} },
          error: null,
        });
      }
      return chain({ data: [], error: null });
    },
    rpc(fn: string, _params?: unknown) {
      rpcsCalled.push(fn);
      if (fn === "sync_context") {
        return Promise.resolve({ data: ctx, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { admin: admin as unknown as SupabaseClient, tablesTouched, rpcsCalled };
}

Deno.test("hydrates the herzie from sync_context", async () => {
  const { admin, rpcsCalled } = fakeAdmin(context());
  const out = await processSync(admin, USER, null, 0, []);

  assertEquals(rpcsCalled[0], "sync_context");
  assertEquals(out.herzie.name, "Testie");
  assertEquals(out.herzie.friendCode, "HERZ-TEST");
  assertEquals(out.herzie.currency, 50);
  assertEquals(out.inventory, { cd: 3 });
});

Deno.test("does not re-query tables sync_context already covered", async () => {
  const { admin, tablesTouched } = fakeAdmin(
    context({
      pending_drops: [
        { id: "d1", item_id: "cd", dropped_at: "2026-01-01T00:00:00+00:00" },
      ],
      pending_trade: {
        tradeId: "t1",
        fromName: "Bob",
        fromFriendCode: "HERZ-BOB",
      },
      friend_requests: [
        {
          requestId: "r1",
          incoming: true,
          name: "Ann",
          friendCode: "HERZ-ANN",
          createdAt: "2026-01-01T00:00:00+00:00",
        },
      ],
    }),
  );

  await processSync(admin, USER, null, 0, []);

  // The only table write left on this path is the step-7 herzie update.
  for (const table of ["multipliers", "pending_drops", "trades", "friend_requests", "events"]) {
    assertEquals(
      tablesTouched.includes(table),
      false,
      `${table} was queried even though sync_context already returned it`,
    );
  }
  assertEquals(tablesTouched, ["herzies"]);
});

Deno.test("passes pending drops, trade and friend requests through", async () => {
  const { admin } = fakeAdmin(
    context({
      pending_drops: [
        { id: "d1", item_id: "cd", dropped_at: "2026-01-01T00:00:00+00:00" },
        { id: "d2", item_id: "boombox", dropped_at: "2026-01-02T00:00:00+00:00" },
      ],
      pending_trade: {
        tradeId: "t1",
        fromName: "Bob",
        fromFriendCode: "HERZ-BOB",
      },
      friend_requests: [
        { requestId: "r1", incoming: true, name: "Ann", friendCode: "HERZ-ANN", createdAt: "2026-01-03T00:00:00+00:00" },
        { requestId: "r2", incoming: false, name: "Cid", friendCode: "HERZ-CID", createdAt: "2026-01-02T00:00:00+00:00" },
      ],
    }),
  );

  const out = await processSync(admin, USER, null, 0, []);

  assertEquals(out.pendingDrops.map((d) => d.id), ["d1", "d2"]);
  assertEquals(out.pendingDrops[0].itemId, "cd");
  assertEquals(out.pendingTradeRequest?.fromName, "Bob");
  assertEquals(out.incomingFriendRequests.map((r) => r.requestId), ["r1"]);
  assertEquals(out.outgoingFriendRequests.map((r) => r.requestId), ["r2"]);
  // The overlay prompt is driven by the first incoming request.
  assertEquals(out.pendingFriendRequest?.fromFriendCode, "HERZ-ANN");
});

Deno.test("applies the schedule filter to multipliers in TypeScript", async () => {
  // sync_context does the date-range filter in SQL but returns `schedule`
  // untouched, because isScheduleActive reads the runtime's local day/hour.
  const now = new Date();
  const { admin } = fakeAdmin(
    context({
      multipliers: [
        { name: "ALWAYS", bonus: 0.5, schedule: null },
        {
          name: "RIGHT_NOW",
          bonus: 1.0,
          schedule: { days: [now.getDay()], hourStart: 0, hourEnd: 24 },
        },
        {
          name: "WRONG_DAY",
          bonus: 2.0,
          schedule: { days: [(now.getDay() + 3) % 7], hourStart: 0, hourEnd: 24 },
        },
      ],
    }),
  );

  const out = await processSync(admin, USER, null, 0, []);
  const names = out.multipliers.map((m) => m.name);

  assertEquals(names.includes("ALWAYS"), true);
  assertEquals(names.includes("RIGHT_NOW"), true);
  assertEquals(names.includes("WRONG_DAY"), false);
});

Deno.test("adds streak and BOOST multipliers on top of the server ones", async () => {
  const { admin } = fakeAdmin(
    context({
      herzie: herzieRow({
        streak_days: 4,
        boost_until: Date.now() + 60_000,
      }),
    }),
  );

  const out = await processSync(admin, USER, null, 0, []);
  const names = out.multipliers.map((m) => m.name);

  assertEquals(names.includes("BOOST"), true);
  assertEquals(names.includes("4-day streak"), true);
});

Deno.test("throws when sync_context finds no herzie", async () => {
  const { admin } = fakeAdmin(context({ herzie: null }));
  let threw = false;
  try {
    await processSync(admin, USER, null, 0, []);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
