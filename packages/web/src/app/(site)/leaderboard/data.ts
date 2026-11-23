import type { SupabaseClient } from "@supabase/supabase-js";

export interface HerzieRow {
  name: string;
  stage: number;
  level: number;
  appearance: {
    headIndex: number;
    eyesIndex: number;
    mouthIndex: number;
    accessoryIndex: number;
    limbsIndex?: number;
    bodyIndex?: number;
    legsIndex?: number;
    colorScheme: string;
  };
  total_minutes_listened: number;
  genre_minutes: Record<string, number>;
}

/** The top 100 herzies by XP, for the server's first render and the
 * browser's polling alike. Null when the query fails. */
export async function fetchLeaderboard(
  supabase: SupabaseClient,
): Promise<HerzieRow[] | null> {
  const { data, error } = await supabase
    .from("herzies")
    .select(
      "name, stage, level, xp, appearance, total_minutes_listened, genre_minutes",
    )
    .order("xp", { ascending: false })
    .limit(100);
  return error ? null : ((data ?? []) as HerzieRow[]);
}
