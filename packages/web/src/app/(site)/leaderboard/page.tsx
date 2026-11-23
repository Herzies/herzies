import { createClient } from "@supabase/supabase-js";
import type { Metadata } from "next";
import Container from "@/components/container";
import { fetchLeaderboard } from "./data";
import { Leaderboard } from "./Leaderboard";

export const metadata: Metadata = {
  title: "Leaderboard",
  description:
    "Top herzies ranked by XP. See who's listened the most and evolved the furthest.",
  alternates: { canonical: "https://www.herzies.app/leaderboard" },
};

/** The board is rendered on the server at most this often (seconds), so
 * crawlers see it; the browser polls for the rest. */
export const revalidate = 60;

export default async function LeaderboardPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const initialRows = await fetchLeaderboard(supabase);

  return (
    <Container>
      <section className="py-8">
        <h1 className="text-lg text-purple mb-1">leaderboard</h1>
        <p className="text-xs text-text-dim">Ranked by exp.</p>
      </section>

      <Leaderboard initialRows={initialRows} />
    </Container>
  );
}
