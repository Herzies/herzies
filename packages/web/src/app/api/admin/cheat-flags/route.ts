import { NextResponse } from "next/server";
import { adminUserIds, unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase-admin";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A flag's weight: "high" can't happen honestly, "medium" is an outlier. */
export type FlagSeverity = "high" | "medium";

export type CheatFlag = {
  kind: "listening" | "monthly-xp" | "boss-damage";
  severity: FlagSeverity;
  userId: string;
  name: string;
  level: number;
  /** One line: what was seen. */
  detail: string;
  /** What the number was measured against. */
  baseline: string;
  /** When it was seen (ISO), for sorting. */
  at: string;
};

export type CheatFlagsResponse = {
  generatedAt: string;
  flags: CheatFlag[];
};

/** Listened minutes over the minutes since signup. Real time is 1; the sync
 * allows 3x catch-up, so past that the total can't have come from the game. */
const LISTEN_MEDIUM = 1.05;
const LISTEN_HIGH = 3;
/** Ignore accounts younger than this: the ratio is noise at first. */
const LISTEN_MIN_AGE_MIN = 60;

/** Monthly XP past this multiple of the 90th percentile (and the floor). */
const XP_OUTLIER = 3;
const XP_HIGH = 8;
const XP_FLOOR = 2_000;

/** Boss damage past this multiple of the fight's median (3+ fighters). */
const DMG_OUTLIER = 8;
const DMG_HIGH = 25;
const DMG_WINDOW_DAYS = 30;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const fmt = (n: number) =>
  n >= 1000
    ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
    : String(Math.round(n));

/**
 * Accounts whose numbers look wrong: more listening than time has passed, a
 * month's XP far above everyone else's, boss damage far above the fight's.
 * The server decides all of these, so a flag means a hole or a forged
 * request, not a memory edit. Review by hand; nothing here bans anyone.
 */
export async function GET(request: Request) {
  if (!(await verifyAdmin(request))) return unauthorizedAdmin();

  const db = createAdminClient();
  const now = Date.now();
  const owner = adminUserIds();
  const month = new Date(now);
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  const monthKey = month.toISOString().slice(0, 10);

  const [herzies, xpRows, events] = await Promise.all([
    db
      .from("herzies")
      .select("user_id, name, level, created_at, total_minutes_listened")
      .limit(20_000),
    db
      .from("herzie_xp_monthly")
      .select("user_id, xp")
      .eq("month", monthKey)
      .limit(20_000),
    db
      .from("events")
      .select("id, title, ends_at")
      .eq("type", "boss")
      .gt("ends_at", new Date(now - DMG_WINDOW_DAYS * DAY).toISOString())
      .lt("starts_at", new Date(now).toISOString()),
  ]);
  if (herzies.error) {
    return NextResponse.json({ error: herzies.error.message }, { status: 500 });
  }

  const who = new Map(
    (herzies.data ?? [])
      .filter((h) => !owner.has(h.user_id))
      .map((h) => [h.user_id as string, h]),
  );
  const flags: CheatFlag[] = [];
  const nowIso = new Date(now).toISOString();
  const add = (
    f: Omit<CheatFlag, "name" | "level" | "at"> & { at?: string },
  ) => {
    const h = who.get(f.userId);
    if (!h) return;
    flags.push({ name: h.name, level: h.level, at: nowIso, ...f });
  };

  // Listening: more minutes than the account has existed.
  for (const h of who.values()) {
    const ageMin = (now - new Date(h.created_at).getTime()) / MINUTE;
    if (ageMin < LISTEN_MIN_AGE_MIN) continue;
    const ratio = h.total_minutes_listened / ageMin;
    if (ratio < LISTEN_MEDIUM) continue;
    add({
      kind: "listening",
      severity: ratio >= LISTEN_HIGH ? "high" : "medium",
      userId: h.user_id,
      detail: `${fmt(h.total_minutes_listened)} min listened in ${fmt(ageMin)} min of account life (${ratio.toFixed(1)}x real time)`,
      baseline: "1x real time; the sync's catch-up cap is 3x",
    });
  }

  // Monthly XP: far above the field.
  const xps = (xpRows.data ?? [])
    .filter((r) => who.has(r.user_id))
    .map((r) => ({ userId: r.user_id as string, xp: Number(r.xp) }));
  const p90 = percentile(
    xps.map((r) => r.xp),
    0.9,
  );
  for (const r of xps) {
    if (r.xp < XP_FLOOR || p90 <= 0 || r.xp < p90 * XP_OUTLIER) continue;
    add({
      kind: "monthly-xp",
      severity: r.xp >= p90 * XP_HIGH ? "high" : "medium",
      userId: r.userId,
      detail: `${fmt(r.xp)} XP this month (${(r.xp / p90).toFixed(1)}x the 90th percentile)`,
      baseline: `p90 this month: ${fmt(p90)} XP`,
    });
  }

  // Boss damage: far above the fight's median.
  const evs = events.data ?? [];
  if (evs.length) {
    const dmg = await db
      .from("boss_damage")
      .select("event_id, user_id, damage")
      .in(
        "event_id",
        evs.map((e) => e.id),
      )
      .limit(50_000);
    for (const e of evs) {
      const rows = (dmg.data ?? []).filter((d) => d.event_id === e.id);
      if (rows.length < 3) continue;
      const med = median(rows.map((d) => Number(d.damage)));
      if (med <= 0) continue;
      for (const d of rows) {
        const ratio = Number(d.damage) / med;
        if (ratio < DMG_OUTLIER) continue;
        add({
          kind: "boss-damage",
          severity: ratio >= DMG_HIGH ? "high" : "medium",
          userId: d.user_id,
          detail: `${fmt(Number(d.damage))} damage in "${e.title}" (${ratio.toFixed(1)}x the median)`,
          baseline: `${rows.length} fighters, median ${fmt(med)}`,
          at: e.ends_at,
        });
      }
    }
  }

  flags.sort(
    (a, b) =>
      Number(b.severity === "high") - Number(a.severity === "high") ||
      b.at.localeCompare(a.at),
  );
  return NextResponse.json({
    generatedAt: nowIso,
    flags,
  } satisfies CheatFlagsResponse);
}
