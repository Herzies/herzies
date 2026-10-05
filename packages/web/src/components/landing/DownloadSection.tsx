"use client";

import { useEffect, useRef, useState } from "react";
import DownloadButtons from "@/components/DownloadButtons";
import { SECTION_TEXT, SECTION_TITLE, SectionFrame } from "./SectionText";
import { useReveal } from "./useReveal";

/** The room the site footer takes below the page, margin included. */
function useFooterHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const footer = document.querySelector("body > footer");
    if (!(footer instanceof HTMLElement)) return;
    const measure = () =>
      setHeight(
        footer.offsetHeight +
          Number.parseFloat(getComputedStyle(footer).marginTop || "0"),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    // The margin changes at a breakpoint without resizing the footer.
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return height;
}

/** The last screen: the download buttons. It's shorter than the others by
 * the footer's height, so that it and the footer together fill exactly one
 * screen, and its content sits centred above the footer once you've
 * scrolled to the bottom. The download page is this same section. */
export function DownloadSection({
  page = false,
  children,
}: {
  /** On the download page, where this is the whole page: its heading is the
   * page's h1, and the header lies over it, so it too fills the screen. */
  page?: boolean;
  /** Small print under the buttons. */
  children?: React.ReactNode;
}) {
  const Heading = page ? "h1" : "h2";
  const ref = useRef<HTMLElement>(null);
  useReveal(ref);
  const footerHeight = useFooterHeight();

  return (
    <SectionFrame
      ref={ref}
      id="download"
      overlayHeader={page}
      style={{ minHeight: `calc(100dvh - ${footerHeight}px)` }}
    >
      <div className="flex flex-col items-center text-center">
        <div data-reveal="up" className={SECTION_TEXT}>
          <p className="mb-2 text-sm uppercase tracking-widest text-text-dim">
            Open beta
          </p>
          <Heading className={SECTION_TITLE}>Download Herzies</Heading>
          <p className="mx-auto mb-8 max-w-sm text-sm text-text-dim">
            Free for macOS and Windows. Hatch your herzie and press play.
          </p>
        </div>
        <div
          data-reveal="up"
          data-reveal-delay="0.1"
          className="flex flex-col items-center"
        >
          <DownloadButtons />
          {children}
        </div>
      </div>
    </SectionFrame>
  );
}
