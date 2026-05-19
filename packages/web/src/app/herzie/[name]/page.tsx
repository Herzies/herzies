import type { Metadata } from "next";
import { createSupabaseClient } from "@/lib/supabase";
import { HerzieDetail } from "./HerzieDetail";

interface Props {
  params: Promise<{ name: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const title = `${decoded} — herzies`;
  const description = `View ${decoded}'s herzie profile — stats, level, and listening history.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "profile",
      url: `https://www.herzies.app/herzie/${encodeURIComponent(decoded)}`,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function HerziePage({ params }: Props) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  const supabase = createSupabaseClient();
  const { data } = await supabase
    .from("herzies")
    .select(
      "user_id, name, stage, level, xp, appearance, total_minutes_listened, genre_minutes, friend_code, friend_codes, now_playing, created_at, equipped",
    )
    .ilike("name", decoded)
    .single();

  if (!data) {
    return (
      <main className="max-w-[800px] mx-auto px-6 py-12 text-center">
        <p className="text-text-dim text-sm">no herzie found with that name.</p>
      </main>
    );
  }

  // Fetch recent tracks and all listen log for top artists
  const [{ data: recentTracks }, { data: allPlays }] = await Promise.all([
    supabase
      .from("listen_log")
      .select("track_name, artist_name, listened_at")
      .eq("user_id", data.user_id)
      .order("listened_at", { ascending: false })
      .limit(3),
    supabase
      .from("listen_log")
      .select("artist_name")
      .eq("user_id", data.user_id),
  ]);

  // Aggregate top 3 artists client-side
  const artistCounts: Record<string, number> = {};
  for (const row of allPlays ?? []) {
    artistCounts[row.artist_name] = (artistCounts[row.artist_name] ?? 0) + 1;
  }
  const topArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, plays]) => ({ name, plays }));

  return (
    <HerzieDetail
      herzie={data}
      recentTracks={recentTracks ?? []}
      topArtists={topArtists}
    />
  );
}
