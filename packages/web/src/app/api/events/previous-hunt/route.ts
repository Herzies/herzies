import type { GameEvent, SongHuntConfig } from "@herzies/shared";
import { NextResponse } from "next/server";
import { buildSongHuntConfig } from "@/lib/events";
import { createAdminClient } from "@/lib/supabase-admin";

export async function GET() {
  const admin = createAdminClient();
  const now = new Date();

  const { data, error } = await admin
    .from("events")
    .select("id, type, title, description, active, starts_at, ends_at, config")
    .eq("active", false)
    .order("starts_at", { ascending: false })
    .limit(1);

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 },
    );
  }

  const events: GameEvent[] = await Promise.all(
    (data ?? []).map(async (e) => {
      let config: Record<string, unknown>;
      if (e.type === "secret_track") {
        config = {
          rewardItemId: (e.config as Record<string, unknown>).rewardItemId,
        };
      } else if (e.type === "song_hunt") {
        config = await buildSongHuntConfig(
          admin,
          e.id,
          e.config as SongHuntConfig,
          now,
          true,
        );
      } else {
        config = e.config as Record<string, unknown>;
      }

      return {
        id: e.id,
        type: e.type,
        title: e.title,
        description: e.description,
        active: e.active,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        config,
      };
    }),
  );

  return NextResponse.json({ events });
}
