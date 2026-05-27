import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SCOPES = "user-read-recently-played user-read-currently-playing";

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    response_type: "code",
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI!,
    scope: SCOPES,
    state,
    show_dialog: "true",
  });

  const response = NextResponse.redirect(`${SPOTIFY_AUTH_URL}?${params}`);

  // Store state in a short-lived httpOnly cookie for CSRF validation
  response.cookies.set("spotify_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
