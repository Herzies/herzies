import type { Metadata, Viewport } from "next";
import { Hero } from "@/components/landing/Hero";
import { TownBackdrop } from "@/components/landing/TownBackdrop";
import { showcaseChampion } from "@/lib/town-champion";

/** The statue's champion is looked up at most this often (seconds): the
 * page is static between. */
export const revalidate = 600;

/** The Town server the backdrop watches (read-only). */
const TOWN_SERVER =
  process.env.TOWN_SERVER_URL ?? "wss://herzies-town.novasism.workers.dev";

/** What iOS Safari draws behind its status bar here: the sky blue the Town
 * fades into at the top (--color-sky in globals.css). */
export const viewport: Viewport = {
  themeColor: "#a9cbe8",
  colorScheme: "light",
};

export const metadata: Metadata = {
  title: "Herzies — Your digital pet that grows by listening to music",
  alternates: { canonical: "https://www.herzies.app" },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: "Herzies",
  applicationCategory: "GameApplication",
  genre: ["Virtual pet", "Idle game", "RPG"],
  gamePlatform: ["macOS", "Windows"],
  operatingSystem: "macOS 10.15+, Windows",
  playMode: ["SinglePlayer", "MultiPlayer"],
  description:
    "A free desktop pet that grows while you listen to music. It picks up what's playing in Spotify, Apple Music, Tidal and other players, turns listening time into XP and item drops, and lets you trade, duel and raid bosses with other herzies in a live multiplayer Town.",
  url: "https://www.herzies.app",
  image: "https://www.herzies.app/og.png?v=3",
  downloadUrl: "https://www.herzies.app/download",
  installUrl: "https://github.com/Herzies/herzies/releases/latest",
  sameAs: [
    "https://github.com/Herzies/herzies",
    "https://discord.gg/DxECVqT5sh",
  ],
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default async function Home() {
  const champion = await showcaseChampion();
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <TownBackdrop server={TOWN_SERVER} champion={champion} />
      <Hero />
    </>
  );
}
