import type { Metadata } from "next";
import Container from "@/components/container";
import { Leaderboard } from "./Leaderboard";

export const metadata: Metadata = {
  title: "Leaderboard",
  description:
    "Top herzies ranked by XP. See who's listened the most and evolved the furthest.",
};

export default function LeaderboardPage() {
  return (
    <Container>
      <section className="py-8">
        <h1 className="text-lg text-purple mb-1">leaderboard</h1>
        <p className="text-xs text-text-dim">Ranked by exp.</p>
      </section>

      <Leaderboard />
    </Container>
  );
}
