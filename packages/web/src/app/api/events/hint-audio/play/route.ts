import type { SongHuntConfig } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { hintAudioPlaySchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

const MAX_HINT_AUDIO_PLAYS = 3;
/** Long enough to start playback, short enough to bound reuse of the URL. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Grants one play of a hint's audio snippet, if the hint is unlocked and the
 * caller hasn't exhausted their plays. Returns a short-lived signed URL —
 * the audio object key itself is never exposed to clients.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, hintAudioPlaySchema);
  if (isParseError(body)) return body;

  const { eventId, hintIndex } = body;

  const admin = createAdminClient();
  const now = new Date();

  const { data: event } = await admin
    .from("events")
    .select("id, type, active, starts_at, ends_at, config")
    .eq("id", eventId)
    .eq("type", "song_hunt")
    .eq("active", true)
    .lte("starts_at", now.toISOString())
    .gte("ends_at", now.toISOString())
    .single();

  if (!event) {
    return NextResponse.json(
      { error: "Event not found or inactive" },
      { status: 404 },
    );
  }

  const config = event.config as SongHuntConfig;
  const hint = config.hints?.[hintIndex];

  if (!hint) {
    return NextResponse.json({ error: "Hint not found" }, { status: 404 });
  }
  if (now < new Date(hint.unlocksAt)) {
    return NextResponse.json({ error: "Hint is locked" }, { status: 403 });
  }
  if (!hint.audioKey) {
    return NextResponse.json({ error: "Hint has no audio" }, { status: 404 });
  }

  const { data: playRows, error: playError } = await admin.rpc(
    "increment_hint_play",
    {
      p_audio_key: hint.audioKey,
      p_user_id: auth.userId,
      p_max_plays: MAX_HINT_AUDIO_PLAYS,
    },
  );

  if (playError) {
    return NextResponse.json(
      { error: "Failed to register play" },
      { status: 500 },
    );
  }

  const playCount = playRows?.[0]?.play_count as number | undefined;
  if (playCount === undefined) {
    return NextResponse.json(
      { error: "No plays remaining", playsRemaining: 0 },
      { status: 403 },
    );
  }

  const { data: signed, error: signError } = await admin.storage
    .from("hint-audio")
    .createSignedUrl(hint.audioKey, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed) {
    return NextResponse.json(
      { error: "Failed to sign audio URL" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    url: signed.signedUrl,
    playsRemaining: MAX_HINT_AUDIO_PLAYS - playCount,
  });
}
