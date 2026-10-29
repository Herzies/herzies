"use client";

import {
  CLASS_DEFS,
  CLASS_IDS,
  CLASS_ROLE_LABELS,
  type Equipped,
  type EquippedSlot,
} from "@herzies/shared";
import { HerzieView, islandScenery } from "@herzies/shared/gl";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useWide } from "@/components/landing/useWide";
import Link from "@/components/page-loader/Link";
import { cn } from "@/lib/utils";
import { CollectScene } from "./CollectScene";
import { HangOutScene } from "./HangOutScene";
import {
  ISLAND_COLS,
  ISLAND_DISTANCE,
  ISLAND_GROUND,
  ISLAND_TILT,
  ISLAND_ZOOM,
  islandBox,
} from "./island";
import { useSceneStage } from "./sceneStage";

/** The herzie both sections draw, so it's the same one grown up. */
const SEED = "landing-listen";
/** The friend who drops by in Hang out. */
const FRIEND_SEED = "about-friend";

/** What each slot can hold while the herzie tries things on (undefined:
 * empty). Wearables, skins and instruments only: no accessories or
 * spirits. */
const WARDROBE: Partial<Record<EquippedSlot, (string | undefined)[]>> = {
  head: ["headphones", "rainbow-headband", "witch-hat", undefined],
  face: ["fangs", undefined],
  body: ["gold-chain", "pearl-necklace", "bowtie", undefined],
  color: [
    "prism",
    "pumpkin-spice",
    "poseidons-gift",
    "purple-dane",
    "thanks-for-all-the-fish",
    undefined,
  ],
  main_hand: ["lute", "compact-discs", "worn-stick", undefined],
  off_hand: ["old-cymbal", undefined],
};
/** Slots picked in proportion to how much they hold, so the skin and hats
 * change more often than the fangs. */
const SLOT_PICKS = (Object.keys(WARDROBE) as EquippedSlot[]).flatMap((slot) =>
  Array(WARDROBE[slot]?.length ?? 0).fill(slot),
) as EquippedSlot[];
/** What it starts in. */
const START: Equipped = { head: "headphones", body: "gold-chain" };
/** How often one slot changes (ms). */
const SWAP_MS = 200;
/** How fast it turns (radians a second). */
const SPIN = 1.2;
/** A herzie on its own little island (see islandScenery). */
function IslandHerzie({
  size,
  label,
  ...props
}: Omit<
  React.ComponentProps<typeof HerzieView>,
  | "userId"
  | "cols"
  | "zoom"
  | "groundInset"
  | "scenery"
  | "distance"
  | "tilt"
  | "onStage"
> & { size: number; label: string }) {
  const scenery = useMemo(() => islandScenery(), []);
  const [stage, host] = useSceneStage();
  const { height } = islandBox(size);
  return (
    // The scene's own canvas fills this box (see useSceneStage).
    <div ref={host} className="relative">
      <HerzieView
        userId={SEED}
        size={size}
        cols={ISLAND_COLS}
        zoom={ISLAND_ZOOM}
        distance={ISLAND_DISTANCE}
        tilt={ISLAND_TILT}
        groundInset={height * ISLAND_GROUND}
        scenery={scenery}
        ariaLabel={label}
        onStage={stage}
        {...props}
      />
    </div>
  );
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** One slot of `equipped` changed to something else it can hold. */
function swapOne(equipped: Equipped): Equipped {
  const slot = pick(SLOT_PICKS);
  const options = (WARDROBE[slot] ?? []).filter((id) => id !== equipped[slot]);
  const next = { ...equipped, [slot]: pick(options) };
  if (next[slot] === undefined) delete next[slot];
  return next;
}

/** Whether the element is on screen, for pausing the herzies that aren't. */
function useOnScreen(ref: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setOn(entry.isIntersecting),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return on;
}

/** One section: an eyebrow and a line of copy, with its media beside it on
 * wide screens (on the `flip` side) and under it on phones. */
function Section({
  eyebrow,
  text,
  flip = false,
  media,
}: {
  eyebrow: string;
  text: React.ReactNode;
  flip?: boolean;
  media?: (active: boolean) => React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useOnScreen(ref);
  return (
    <section
      ref={ref}
      className={cn(
        "grid items-center gap-6",
        media && "md:grid-cols-2 md:gap-12",
      )}
    >
      <div
        className={cn(
          "text-center",
          media && (flip ? "md:order-2 md:text-left" : "md:text-left"),
        )}
      >
        <p className="mb-2 text-sm uppercase tracking-widest text-text-dim">
          {eyebrow}
        </p>
        <p className="text-lg leading-snug text-text md:text-xl">{text}</p>
      </div>
      {media && <div className="flex justify-center">{media(active)}</div>}
    </section>
  );
}

/** How long each class is shown (ms). */
const CLASS_MS = 2200;
/** Each class's gear, in hand: its instrument, and the Percussionist's
 * cymbal in the other. */
const CLASS_GEAR = CLASS_IDS.map((id) => {
  const [main, off] = CLASS_DEFS[id].equipment;
  const equipped: Equipped = { main_hand: main };
  if (off) equipped.off_hand = off;
  return { def: CLASS_DEFS[id], equipped };
});

/** The stage 3 herzie as each class in turn, its class's gear in hand, the
 * class named underneath. */
function Classes({ active, size }: { active: boolean; size: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % CLASS_GEAR.length),
      CLASS_MS,
    );
    return () => clearInterval(id);
  }, [active]);
  const { def, equipped } = CLASS_GEAR[index];
  return (
    <div className="flex flex-col items-center gap-2">
      <IslandHerzie
        stage={3}
        size={size}
        equipped={equipped}
        armed
        defaultAngle={-0.8}
        paused={!active}
        label={`A stage 3 herzie as a ${def.name}`}
      />
      <p className="text-sm text-text">
        {def.name}{" "}
        <span className="text-text-dim">· {CLASS_ROLE_LABELS[def.role]}</span>
      </p>
    </div>
  );
}

