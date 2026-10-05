"use client";

import {
  BOSS_BODY_TYPE,
  type CreatureParams,
  DEFAULT_Y_ANGLE,
  type Equipped,
  generateCreatureParams,
  Herzie3D,
  ORPHIEZ_EQUIPPED,
  SpeechBubble,
  VISITORS,
} from "@herzies/shared";
import { type RefObject, useRef, useState } from "react";
import { ScrollTrigger, useGSAP } from "./gsap";
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

/** Screens of scrolling a visitor's section holds still for, once your
 * herzie has landed in it. */
const PIN_SCREENS = 2;
/** How much of that the line takes to type out; it then stays up. */
const TYPE_SHARE = 0.6;

function PinnedVisitorFrame({
  children,
  ref,
}: {
  children: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <PinnedFrame ref={ref} screens={PIN_SCREENS}>
      {children}
    </PinnedFrame>
  );
}

/** A boss is seeded from its event; this one stands in for all of them. */
const BOSS_SEED = "boss:landing";
const BOSS_PARAMS: CreatureParams = {
  ...generateCreatureParams(BOSS_SEED),
  bodyType: BOSS_BODY_TYPE,
};

/** Your herzie beside a visitor: on which side, turned how far toward
 * them, and — while it's travelling down the page (HerzieJourney) — the
 * empty placeholder it stands over instead of being drawn here. */
export interface Companion {
  side: "left" | "right";
  angle: number;
  slot?: RefObject<HTMLDivElement | null>;
}

/** One of the Town's visitors, given a screen of its own: the copy, then the
 * visitor drawn as the desktop app draws them — square-on and still —
 * saying `line` in the app's speech bubble, with your herzie beside them.
 * While your herzie is travelling, the section holds still for a while once
 * it lands, and the line types out as you scroll. */
function VisitorSection({
  preTitle,
  title,
  children,
  name,
  line,
  seed,
  stage,
  equipped,
  creatureParams,
  size,
  from,
  companion,
}: {
  preTitle: string;
  title: string;
  children: React.ReactNode;
  name: string;
  line: string;
  seed: string;
  stage: number;
  equipped?: Equipped;
  creatureParams?: CreatureParams;
  /** Cell size on wide screens and on phones. */
  size: { wide: number; narrow: number };
  from: "left" | "right";
  companion: Companion;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useReveal(ref);
  const wide = useWide();
  const ours = canvasSize(companionSize(wide), OUR_COLS);

  // While your herzie is travelling, the section holds still once it has
  // landed, and the visitor's line types out as you scroll on (scrubbed, so
  // it un-types on the way back up). Otherwise the line simply stands there.
  const travelling = Boolean(companion.slot);
  const [typed, setTyped] = useState(0);
  useGSAP(
    () => {
      if (!travelling) return;
      ScrollTrigger.create({
        trigger: ref.current,
        start: "top top",
        end: "bottom bottom",
        onUpdate: (self) => {
          const t = Math.min(1, self.progress / TYPE_SHARE);
          setTyped(Math.round(t * line.length));
        },
      });
    },
    { scope: ref, dependencies: [travelling, line], revertOnUpdate: true },
  );
  const shown = travelling ? typed : line.length;
  const Frame = travelling ? PinnedVisitorFrame : SectionFrame;

  const drawn = companion.slot ? (
    <div ref={companion.slot} style={ours} />
  ) : (
    <Herzie3D
      userId={OUR_SEED}
      stage={3}
      size={companionSize(wide)}
      cols={OUR_COLS}
      groundInset={8}
      equipped={outfitFor(PICKS.length)}
      defaultAngle={companion.angle}
      draggable={false}
      paused={!active}
      ariaLabel="Your herzie"
    />
  );
  // Room under it to match the visitor's speech bubble, so their feet line
  // up.
  const herzie = (
    <div className="flex flex-col">
      {drawn}
      <div className="h-12" />
    </div>
  );
  // Holds your herzie's width on the visitor's other side, so the visitor
  // stays in the middle. Phones haven't the room, so there it's dropped.
  const spacer = (
    <div className="hidden md:block" style={{ width: ours.width }} />
  );

  return (
    <Frame ref={ref}>
      <div className="flex flex-col items-center gap-6">
        <SectionText preTitle={preTitle} title={title}>
          {children}
        </SectionText>

        {/* Pulled up into its own canvases' empty headroom (they're tall,
            and the characters stand at the bottom), so the characters sit
            close under the copy. The canvases are see-through and take no
            clicks, so the overlap hides nothing. */}
        <div className="-mt-28 flex items-end justify-center gap-4 md:-mt-40 md:gap-8">
          {companion.side === "left" ? herzie : spacer}
          <div data-reveal={from} className="flex flex-col items-center">
            <Herzie3D
              userId={seed}
              stage={stage}
              size={wide ? size.wide : size.narrow}
              cols={48}
              groundInset={8}
              equipped={equipped}
              creatureParams={creatureParams}
              animate={false}
              defaultAngle={-DEFAULT_Y_ANGLE}
              draggable={false}
              paused={!active}
              ariaLabel={name}
            />
            {/* The bubble pins to the bottom of its box, tail up at the
                visitor; the box holds its room so nothing jumps. */}
            <div className="relative h-12 w-48 max-w-full">
              <SpeechBubble line={shown > 0 ? line : null} typed={shown} />
            </div>
          </div>
          {companion.side === "right" ? herzie : spacer}
        </div>
      </div>
    </Frame>
  );
}

/** Song hunts: Orphiez, who has lost a song, with your herzie on his left,
 * turned toward him. */
export function SongHuntSection({
  slot,
}: {
  slot?: RefObject<HTMLDivElement | null>;
}) {
  const orphiez = VISITORS.song_hunt;
  return (
    <VisitorSection
      preTitle="Song hunts"
      title="Find hidden songs"
      name={orphiez.name}
      line="I can't find this song!"
      seed={orphiez.seed ?? "npc:orphiez"}
      stage={2}
      equipped={ORPHIEZ_EQUIPPED}
      size={{ wide: 6, narrow: 4 }}
      from="right"
      companion={{ side: "left", angle: FACE_RIGHT, slot }}
    >
      <p>
        {orphiez.name} has lost a song. Crack his clues and play it. The first
        to find it get a reward.
      </p>
    </VisitorSection>
  );
}

/** Boss fights: a boss, drawn bigger since it's meant to loom, with your
 * herzie on its right, turned toward it. */
export function BossFightSection({
  slot,
}: {
  slot?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <VisitorSection
      preTitle="Boss fights"
      title="Fight bosses"
      name="The boss"
      line="I hate music!!"
      seed={BOSS_SEED}
      stage={3}
      creatureParams={BOSS_PARAMS}
      size={{ wide: 6.5, narrow: 4.2 }}
      from="left"
      companion={{ side: "right", angle: FACE_LEFT, slot }}
    >
      <p>
        Something is tearing through town. Work together to beat it before it
        gets away.
      </p>
    </VisitorSection>
  );
}
