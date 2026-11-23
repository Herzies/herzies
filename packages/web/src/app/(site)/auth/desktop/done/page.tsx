import type { Metadata } from "next";
import { CopyLink } from "./CopyLink";

export const metadata: Metadata = {
  title: "Signed in",
};

const SITE = "https://www.herzies.app";
const DISCORD = "https://discord.gg/DxECVqT5sh";

/**
 * Where the browser ends up after a desktop login: the app's loopback
 * listener takes the session, then redirects here (see auth.rs). The app
 * already has everything it needs, so this page only says so, and asks
 * the newly signed-in player to bring a friend while they're excited.
 */
export default function DesktopLoginDonePage() {
  return (
    <div className="w-full max-w-[380px] px-6 py-12 flex flex-col items-center gap-8 text-center">
      <div className="relative">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 scale-125 rounded-full bg-purple/30 blur-3xl"
        />
        {/* biome-ignore lint/performance/noImgElement: Next serves app/icon.png at /icon.png; next/image adds nothing at this size. */}
        <img
          src="/icon.png"
          alt="Herzies"
          width={112}
          height={112}
          className="animate-float drop-shadow-[0_16px_24px_rgb(0_0_0/0.45)]"
        />
      </div>

      <div>
        <h1 className="text-xl font-bold text-purple mb-2">you're in!</h1>
        <p className="text-[13px] text-text-dim leading-relaxed">
          your herzie is waiting in the app.
          <br />
          you can close this tab.
        </p>
      </div>

      <section className="w-full bg-bg-panel border border-border rounded-2xl p-5 flex flex-col gap-4 text-left">
        <div>
          <h2 className="text-[13px] font-bold text-text mb-1">
            bring a friend
          </h2>
          <p className="text-xs text-text-dim leading-relaxed">
            herzies are better together: trade items, duel, and take on bosses
            in the Town.
          </p>
        </div>

        <CopyLink url={SITE} />

        <a
          href={DISCORD}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full py-2.5 border border-border rounded text-[13px] font-bold text-text flex items-center justify-center gap-2 hover:no-underline hover:border-purple transition-colors"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.1.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          join the Discord
        </a>
      </section>
    </div>
  );
}
