import type { Metadata } from "next";
import { CopyBlock } from "./CopyBlock";

export const metadata: Metadata = {
  title: "Docs",
  description: "Commands and usage for the herzies CLI.",
};

const commands = [
  {
    name: "herzies",
    description:
      "Launch the live dashboard — your herzie dances while you listen to music and earns XP in real time.",
  },
  {
    name: "herzies hatch",
    description:
      "Hatch a new herzie with a random appearance. This is the first thing you run.",
  },
  {
    name: "herzies status",
    description:
      "Quick snapshot of your herzie — level, stage, XP, top genres, and friend code.",
  },
  {
    name: "herzies listen",
    description:
      "Start listening in the foreground — your herzie earns XP while the command is running.",
  },
  {
    name: "herzies login",
    description: "Log in to sync your herzie across devices.",
  },
  {
    name: "herzies friends",
    description: "List your friendzies.",
  },
  {
    name: "herzies friends add <code>",
    description: "Add a friendzie by their code. Friends give bonus XP.",
  },
  {
    name: "herzies friends remove <code>",
    description: "Remove a friendzie.",
  },
  {
    name: "herzies start",
    description:
      "Start background listening — your herzie earns XP without keeping a terminal open.",
  },
  {
    name: "herzies stop",
    description: "Stop background listening.",
  },
  {
    name: "herzies autostart on|off",
    description:
      "Auto-start the background daemon when you log in to your Mac.",
  },
  {
    name: "herzies kill",
    description: "Permanently delete your herzie and all local data.",
  },
];

export default function DocsPage() {
  return (
    <main className="max-w-[800px] mx-auto px-6 py-12 flex flex-col gap-6">
      <section>
        <h1 className="text-lg text-purple mb-1">docs</h1>
        <p className="text-xs text-text-dim">// commands and usage</p>
      </section>

      <section>
        <h2 className="text-sm text-cyan mb-2">get started</h2>
        <CopyBlock command="npm i -g herzies" />
      </section>

      <section>
        <h2 className="text-sm text-cyan mb-2">commands</h2>
        <div className="flex flex-col gap-2">
          {commands.map((cmd) => (
            <div
              key={cmd.name}
              className="bg-bg-panel border border-border rounded-md p-4"
            >
              <code className="text-[13px] text-green">{cmd.name}</code>
              <p className="text-xs text-text-dim mt-1">{cmd.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm text-cyan mb-2">requirements</h2>
        <div className="bg-bg-panel border border-border rounded-md p-4">
          <p className="text-[13px]">
            macOS with Apple Music or Spotify. Linux and Windows support is
            coming.
          </p>
        </div>
      </section>
    </main>
  );
}
