import type { GameEvent } from "@herzies/shared";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

/** Next scheduled Song Hunt (starts in the future). No spoilers in config. */
export async function GET() {
  const admin = createAdminClient();
  const now = new Date();

  const { data, error } = await admin
    .from("events")
    .select("id, type, title, description, active, starts_at, ends_at, config")
    .eq("type", "song_hunt")
    .eq("active", true)
    .gt("starts_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(1);

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 },
    );
  }

  const events: GameEvent[] = (data ?? []).map((e) => {
    const config = e.config as Record<string, unknown>;
    return {
      id: e.id,
      type: e.type,
      title: e.title,
      description: e.description,
      active: e.active,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      // Public preview only — never leak track or hints before the hunt starts.
      config: {
        rewardItemId: config.rewardItemId,
        maxClaims: config.maxClaims,
      },
    };
  });

  return NextResponse.json({ events });
}
