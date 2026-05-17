import { Herzie3D, Sky } from "@herzies/shared";
import type { Metadata } from "next";
import Link from "next/link";
import BetaLeadForm from "@/components/beta-lead-form";
import Button from "@/components/button";
import Container from "@/components/container";
import { DesktopEventsPreview } from "@/components/DesktopEventsPreview";
import { DesktopHomePreview } from "@/components/DesktopHomePreview";
import { DesktopInventoryPreview } from "@/components/DesktopInventoryPreview";
import TextAndMedia from "@/components/text-and-media";

export const metadata: Metadata = {
  title: "Herzies — Your digital pet that grows by listening to music",
  description:
    "Hatch your herzie, play music, and watch it evolve. A digital pet powered by your listening habits. Works with Apple Music and Spotify on macOS.",
  alternates: { canonical: "https://www.herzies.app" },
};

const BANNER = `\
 _                   _
| |                 (_)
| |__   ___ _ __ _____  ___  ___
| '_ \\ / _ \\ '__|_  / |/ _ \\/ __|
| | | |  __/ |   / /| |  __/\\__ \\
|_| |_|\\___|_|  /___|_|\\___||___/`;

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Herzies",
  applicationCategory: "EntertainmentApplication",
  operatingSystem: "macOS",
  description:
    "Your digital pet that grows by listening to music. Works with Apple Music and Spotify.",
  url: "https://www.herzies.app",
  installUrl: "https://www.npmjs.com/package/herzies",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Container>
        <section className="relative hero text-center md:min-h-[60dvh] flex flex-col justify-center pt-16">
          <h1 className="sr-only">
            Herzies — Your digital pet that grows by listening to music
          </h1>

          <pre
            className="banner text-purple leading-tight mx-auto mb-4 whitespace-pre table text-left"
            aria-hidden="true"
          >
            {BANNER}
          </pre>

          <p className="text-[13px] text-text-dim mb-2">
            Your digital pet <br /> that grows by listening to music.
          </p>

          <Link href="#beta" className="inline mt-6">
            <Button className="inline">Early access</Button>
          </Link>

          <div className="absolute bottom-0 right-0 translate-y-[110px] md:translate-y-[50px] translate-x-[80px]">
            <Herzie3D
              userId="e"
              stage={2}
              size={4}
              ariaLabel="A stage 2 herzie"
              draggable={false}
              defaultAngle={0}
            />
          </div>

          <div className="hidden sm:block absolute top-0 left-0 translate-x-[-100px]">
            <Herzie3D
              userId="t"
              stage={1}
              size={4}
              ariaLabel="A stage 2 herzie"
              draggable={false}
              defaultAngle={100}
            />
          </div>
        </section>
      </Container>

      <Container className="pb-8 md:pb-12">
        <TextAndMedia
          preTitle="Listen"
          title="Your Herzie is unique"
          description="Every Herzie is different. Your Herzie grows with every track you listen to. Daily streaks, and friends give bonus XP."
          media={<DesktopHomePreview />}
          position="left"
        />

        <TextAndMedia
          preTitle="Collect"
          title="Collect rare items"
          description="Every track you play has a chance to drop something. Cards, gear, oddities — equip your favorites or trade them with the Herzies community."
          media={<DesktopInventoryPreview />}
          position="right"
        />

        <TextAndMedia
          preTitle="Discover"
          title="Participate in events"
          description="Join secret song hunts, receive rewards, and discover new music."
          media={<DesktopEventsPreview />}
          position="left"
        />
      </Container>

      <Container className="">
        <section id="beta" className="py-16 sm:py-24">
          <BetaLeadForm />
        </section>
      </Container>
    </>
  );
}
