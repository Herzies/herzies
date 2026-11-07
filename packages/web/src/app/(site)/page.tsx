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
  description:
    "Hatch your herzie, play music, and watch it evolve. A digital pet powered by your listening habits. Works with Apple Music and Spotify on macOS and Windows.",
  alternates: { canonical: "https://www.herzies.app" },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Herzies",
  applicationCategory: "EntertainmentApplication",
  operatingSystem: "macOS, Windows",
  description:
    "Your digital pet that grows by listening to music. Works with Apple Music and Spotify.",
  url: "https://www.herzies.app",
  installUrl: "https://github.com/Herzies/herzies/releases/latest",
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
