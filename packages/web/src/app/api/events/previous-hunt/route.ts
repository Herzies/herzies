import type { GameEvent, SongHuntConfig } from "@herzies/shared";
import { NextResponse } from "next/server";
import { buildSongHuntConfig } from "@/lib/events";
import { createAdminClient } from "@/lib/supabase-admin";

function toPublicNextHunt(e: {
  id: string;
  type: string;
  title: string;
  description: string | null;
  active: boolean;
  starts_at: string;
  ends_at: string;
  config: Record<string, unknown>;
}): GameEvent {
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
      rewardItemId: e.config.rewardItemId,
      maxClaims: e.config.maxClaims,
    },
  };
}

export async function GET() {
  const admin = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  const [previousResult, nextResult] = await Promise.all([
    admin
      .from("events")
      .select("id, type, title, description, active, starts_at, ends_at, config")
      .eq("type", "song_hunt")
      .lt("ends_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(1),
    admin
      .from("events")
      .select("id, type, title, description, active, starts_at, ends_at, config")
      .eq("type", "song_hunt")
      .eq("active", true)
      .gt("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(1),
  ]);

  if (previousResult.error || nextResult.error) {
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 },
    );
  }

  const events: GameEvent[] = await Promise.all(
    (previousResult.data ?? []).map(async (e) => {
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

  const next =
    (nextResult.data ?? []).map((e) =>
      toPublicNextHunt({
        ...e,
        config: e.config as Record<string, unknown>,
      }),
    )[0] ?? null;

  return NextResponse.json({ events, next });
}
