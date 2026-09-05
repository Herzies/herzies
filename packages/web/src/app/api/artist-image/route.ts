import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { findArtistImage } from "@/lib/spotify";

/**
 * Artist portrait photo for the desktop app's now-playing bar background.
 * Server-mediated so the Spotify client secret never ships in the app.
 *
 * GET /api/artist-image?artist=NAME
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const artist = new URL(request.url).searchParams.get("artist")?.trim();
  if (!artist) {
    return NextResponse.json({ error: "artist is required" }, { status: 400 });
  }

  const url = await findArtistImage(artist);
  console.log("[artist-image]", { artist, url });
  return NextResponse.json({ url });
}
