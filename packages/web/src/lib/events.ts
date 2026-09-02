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

const MAX_HINT_AUDIO_PLAYS = 3;

export async function buildSongHuntConfig(
  admin: ReturnType<typeof createAdminClient>,
  eventId: string,
  config: SongHuntConfig,
  now: Date,
  includeTrackInfo: boolean = false,
  userId: string | null = null,
): Promise<Record<string, unknown>> {
  const unlockedAudioKeys = config.hints
    .filter((h) => h.audioKey && now >= new Date(h.unlocksAt))
    .map((h) => h.audioKey as string);

  let playCounts = new Map<string, number>();
  if (userId && unlockedAudioKeys.length > 0) {
    const { data: plays } = await admin
      .from("hint_plays")
      .select("audio_key, play_count")
      .eq("user_id", userId)
      .in("audio_key", unlockedAudioKeys);
    playCounts = new Map(
      (plays ?? []).map((p) => [p.audio_key as string, p.play_count as number]),
    );
  }

  const hints = config.hints.map((hint, i) => {
    const unlocked = now >= new Date(hint.unlocksAt);
    const result: Record<string, unknown> = {
      text: unlocked ? hint.text : garbleText(hint.text, `${eventId}${i}`),
      unlocksAt: hint.unlocksAt,
      unlocked,
    };
    // Locked hints never carry audio metadata — same principle as garbling
    // the text: nothing about a locked hint should be inspectable.
    if (unlocked && hint.audioKey) {
      result.hasAudio = true;
      if (userId) {
        const playCount = playCounts.get(hint.audioKey) ?? 0;
        result.playsRemaining = Math.max(0, MAX_HINT_AUDIO_PLAYS - playCount);
      }
    }
    return result;
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
