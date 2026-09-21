import { NextResponse } from "next/server";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import {
  adminBossSettingsSchema,
  adminBossSkipSchema,
  isParseError,
  parseBody,
} from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Weekly boss schedule settings (00076).
 *
 * Individual bosses are created and edited through /api/admin/events like any
 * other event; this route only covers what the Thursday cron does on its own.
 */
export async function GET(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const admin = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [settings, skips, active] = await Promise.all([
    admin.from("boss_fight_settings").select("*").eq("id", true).maybeSingle(),
    admin
      .from("boss_fight_skips")
      .select("week_of")
      .gte("week_of", today)
      .order("week_of"),
    admin
      .from("herzies")
      .select("user_id", { count: "exact", head: true })
      .gt("last_synced_at", since),
  ]);

  if (settings.error || skips.error) {
    return NextResponse.json(
      { error: "Failed to fetch boss fight settings" },
      { status: 500 },
    );
  }

  const s = settings.data;
  return NextResponse.json({
    settings: {
      autoSpawn: s?.auto_spawn ?? true,
      defaultHp: s?.default_hp ?? null,
      rewardItemId: s?.reward_item_id ?? "cd",
      topRewardItemId: s ? s.top_reward_item_id : "cd",
      topCount: s?.top_count ?? 3,
    },
    skippedWeeks: (skips.data ?? []).map((r) => r.week_of as string),
    // Same formula as spawn_boss_fight, so the page can show what "auto" means
    // right now.
    autoHp: Math.min(50000, Math.max(900, (active.count ?? 0) * 35)),
  });
}

/** Update the weekly spawn settings */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const body = await parseBody(request, adminBossSettingsSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();

  const itemIds = [body.rewardItemId, body.topRewardItemId].filter(
    (id): id is string => !!id,
  );
  const { data: items } = await admin
    .from("items")
    .select("id")
    .in("id", itemIds);
  const missing = itemIds.filter((id) => !items?.some((i) => i.id === id));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Unknown item: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const { error } = await admin.from("boss_fight_settings").upsert({
    id: true,
    auto_spawn: body.autoSpawn,
    default_hp: body.defaultHp,
    reward_item_id: body.rewardItemId,
    top_reward_item_id: body.topRewardItemId,
    top_count: body.topCount,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return NextResponse.json(
      { error: "Failed to save boss fight settings" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

/** Skip or un-skip one week's automatic spawn */
export async function PUT(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const body = await parseBody(request, adminBossSkipSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();
  const { error } = body.skip
    ? await admin
        .from("boss_fight_skips")
        .upsert({ week_of: body.weekOf }, { onConflict: "week_of" })
    : await admin.from("boss_fight_skips").delete().eq("week_of", body.weekOf);

  if (error) {
    return NextResponse.json(
      { error: "Failed to update skipped weeks" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
