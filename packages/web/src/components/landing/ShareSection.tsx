"use client";

import type { Equipped } from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { type RefObject, useRef } from "react";
import { gsap, useGSAP } from "./gsap";
import {
  canvasSize,
  companionSize,
  FACE_LEFT,
  FACE_RIGHT,
  OUR_COLS,
  OUR_SEED,
  outfitFor,
  PICKS,
} from "./journey";
import { PinnedFrame, SectionFrame, SectionText } from "./SectionText";
import { useReveal } from "./useReveal";
import { useWide } from "./useWide";

/** Your two friends, either side of your herzie, each turned toward it. */
const FRIENDS: Record<
  "left" | "right",
  { seed: string; stage: number; angle: number; equipped?: Equipped }
> = {
  left: { seed: "landing-friend-mochi", stage: 2, angle: FACE_RIGHT },
  right: {
    seed: "landing-friend-fern",
    stage: 1,
    angle: FACE_LEFT,
    // Purple, so it doesn't read as a tiny copy of your (blue) herzie.
    equipped: { color: "purple-dane" },
  },
};

/** The song the left friend shares with you. */
const SHARED_SONG = "Midnight City — M83";

/** Screens of scrolling the section holds still for, one per step: the
 * friends arrive, the song is shared, your herzie dances. */
const PIN_SCREENS = 3;
/** Each step's movement, as a share of its screen; the rest is a pause. */
const STEP = 0.7;

/**
 * Share and discover music: your herzie between two friends.
 *
 * With `travel`, your herzie is the travelling one (HerzieJourney), landed
 * over the empty `travel.slot`, and the section holds still for a screen
 * per step as you scroll: the friends slide in, the left one shares a song
 * — its title flies over to your herzie — and your herzie starts dancing to
 * it (`travel.onDancing`). Without it — reduced motion, or before the page
 * is running — everyone simply stands there, the shared song over yours.
 */
export function ShareSection({
  travel,
}: {
  travel?: {
    slot: RefObject<HTMLDivElement | null>;
    onDancing: (dancing: boolean) => void;
  };
}) {
  const ref = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const songRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const oursRef = useRef<HTMLDivElement>(null);
  const active = useReveal(ref);
  const wide = useWide();
  const friendSize = wide ? 4 : 3;
  const oursSize = companionSize(wide);
  const dancing = useRef(false);

  // The steps, scrubbed by the scroll while the section holds still.
  useGSAP(
    () => {
      if (!travel) return;
      const song = songRef.current;
      const from = leftRef.current;
      const to = oursRef.current;
      const row = rowRef.current;
      if (!song || !from || !to || !row) return;
      /** Where the song sits over a herzie: centred on it, in the row. */
      const over = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return r.left + r.width / 2 - rowBox.left - song.offsetWidth / 2;
      };
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: ref.current,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.5,
          invalidateOnRefresh: true,
        },
        onUpdate: () => {
          // Dancing once the song has reached your herzie.
          const now = tl.time() >= 1 + STEP;
          if (now !== dancing.current) {
            dancing.current = now;
            travel.onDancing(now);
          }
        },
      });
      // 1. The friends slide in from either side.
      tl.from(
        "[data-friend='left']",
        { x: -240, autoAlpha: 0, duration: STEP, ease: "power2.out" },
        0,
      );
      tl.from(
        "[data-friend='right']",
        { x: 240, autoAlpha: 0, duration: STEP, ease: "power2.out" },
        0,
      );
      // 2. The song pops up over the left friend and flies to yours.
      tl.fromTo(
        song,
        {
          x: () => over(from),
          // Down over the friend's head, which is much lower than yours.
          y: wide ? 100 : 65,
          autoAlpha: 0,
          scale: 0.6,
        },
        { autoAlpha: 1, scale: 1, duration: STEP * 0.25, ease: "back.out(2)" },
        1,
      );
      // A curve: it glides across at an even pace while it rises over the
      // heads and comes back down onto yours.
      const flight = STEP * 0.75;
      tl.to(
        song,
        { x: () => over(to), duration: flight, ease: "sine.inOut" },
        1 + STEP * 0.25,
      );
      tl.to(
        song,
        {
          // Only a little above where it lands: any higher and it runs into
          // the copy above.
          y: wide ? -18 : -12,
          duration: flight / 2,
          ease: "power2.out",
        },
        1 + STEP * 0.25,
      );
      tl.to(
        song,
        { y: 0, duration: flight / 2, ease: "power2.in" },
        1 + STEP * 0.25 + flight / 2,
      );
      // 3. Your herzie dances (see onUpdate); the last screen just holds.
      tl.to({}, { duration: 1 }, 2);
    },
    { scope: ref, dependencies: [travel, wide], revertOnUpdate: true },
  );

  const friend = (side: "left" | "right") => {
    const f = FRIENDS[side];
    return (
      <div ref={side === "left" ? leftRef : undefined} data-friend={side}>
        <HerzieView
          userId={f.seed}
          stage={f.stage}
          size={friendSize}
          // Wide enough that a friend turned toward yours keeps its edges.
          cols={60}
          groundInset={8}
          defaultAngle={f.angle}
          equipped={f.equipped}
          draggable={false}
          paused={!active}
          ariaLabel="A friend's herzie"
        />
      </div>
    );
  };

  const content = (
    <div className="flex flex-col items-center gap-6">
      <SectionText preTitle="Discover" title="Share and discover music">
        <p>
          Add your friends and see what they&apos;re listening to right now.
        </p>
      </SectionText>

      {/* Pulled up into the canvases' empty headroom (the herzies stand at
          the bottom of tall canvases), so they sit close under the copy. */}
      <div ref={rowRef} className="relative -mt-10 md:-mt-16">
        {/* The shared song. Starts over your herzie; while travelling, the
            steps above fly it there from the left friend. */}
        <div
          ref={songRef}
          className="absolute left-0 z-10 rounded-full border border-cyan/40 bg-bg-panel px-3 py-1 text-[12px] whitespace-nowrap text-cyan"
          style={{
            // Just over the heads: your stage 3 herzie is the tallest.
            bottom: wide ? 190 : 130,
            ...(travel ? {} : { left: "50%", transform: "translateX(-50%)" }),
          }}
        >
          ♪ {SHARED_SONG}
        </div>

        <div className="flex items-end justify-center gap-2 md:gap-6">
          {friend("left")}
          <div ref={oursRef} className="flex flex-col items-center">
            {travel ? (
              <div ref={travel.slot} style={canvasSize(oursSize, OUR_COLS)} />
            ) : (
              <HerzieView
                userId={OUR_SEED}
                stage={3}
                size={oursSize}
                cols={OUR_COLS}
                groundInset={8}
                equipped={outfitFor(PICKS.length)}
                draggable={false}
                paused={!active}
                ariaLabel="Your herzie"
              />
            )}
          </div>
          {friend("right")}
        </div>
      </div>
    </div>
  );

  if (!travel) {
    return <SectionFrame ref={ref}>{content}</SectionFrame>;
  }
  return (
    <PinnedFrame ref={ref} screens={PIN_SCREENS}>
      {content}
    </PinnedFrame>
  );
}
