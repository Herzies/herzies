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

let cachedAppToken: { token: string; expiresAt: number } | null = null;

/**
 * App-level access token (Client Credentials grant — no user auth), for
 * endpoints like artist search that only need public catalog data.
 */
async function getAppAccessToken(): Promise<string> {
  if (cachedAppToken && Date.now() < cachedAppToken.expiresAt - 30_000) {
    return cachedAppToken.token;
  }

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET!,
    }),
  });

  if (!res.ok) {
    throw new Error(`Spotify app token request failed: ${res.status}`);
  }

  const data = await res.json();
  cachedAppToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedAppToken.token;
}

const artistImageCache = new Map<
  string,
  { url: string | null; cachedAt: number }
>();
const ARTIST_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort artist portrait photo (largest available), via Spotify search.
 * Cached per artist name (including misses) since this is polled on every
 * track change. Never throws — a lookup failure just means no photo.
 */
export async function findArtistImage(
  artistName: string,
): Promise<string | null> {
  const key = artistName.toLowerCase().trim();
  const cached = artistImageCache.get(key);
  if (cached && Date.now() - cached.cachedAt < ARTIST_IMAGE_CACHE_TTL_MS) {
    console.log("[findArtistImage] cache hit", { artistName, url: cached.url });
    return cached.url;
  }

  let url: string | null = null;
  try {
    const token = await getAppAccessToken();
    const params = new URLSearchParams({
      q: `artist:"${artistName}"`,
      type: "artist",
      limit: "1",
    });
    const res = await fetch(`${SPOTIFY_API_BASE}/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const images = data.artists?.items?.[0]?.images as
        | { url: string }[]
        | undefined;
      url = images?.[0]?.url ?? null;
      console.log("[findArtistImage] search result", {
        artistName,
        matchedArtist: data.artists?.items?.[0]?.name,
        imageCount: images?.length ?? 0,
        url,
      });
    } else {
      console.error(
        "[findArtistImage] Spotify search failed",
        res.status,
        await res.text(),
      );
    }
  } catch (err) {
    console.error("[findArtistImage] threw", err);
    url = null;
  }

  artistImageCache.set(key, { url, cachedAt: Date.now() });
  return url;
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
