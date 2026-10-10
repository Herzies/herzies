"use client";

import { HerzieView } from "@herzies/shared/gl";
import Link from "next/link";
import Button from "@/components/button";

const BANNER = `\
 _                   _
| |                 (_)
| |__   ___ _ __ _____  ___  ___
| '_ \\ / _ \\ '__|_  / |/ _ \\/ __|
| | | |  __/ |   / /| |  __/\\__ \\
|_| |_|\\___|_|  /___|_|\\___||___/`;

/** The first screen: the banner, the one-line pitch and the download
 * button, with a herzie either side. `data-overlay-header` lays the
 * site header over it (see globals.css), and the hero fills the rest of the
 * screen above the footer: the page fits without scrolling. */
export function Hero() {
  return (
    <section
      data-overlay-header=""
      className="relative flex flex-1 w-full items-center overflow-x-clip"
    >
      <div className="relative mx-auto flex w-5xl max-w-full flex-col justify-center px-4 pt-16 text-center sm:px-6 md:px-8">
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

        <div>
          <Link
            href="/download"
            className="mt-6 inline-block no-underline hover:no-underline"
          >
            <Button className="inline">Download Herzies</Button>
          </Link>
        </div>

        <div className="absolute bottom-0 right-0 translate-y-[110px] md:translate-y-[50px] translate-x-[80px]">
          <HerzieView
            userId="e"
            stage={2}
            size={4}
            ariaLabel="A stage 2 herzie"
            draggable={false}
            defaultAngle={0}
          />
        </div>

        <div className="hidden sm:block absolute top-0 left-0 translate-x-[-100px]">
          <HerzieView
            userId="t"
            stage={1}
            size={4}
            ariaLabel="A stage 1 herzie"
            draggable={false}
            defaultAngle={100}
          />
        </div>
      </div>
    </section>
  );
}
