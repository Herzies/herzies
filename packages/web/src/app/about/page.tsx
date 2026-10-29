import type { Metadata, Viewport } from "next";
import { AboutSections } from "@/components/about/AboutSections";
import { SkyClouds } from "@/components/about/SkyClouds";
import { StageHost } from "@/components/about/StageHost";

export const metadata: Metadata = {
  title: "About",
  description:
    "Herzies is a nostalgic blend of virtual pet keeping and rpg games, with music listening on top.",
};

/** The sky this page sits in (--color-sky in globals.css). */
export const viewport: Viewport = {
  themeColor: "#a9cbe8",
  colorScheme: "light",
};

export default function AboutPage() {
  return (
    // Full width, so the clouds cross the whole window; the words keep to
    // the middle.
    <div data-sky="" className="relative w-full">
      <SkyClouds />
      <StageHost />
      <div className="mx-auto flex max-w-[900px] flex-col gap-24 px-4 py-12 sm:px-6 md:gap-32 md:py-20">
        <section className="mx-auto max-w-2xl text-center">
          <h1 className="mb-6 text-3xl font-bold text-purple md:text-5xl">
            about
          </h1>
          <p className="text-lg leading-relaxed text-text md:text-xl">
            Herzies is{" "}
            <a
              href="https://slowtaxi.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan"
            >
              my
            </a>{" "}
            passion project. It's a nostalgic blend of virtual pet keeping and
            rpg games. Think Tamagotchi meets World of Warcraft aaand sprinkle
            some music listening mechanics on top.
          </p>
        </section>

        <AboutSections />
      </div>
    </div>
  );
}
