import { NextResponse } from "next/server";
import { adminUserIds, unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase-admin";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A herzie counts as online while its desktop app syncs (every ~10s). */
const ONLINE_WINDOW = 2 * MINUTE;

export type AdminStats = {
  generatedAt: string;
  herzies: {
    total: number;
    online: number;
    /** Online herzies with a track playing right now. */
    listening: number;
    active24h: number;
    active7d: number;
  };
  signups: {
    today: number;
    last7d: number;
    /** One entry per day, oldest first, the last 30 days (UTC). */
    daily: { date: string; count: number }[];
  };
  liveNow: {
    name: string;
    level: number;
    title: string | null;
    artist: string | null;
    lastSyncedAt: string;
  }[];
  events: {
    running: { id: string; type: string; title: string; endsAt: string }[];
    upcoming: { id: string; type: string; title: string; startsAt: string }[];
  };
  store: { completed7d: number; completed30d: number; failed7d: number };
  bossFights: {
    eventId: string;
    outcome: string;
    rosterSize: number;
    endedAt: string;
  }[];
};

/** Day key (UTC) for a timestamp: "2026-11-07". */
function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The control panel's overview numbers. The owner's own accounts
 * (ADMIN_USER_IDS) are left out of every herzie count.
 */
export async function GET(request: Request) {
  if (!(await verifyAdmin(request))) return unauthorizedAdmin();

  const db = createAdminClient();
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const excluded = [...adminUserIds()];
  const notOwner = `(${excluded.join(",")})`;

  const countHerzies = (since?: { column: string; after: string }) => {
    let q = db.from("herzies").select("id", { count: "exact", head: true });
    if (excluded.length) q = q.not("user_id", "in", notOwner);
    if (since) q = q.gt(since.column, since.after);
    return q;
  };

  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const seriesStart = todayStart.getTime() - 29 * DAY;
  const nowIso = new Date(now).toISOString();

  let liveQuery = db
    .from("herzies")
    .select("name, level, now_playing, last_synced_at")
    .gt("last_synced_at", ago(ONLINE_WINDOW))
    .order("last_synced_at", { ascending: false })
    .limit(12);
  let signupQuery = db
    .from("herzies")
    .select("created_at")
    .gte("created_at", new Date(seriesStart).toISOString())
    .limit(10_000);
  if (excluded.length) {
    liveQuery = liveQuery.not("user_id", "in", notOwner);
    signupQuery = signupQuery.not("user_id", "in", notOwner);
  }

  const [
    total,
    online,
    listening,
    active24h,
    active7d,
    live,
    signupRows,
    running,
    upcoming,
    completed7d,
    completed30d,
    failed7d,
    bosses,
  ] = await Promise.all([
    countHerzies(),
    countHerzies({ column: "last_synced_at", after: ago(ONLINE_WINDOW) }),
    countHerzies({
      column: "last_synced_at",
      after: ago(ONLINE_WINDOW),
    }).not("now_playing", "is", null),
    countHerzies({ column: "last_synced_at", after: ago(DAY) }),
    countHerzies({ column: "last_synced_at", after: ago(7 * DAY) }),
    liveQuery,
    signupQuery,
    db
      .from("events")
      .select("id, type, title, ends_at")
      .eq("active", true)
      .lte("starts_at", nowIso)
      .gte("ends_at", nowIso)
      .order("ends_at"),
    db
      .from("events")
      .select("id, type, title, starts_at")
      .eq("active", true)
      .gt("starts_at", nowIso)
      .order("starts_at")
      .limit(5),
    db
      .from("store_orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gt("completed_at", ago(7 * DAY)),
    db
      .from("store_orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gt("completed_at", ago(30 * DAY)),
    db
      .from("store_orders")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "expired"])
      .gt("created_at", ago(7 * DAY)),
    db
      .from("boss_fight_log")
      .select("event_id, outcome, roster_size, ended_at")
      .order("ended_at", { ascending: false })
      .limit(6),
  ]);

  const failed = [total, online, listening, live, signupRows, running].find(
    (r) => r.error,
  );
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  const perDay = new Map<string, number>();
  for (let t = seriesStart; t <= todayStart.getTime(); t += DAY) {
    perDay.set(dayKey(t), 0);
  }
  for (const row of signupRows.data ?? []) {
    const key = dayKey(new Date(row.created_at).getTime());
    if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const daily = [...perDay].map(([date, count]) => ({ date, count }));
  const sevenDaysAgo = dayKey(todayStart.getTime() - 6 * DAY);

  const stats: AdminStats = {
    generatedAt: nowIso,
    herzies: {
      total: total.count ?? 0,
      online: online.count ?? 0,
      listening: listening.count ?? 0,
      active24h: active24h.count ?? 0,
      active7d: active7d.count ?? 0,
    },
    signups: {
      today: perDay.get(dayKey(todayStart.getTime())) ?? 0,
      last7d: daily
        .filter((d) => d.date >= sevenDaysAgo)
        .reduce((sum, d) => sum + d.count, 0),
      daily,
    },
    liveNow: (live.data ?? []).map((h) => {
      const playing = h.now_playing as {
        title?: string;
        artist?: string;
      } | null;
      return {
        name: h.name,
        level: h.level,
        title: playing?.title ?? null,
        artist: playing?.artist ?? null,
        lastSyncedAt: h.last_synced_at,
      };
    }),
    events: {
      running: (running.data ?? []).map((e) => ({
        id: e.id,
        type: e.type,
        title: e.title,
        endsAt: e.ends_at,
      })),
      upcoming: (upcoming.data ?? []).map((e) => ({
        id: e.id,
        type: e.type,
        title: e.title,
        startsAt: e.starts_at,
      })),
    },
    store: {
      completed7d: completed7d.count ?? 0,
      completed30d: completed30d.count ?? 0,
      failed7d: failed7d.count ?? 0,
    },
    bossFights: (bosses.data ?? []).map((b) => ({
      eventId: b.event_id,
      outcome: b.outcome,
      rosterSize: b.roster_size,
      endedAt: b.ended_at,
    })),
  };

  return NextResponse.json(stats, {
    headers: { "Cache-Control": "no-store" },
  });
}
