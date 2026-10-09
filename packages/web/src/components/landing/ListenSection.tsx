"use client";

import { HerzieView } from "@herzies/shared/gl";
import { type RefObject, useRef } from "react";
import { gsap, useGSAP } from "./gsap";
import { canvasSize, OUR_SEED } from "./journey";
import { PinnedFrame, SectionFrame, SectionText } from "./SectionText";
import { useReveal } from "./useReveal";
import { useWide } from "./useWide";

const STAGES = [1, 2, 3] as const;
const COLS = 56;
/** One screen of scrolling per stage. */
const PIN_SCREENS = STAGES.length;
/** Each stage's growing-in, as a share of its screen; the rest is a pause
 * with it grown, before the next one starts. */
const GROW = 0.7;

/**
 * Listen and grow: the herzie at each stage it grows through.
 *
 * With `travel`, the section holds still for a screen of scrolling per
 * stage, growing each one in on its own screen (scrubbed, so they shrink
 * back on the way up). The stage 3 herzie isn't drawn here: this leaves an
 * empty placeholder (`travel.slot`) for the one that follows you down the
 * page (HerzieJourney), and grows that one (`travel.grow`) as stage 3.
 * Without it — reduced motion, or before the page is running — all three
 * simply stand there.
 */
export function ListenSection({
  travel,
}: {
  travel?: {
    slot: RefObject<HTMLDivElement | null>;
    grow: RefObject<HTMLDivElement | null>;
  };
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useReveal(ref);
  const wide = useWide();
  const size = wide ? 4 : 2.6;

  useGSAP(
    () => {
      if (!travel) return;
      const stages = gsap.utils.toArray<HTMLElement>("[data-stage]");
      if (travel.grow.current) stages.push(travel.grow.current);
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: ref.current,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.5,
        },
      });
      stages.forEach((stage, i) => {
        tl.from(
          stage,
          {
            x: -160,
            scale: 0.5,
            autoAlpha: 0,
            duration: GROW,
            ease: "power2.out",
          },
          i,
        );
      });
      // Pad the last screen, so stage 3 also has its pause.
      tl.to({}, { duration: 1 - GROW }, stages.length - 1 + GROW);
    },
    { scope: ref, dependencies: [travel], revertOnUpdate: true },
  );

  const content = (
    <div className="flex flex-col items-center gap-10">
      <SectionText preTitle="Listen" title="Listen and grow">
        <p>Your herzie grows for every song you listen to.</p>
      </SectionText>

      <div className="flex items-end justify-center gap-3 md:gap-6">
        {STAGES.map((stage) =>
          stage === 3 && travel ? (
            <div key={stage} ref={travel.slot} style={canvasSize(size, COLS)} />
          ) : (
            <div key={stage} data-stage="">
              <HerzieView
                userId={OUR_SEED}
                stage={stage}
                size={size}
                cols={COLS}
                groundInset={8}
                draggable={false}
                paused={!active}
                ariaLabel={`The same herzie at stage ${stage}`}
              />
            </div>
          ),
        )}
      </div>
    </div>
  );

  if (!travel) return <SectionFrame ref={ref}>{content}</SectionFrame>;

  return (
    <PinnedFrame ref={ref} screens={PIN_SCREENS}>
      {content}
    </PinnedFrame>
  );
}
