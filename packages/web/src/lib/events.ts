import type { SongHuntConfig, SongHuntFinder } from "@herzies/shared";
import type { createAdminClient } from "./supabase-admin";

function garbleText(text: string, seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return text
    .split("")
    .map((ch) => {
      if (ch === " ") return " ";
      h = (h * 1103515245 + 12345) | 0;
      return chars[Math.abs(h) % chars.length];
    })
    .join("");
}

export async function buildSongHuntConfig(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  config: SongHuntConfig,
  now: Date,
  includeTrackInfo: boolean = false,
): Promise<Record<string, unknown>> {
  const hints = config.hints.map((hint, i) => {
    const unlocked = now >= new Date(hint.unlocksAt);
    return {
      text: unlocked ? hint.text : garbleText(hint.text, `${eventId}${i}`),
      unlocksAt: hint.unlocksAt,
      unlocked,
    };
  });

  const { data: claims } = await admin
    .from("event_claims")
    .select("claimed_at, user_id")
    .eq("event_id", eventId)
    .order("claimed_at", { ascending: true })
    .limit(config.maxClaims);

  let firstFinders: SongHuntFinder[] = [];
  if (claims && claims.length > 0) {
    const userIds = claims.map((c) => c.user_id as string);
    const { data: herzies } = await admin
      .from("herzies")
      .select("user_id, name")
      .in("user_id", userIds);

    const nameMap = new Map(
      (herzies ?? []).map((h) => [h.user_id, h.name as string]),
    );
    firstFinders = claims.map((c) => ({
      name: nameMap.get(c.user_id as string) ?? "Unknown",
      claimedAt: c.claimed_at as string,
    }));
  }

  const result: Record<string, unknown> = {
    rewardItemId: config.rewardItemId,
    maxClaims: config.maxClaims,
    hints,
    firstFinders,
  };

  if (includeTrackInfo) {
    result.trackTitle = config.trackTitle;
    result.trackArtist = config.trackArtist;
  }

  return result;
}