/** The stage 3 herzie turning round, swapping one thing at a time. */
function Wardrobe({ active, size }: { active: boolean; size: number }) {
  const [equipped, setEquipped] = useState(START);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setEquipped(swapOne), SWAP_MS);
    return () => clearInterval(id);
  }, [active]);
  return (
    <IslandHerzie
      stage={3}
      size={size}
      equipped={equipped}
      spin={SPIN}
      draggable={false}
      paused={!active}
      label="A stage 3 herzie turning round, trying on items"
    />
  );
}

export function AboutSections() {
  const wide = useWide();
  const size = wide ? 5.4 : 3.9;
  return (
    <div className="flex flex-col gap-24 md:gap-32">
      <Section
        eyebrow="Listen and grow"
        text="Listen to music to grow your herzie"
        media={(active) => (
          <IslandHerzie
            stage={1}
            size={size}
            isPlaying
            paused={!active}
            label="A stage 1 herzie dancing"
          />
        )}
      />
      <Section
        eyebrow="Collect"
        flip
        text="Items drop while you listen to music. Collect them, use them, or trade them with other herzies"
        media={(active) => (
          <CollectScene seed={SEED} size={size} active={active} />
        )}
      />
      <Section
        eyebrow="Customize"
        text="Make your herzie unique. Items give different stats and effects"
        media={(active) => <Wardrobe active={active} size={size} />}
      />
      <Section
        eyebrow="Pick a class"
        text="Heal your friends as a Bard, deal damage as a Record Slinger, or take the hits as a Percussionist. Each class plays its own instrument and has its own skills."
        flip
        media={(active) => <Classes active={active} size={size} />}
      />
      <Section
        eyebrow="Join events"
        text={
          <>
            Join boss raids and song hunts to receive rewards and compete
            against other herzies. See how you're doing in the{" "}
            <Link href="/leaderboard" className="text-yellow">
              leaderboard
            </Link>
            .
          </>
        }
      />
      <Section
        eyebrow="Hang out"
        text="Relax, listen to music, and chat with others"
        media={(active) => (
          <HangOutScene
            listenerSeed={SEED}
            visitorSeed={FRIEND_SEED}
            size={size}
            active={active}
          />
        )}
      />
    </div>
  );
}
