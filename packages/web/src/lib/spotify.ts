import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "./crypto";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export interface SpotifyConnection {
  id: string;
  user_id: string;
  spotify_user_id: string;
  display_name: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: string;
  last_polled_at: string | null;
  last_track_played_at: string | null;
}

export interface SpotifyRecentTrack {
  trackId: string;
  trackName: string;
  artistName: string;
  durationMs: number;
  playedAt: string; // ISO timestamp
}

/** Refresh a Spotify access token using the refresh token */
export async function refreshSpotifyToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET!,
    }),
  });

  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    // Spotify may return a new refresh token
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: data.expires_in,
  };
}

/**
 * Get a valid access token for a Spotify connection.
 * Refreshes and updates DB if expired.
 */
export async function getValidAccessToken(
  connection: SpotifyConnection,
  admin: SupabaseClient,
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at).getTime();
  // Refresh if expiring within 5 minutes
  if (Date.now() < expiresAt - 5 * 60_000) {
    return decrypt(connection.access_token_encrypted);
  }

  const currentRefreshToken = decrypt(connection.refresh_token_encrypted);
  const tokens = await refreshSpotifyToken(currentRefreshToken);

  await admin
    .from("spotify_connections")
    .update({
      access_token_encrypted: encrypt(tokens.accessToken),
      refresh_token_encrypted: encrypt(tokens.refreshToken),
      token_expires_at: new Date(
        Date.now() + tokens.expiresIn * 1000,
      ).toISOString(),
    })
    .eq("id", connection.id);

  return tokens.accessToken;
}

/** Fetch recently played tracks from Spotify */
export async function getRecentlyPlayed(
  accessToken: string,
  after?: number, // Unix timestamp in ms
): Promise<SpotifyRecentTrack[]> {
  const params = new URLSearchParams({ limit: "50" });
  if (after) params.set("after", String(after));

  const res = await fetch(
    `${SPOTIFY_API_BASE}/me/player/recently-played?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!res.ok) {
    throw new Error(`Spotify recently-played failed: ${res.status}`);
  }

  const data = await res.json();
  return (data.items ?? []).map((item: Record<string, unknown>) => {
    const track = item.track as Record<string, unknown>;
    const artists = track.artists as Array<{ name: string }>;
    return {
      trackId: track.id as string,
      trackName: track.name as string,
      artistName: artists.map((a) => a.name).join(", "),
      durationMs: track.duration_ms as number,
      playedAt: item.played_at as string,
    };
  });
}
