import type { Metadata } from "next";
import { Hero } from "@/components/landing/Hero";

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

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Hero />
    </>
  );
}
