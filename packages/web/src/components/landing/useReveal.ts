"use client";

import { type RefObject, useState } from "react";
import { gsap, MOTION_OK, ScrollTrigger, useGSAP } from "./gsap";

/** How far (px) a revealed element travels in from its side. */
const DISTANCE = 120;

/**
 * Slides a section's `[data-reveal="left" | "right" | "up"]` elements in
 * from that side as the section scrolls into view, and back out when it is
 * scrolled back above. `data-reveal-delay` (seconds) staggers them.
 *
 * The starting positions are set by `gsap.from` once the page is running,
 * never by CSS, so the server-rendered page shows everything in place (for
 * search engines, and for anyone without JavaScript).
 *
 * Returns whether the section is on screen at all, for pausing the herzies
 * inside it while it isn't: a page of them would otherwise all keep
 * animating at once.
 */
export function useReveal(
  scope: RefObject<HTMLElement | null>,
  { initiallyActive = false }: { initiallyActive?: boolean } = {},
) {
  const [active, setActive] = useState(initiallyActive);

  useGSAP(
    () => {
      const section = scope.current;
      if (!section) return;

      ScrollTrigger.create({
        trigger: section,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => setActive(self.isActive),
      });

      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => {
        for (const el of section.querySelectorAll<HTMLElement>(
          "[data-reveal]",
        )) {
          const side = el.dataset.reveal;
          gsap.from(el, {
            x: side === "left" ? -DISTANCE : side === "right" ? DISTANCE : 0,
            y: side === "up" ? DISTANCE / 2 : 0,
            autoAlpha: 0,
            duration: 1,
            ease: "power3.out",
            delay: Number(el.dataset.revealDelay ?? 0),
            scrollTrigger: {
              trigger: section,
              start: "top 65%",
              toggleActions: "play none none reverse",
            },
          });
        }
      });
    },
    { scope },
  );

  return active;
}
