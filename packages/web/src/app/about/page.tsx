import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description: "What herzies is and how it works.",
};

export default function AboutPage() {
  return (
    <main className="max-w-[800px] mx-auto px-6 py-12 flex flex-col gap-6">
      <section>
        <h1 className="text-lg text-purple mb-1">about</h1>
        <p className="text-xs text-text-dim">// what is this thing</p>
      </section>

      <div className="bg-bg-panel border border-border rounded-md p-4 flex flex-col gap-3">
        <p className="text-[13px]">
          Herzies is your digital pet that grows by listening to music. Hatch
          your herzie, play your favourite tracks, and watch it evolve through
          three stages. Every genre counts, friends give bonus XP, and daily
          cravings keep things interesting.
        </p>
        <p className="text-[13px]">
          Collect items from limited-time events, build daily listening streaks
          for bonus multipliers, and climb the leaderboard.
        </p>
      </div>

      <section>
        <h2 className="text-base text-cyan mb-1">how it works</h2>
        <p className="text-xs text-text-dim">// under the hood</p>
      </section>

      <div className="bg-bg-panel border border-border rounded-md p-4 flex flex-col gap-3">
        <p className="text-[13px]">
          The CLI detects what you're listening to and sends observations to the
          herzies game server. The server is the authority for XP, leveling,
          events, and items — the CLI never writes directly to the database.
        </p>
        <p className="text-[13px]">
          Without an account, everything stays local. Once you log in, your
          herzie syncs across devices and appears on the leaderboard.
        </p>
      </div>

      <div className="text-[13px] flex gap-4">
        <a href="/docs" className="text-cyan">
          docs
        </a>
        <a href="/terms" className="text-cyan">
          terms of service
        </a>
      </div>
    </main>
  );
}
