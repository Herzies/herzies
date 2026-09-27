import { normalizeTrack } from "@herzies/shared/server";
import type { createAdminClient } from "@/lib/supabase-admin";

type Admin = ReturnType<typeof createAdminClient>;

export type SongPoolEntry = {
  id: string;
  trackTitle: string;
  trackArtist: string;
  notes: string | null;
  createdAt: string;
  /** Title of the song hunt that has this song as its answer, if any. */
  usedBy: string | null;
};

const key = (artist: string, title: string) =>
  `${normalizeTrack(artist)}\u0000${normalizeTrack(title)}`;

/**
 * The song pool, oldest first, with each entry marked used when any song hunt
 * (proposed, approved or past) already has it as its answer — matched the same
 * way a play is matched to a hunt, so there is no "used" flag to keep in sync.
 */
export async function loadSongPool(admin: Admin): Promise<SongPoolEntry[]> {
  const [pool, hunts] = await Promise.all([
    admin
      .from("song_pool")
      .select("id, track_title, track_artist, notes, created_at")
      .order("created_at", { ascending: true }),
    admin
      .from("events")
      .select("title, config")
      .eq("type", "song_hunt")
      .order("starts_at", { ascending: true }),
  ]);
  if (pool.error) throw new Error(pool.error.message);

  const usedBy = new Map<string, string>();
  for (const h of hunts.data ?? []) {
    const c = h.config as Record<string, unknown>;
    if (typeof c.trackTitle === "string" && typeof c.trackArtist === "string") {
      const k = key(c.trackArtist, c.trackTitle);
      if (!usedBy.has(k)) usedBy.set(k, h.title as string);
    }
  }

  return (pool.data ?? []).map((row) => ({
    id: row.id as string,
    trackTitle: row.track_title as string,
    trackArtist: row.track_artist as string,
    notes: (row.notes as string | null) ?? null,
    createdAt: row.created_at as string,
    usedBy:
      usedBy.get(key(row.track_artist as string, row.track_title as string)) ??
      null,
  }));
}
