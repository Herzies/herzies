import type { Metadata } from "next";
import Container from "@/components/container";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Herzies terms of service, data collection, and account deletion.",
};

export default function TermsPage() {
  return (
    <Container className="py-4 md:py-6 lg:py-8 flex flex-col gap-6 md:gap-8">
      <section>
        <h1 className="text-lg text-purple mb-1">terms of service</h1>
        <p className="text-xs text-text-dim">// the fine print</p>
      </section>

      <section>
        <h2 className="text-base text-cyan mb-1">data &amp; privacy</h2>
        <p className="text-xs text-text-dim">// what we collect</p>
        <div className="bg-bg-panel border border-border rounded-md p-4 flex flex-col gap-3 mt-3">
          <p className="text-[13px]">
            Herzies collects only what it needs to work. When you register and
            sync, the following is stored:
          </p>
          <ul className="text-[13px] pl-5 flex flex-col gap-1">
            <li>Your email address (for authentication)</li>
            <li>Your herzie's name, level, stage, XP, and appearance</li>
            <li>Total minutes listened and a breakdown by genre</li>
            <li>
              Your listening history — song titles, artist names, and when you
              listened to them
            </li>
            <li>Your friend code and friend list</li>
            <li>Items and event progress</li>
            <li>Daily streak data</li>
          </ul>
          <p className="text-[13px]">
            We store your listening history so you can see stats like your
            recently played tracks and top artists. Your listening history and
            currently playing track are private — only you and the friends you
            add can see them. The public leaderboard only shows aggregate stats
            like level and total minutes listened, never what you're playing.
          </p>
          <p className="text-[13px]">
            We do <span className="font-bold">not</span> sell or share your data
            with anyone. All data is processed by the herzies game server and
            stored securely.
          </p>
          <p className="text-[13px]">
            If you don't register, everything stays local on your machine in{" "}
            <code className="text-xs text-text-dim">~/.config/herzies/</code>{" "}
            and nothing is sent anywhere.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-base text-red mb-1">delete your data</h2>
        <p className="text-xs text-text-dim">// the nuclear option</p>
        <div className="bg-bg-panel border border-border rounded-md p-4 flex flex-col gap-3 mt-3">
          <p className="text-[13px]">
            You can permanently delete your herzie and all associated data from
            our servers. This removes your account, herzie stats, listening
            history, friend connections, and leaderboard entry. This action is
            irreversible.
          </p>
          <p className="text-[13px]">
            To delete your herzie, log in through the CLI and run{" "}
            <code className="text-xs text-text-dim">herzies kill</code>. Your
            local data will be removed as well.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-base text-text mb-1">usage</h2>
        <p className="text-xs text-text-dim">// the basics</p>
        <div className="bg-bg-panel border border-border rounded-md p-4 flex flex-col gap-3 mt-3">
          <p className="text-[13px]">
            Herzies is provided as-is. We reserve the right to remove accounts
            that abuse the service. By signing in, you agree to these terms.
          </p>
        </div>
      </section>
    </Container>
  );
}
