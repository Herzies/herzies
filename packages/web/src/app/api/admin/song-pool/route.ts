import { NextResponse } from "next/server";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { isParseError, parseBody, songPoolEntrySchema } from "@/lib/schemas";
import { loadSongPool } from "@/lib/song-pool";
import { createAdminClient } from "@/lib/supabase-admin";

/** Songs the weekly curator picks from (00085). */
export async function GET(request: Request) {
  if (!verifyAdmin(request)) return unauthorizedAdmin();
  try {
    return NextResponse.json({
      songs: await loadSongPool(createAdminClient()),
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch song pool" },
      { status: 500 },
    );
  }
}

/** Add a song to the pool. */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) return unauthorizedAdmin();

  const body = await parseBody(request, songPoolEntrySchema);
  if (isParseError(body)) return body;

  const { data, error } = await createAdminClient()
    .from("song_pool")
    .insert({
      track_title: body.trackTitle.trim(),
      track_artist: body.trackArtist.trim(),
      notes: body.notes?.trim() || null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505: the unique (artist, title) index.
    const duplicate = error.code === "23505";
    return NextResponse.json(
      {
        error: duplicate
          ? "That song is already in the pool"
          : "Failed to add song",
      },
      { status: duplicate ? 409 : 500 },
    );
  }
  return NextResponse.json({ id: data.id }, { status: 201 });
}

/** Remove a song from the pool. */
export async function DELETE(request: Request) {
  if (!verifyAdmin(request)) return unauthorizedAdmin();

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "id query param is required" },
      { status: 400 },
    );
  }

  const { error } = await createAdminClient()
    .from("song_pool")
    .delete()
    .eq("id", id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to remove song" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
