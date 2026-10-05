"use client";

import { Herzie3D } from "@herzies/shared";
import Link from "next/link";
import { useRef } from "react";
import Button from "@/components/button";
import { gsap, MOTION_OK, useGSAP } from "./gsap";
import { useReveal } from "./useReveal";

const BANNER = `\
 _                   _
| |                 (_)
| |__   ___ _ __ _____  ___  ___
| '_ \\ / _ \\ '__|_  / |/ _ \\/ __|
| | | |  __/ |   / /| |  __/\\__ \\
|_| |_|\\___|_|  /___|_|\\___||___/`;

/** The first screen: the banner, the one-line pitch and the download
 * button, with two herzies sliding in from either side as the page loads.
 * `data-overlay-header` lays the site header over it (see globals.css), so
 * the hero alone fills the screen. */
export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const active = useReveal(ref, { initiallyActive: true });

  useGSAP(
    () => {
      gsap.matchMedia().add(MOTION_OK, () => {
        gsap
          .timeline({ defaults: { duration: 1.2, ease: "power3.out" } })
          .from("[data-hero-copy]", { y: 24, autoAlpha: 0, stagger: 0.12 })
          .from("[data-hero-left]", { x: -200, autoAlpha: 0 }, 0.2)
          .from("[data-hero-right]", { x: 200, autoAlpha: 0 }, 0.35);
      });
    },
    { scope: ref },
  );

  return (
    <section
      ref={ref}
      data-overlay-header=""
      className="relative flex min-h-dvh w-full items-center overflow-x-clip"
    >
      <div className="relative mx-auto flex w-5xl max-w-full flex-col justify-center px-4 pt-16 text-center sm:px-6 md:px-8">
        <h1 className="sr-only">
          Herzies — Your digital pet that grows by listening to music
        </h1>

        <pre
          data-hero-copy=""
          className="banner text-purple leading-tight mx-auto mb-4 whitespace-pre table text-left"
          aria-hidden="true"
        >
          {BANNER}
        </pre>

        <p data-hero-copy="" className="text-[13px] text-text-dim mb-2">
          Your digital pet <br /> that grows by listening to music.
        </p>

        <div data-hero-copy="">
          <Link href="/download" className="inline-block mt-6">
            <Button className="inline">Download Herzies</Button>
          </Link>
        </div>

        <div
          data-hero-right=""
          className="absolute bottom-0 right-0 translate-y-[110px] md:translate-y-[50px] translate-x-[80px]"
        >
          <Herzie3D
            userId="e"
            stage={2}
            size={4}
            ariaLabel="A stage 2 herzie"
            draggable={false}
            defaultAngle={0}
            paused={!active}
          />
        </div>

        <div
          data-hero-left=""
          className="hidden sm:block absolute top-0 left-0 translate-x-[-100px]"
        >
          <Herzie3D
            userId="t"
            stage={1}
            size={4}
            ariaLabel="A stage 1 herzie"
            draggable={false}
            defaultAngle={100}
            paused={!active}
          />
        </div>
      </div>
    </section>
  );
}
