import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase-admin";
import { createServerClient } from "@/lib/supabase-server";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // User denied access
  if (error) {
    return NextResponse.redirect(
      new URL("/dashboard?spotify=denied", request.url),
    );
  }

  // Validate state (CSRF protection)
  const storedState = request.cookies.get("spotify_oauth_state")?.value;
  if (!state || !storedState || state !== storedState) {
    return NextResponse.redirect(
      new URL("/dashboard?spotify=error", request.url),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/dashboard?spotify=error", request.url),
    );
  }

  // Verify user is logged in
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Exchange code for tokens
  const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI!,
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET!,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      new URL("/dashboard?spotify=error", request.url),
    );
  }

  const tokens = await tokenRes.json();

  // Fetch Spotify user profile
  const profileRes = await fetch(`${SPOTIFY_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileRes.ok) {
    return NextResponse.redirect(
      new URL("/dashboard?spotify=error", request.url),
    );
  }

  const profile = await profileRes.json();

  // Store connection in DB (upsert by user_id)
  const admin = createAdminClient();
  const { error: dbError } = await admin.from("spotify_connections").upsert(
    {
      user_id: user.id,
      spotify_user_id: profile.id,
      display_name: profile.display_name ?? profile.id,
      access_token_encrypted: encrypt(tokens.access_token),
      refresh_token_encrypted: encrypt(tokens.refresh_token),
      token_expires_at: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
      scopes: tokens.scope ?? "",
    },
    { onConflict: "user_id" },
  );

  if (dbError) {
    return NextResponse.redirect(
      new URL("/dashboard?spotify=error", request.url),
    );
  }

  const response = NextResponse.redirect(
    new URL("/dashboard?spotify=connected", request.url),
  );
  // Clear the state cookie
  response.cookies.delete("spotify_oauth_state");
  return response;
}
