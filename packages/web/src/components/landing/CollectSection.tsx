"use client";

import { Herzie3D, ItemCard } from "@herzies/shared";
import { type RefObject, useRef } from "react";
import { getCardIllustration } from "@/lib/card-art";
import { gsap, useGSAP } from "./gsap";
import { canvasSize, OUR_COLS, OUR_SEED, outfitFor, PICKS } from "./journey";
import { PinnedFrame, SectionFrame, SectionText } from "./SectionText";
import { useReveal } from "./useReveal";
import { useWide } from "./useWide";

/** How many screens of scrolling the cards take to place, all told. */
const PIN_SCREENS = 3;
/** Each card's flight, as a share of its third of the scroll; the rest is a
 * pause with it in place, so its item can be seen going on. */
const FLIGHT = 0.7;
/** How far through its flight a card looks landed. */
const LANDED = 0.8;

/** The size your herzie is drawn at in Collect (HerzieJourney draws the
 * travelling one at this size too, then scales it to fit elsewhere). */
export function collectHerzieSize(wide: boolean) {
  return wide ? 5 : 3.4;
}

/**
 * Collect and customise: three cards are placed, one by one, in the slots
 * left of your herzie, and each one's item goes on it as it lands.
 *
 * With `travel`, the section is several screens tall and holds still while
 * you scroll through it, flying a card in per screen and reporting how many
 * have landed (`travel.onPlaced`); the herzie itself is the travelling one,
 * standing over the empty `travel.slot`. Without it — reduced motion, or
 * before the page is running — it shows the end result: all three cards in
 * place, worn by a herzie drawn right here.
 */
export function CollectSection({
  travel,
}: {
  travel?: {
    slot: RefObject<HTMLDivElement | null>;
    onPlaced: (count: number) => void;
  };
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useReveal(ref);
  const wide = useWide();
  const herzieSize = canvasSize(collectHerzieSize(wide), OUR_COLS);
  const placed = useRef(0);

  useGSAP(
    () => {
      if (!travel) return;
      const cards = gsap.utils.toArray<HTMLElement>("[data-pick]");
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: ref.current,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.5,
        },
        onUpdate: () => {
          // A card counts once it looks landed (its eased flight has all but
          // settled by 80% of the way), so its item goes on with it.
          const count = cards.filter(
            (_, i) => tl.time() >= i + FLIGHT * LANDED,
          ).length;
          if (count !== placed.current) {
            placed.current = count;
            travel.onPlaced(count);
          }
        },
      });
      cards.forEach((card, i) => {
        tl.from(
          card,
          {
            // Two screens out, so it starts off screen at any width. The
            // card's zoom shrinks its moves too, so that's undone here.
            x: () =>
              (-2 * window.innerWidth) /
              (Number.parseFloat(card.style.zoom) || 1),
            y: 60,
            rotation: -25,
            duration: FLIGHT,
            ease: "power2.out",
          },
          i,
        );
      });
      // Pad the last third, so the last card also has its pause.
      tl.to({}, { duration: 1 - FLIGHT }, cards.length - 1 + FLIGHT);
    },
    { scope: ref, dependencies: [travel], revertOnUpdate: true },
  );

  const content = (
    <div className="flex flex-col items-center gap-8">
      <SectionText preTitle="Collect" title="Collect and customise">
        <p>Collect cards and customise your herzie.</p>
      </SectionText>

      {/* Phones put the herzie above the cards; wider screens put the
          cards on its left. */}
      <div className="flex flex-col-reverse items-center gap-6 md:flex-row md:items-end md:gap-10">
        <div className="flex gap-3 md:gap-4">
          {PICKS.map((pick) => (
            // The slot: a dashed outline the card lands on.
            <div key={pick.id} className="relative">
              <div className="absolute inset-0 rounded-lg border border-dashed border-border" />
              <div
                data-pick=""
                // zoom, not scale: it shrinks the layout box too, so the
                // slots are sized by the cards in them.
                style={{ zoom: wide ? 0.6 : 0.38 }}
              >
                <ItemCard
                  itemId={pick.id}
                  illustration={getCardIllustration(pick.id)}
                />
              </div>
            </div>
          ))}
        </div>

        {travel ? (
          <div ref={travel.slot} style={herzieSize} />
        ) : (
          <Herzie3D
            userId={OUR_SEED}
            stage={3}
            size={collectHerzieSize(wide)}
            cols={OUR_COLS}
            groundInset={8}
            equipped={outfitFor(PICKS.length)}
            draggable={false}
            paused={!active}
            ariaLabel="Your herzie, wearing headphones, a gold chain and a boombox"
          />
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
