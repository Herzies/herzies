"use client";

import { Herzie3D } from "@herzies/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { CollectSection, collectHerzieSize } from "./CollectSection";
import { gsap, ScrollTrigger, useGSAP } from "./gsap";
import {
  canvasSize,
  FACE_LEFT,
  FACE_RIGHT,
  OUR_COLS,
  OUR_SEED,
  outfitFor,
} from "./journey";
import { ListenSection } from "./ListenSection";
import { ShareSection } from "./ShareSection";
import { useMotionOK } from "./useMotionOK";
import { useWide } from "./useWide";
import { BossFightSection, SongHuntSection } from "./VisitorSection";

/** A point on a placeholder: the middle of its bottom edge, where the
 * herzie's feet go — plus how much the herzie has to scale to its height. */
function footing(el: HTMLElement, herzieHeight: number) {
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.bottom,
    scale: r.height / herzieHeight,
  };
}

/** How finely the herzie's turn follows the scroll: Herzie3D redraws for
 * every new angle, so it turns in small steps rather than continuously. */
const TURN_STEP = 0.05;

/**
 * The sections your herzie walks through: it grows up in Listen, follows
 * you down to stand beside the cards in Collect while they're placed —
 * putting on each card's item as it lands — then goes on to stand by
 * Orphiez in the song hunt, and by the boss in the boss fight, turned
 * toward each — and ends up between two friends in Discover, dancing to the
 * song one of them shares.
 *
 * It is one herzie on a fixed layer over the page, kept over a placeholder
 * in each section in turn: it eases from one placeholder to the next as the
 * next section scrolls in, and in between stands over the current one,
 * scrolling with it. After Discover it leaves with that section.
 *
 * With reduced motion, every section simply draws its own herzie.
 */
export function HerzieJourney() {
  const motion = useMotionOK();
  const wide = useWide();
  const [placed, setPlaced] = useState(0);
  const [onScreen, setOnScreen] = useState(false);

  const listenSlot = useRef<HTMLDivElement>(null);
  const collectSlot = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const grow = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const huntSlot = useRef<HTMLDivElement>(null);
  const bossSlot = useRef<HTMLDivElement>(null);
  const collectTop = useRef<HTMLDivElement>(null);
  const huntTop = useRef<HTMLDivElement>(null);
  const bossTop = useRef<HTMLDivElement>(null);
  const shareSlot = useRef<HTMLDivElement>(null);
  const shareTop = useRef<HTMLDivElement>(null);
  const [dancing, setDancing] = useState(false);
  const [angle, setAngle] = useState(0);

  const size = collectHerzieSize(wide);
  const { width, height } = canvasSize(size, OUR_COLS);

  // Stable, so the sections' animations aren't rebuilt on every render.
  const listenTravel = useMemo(
    () => (motion ? { slot: listenSlot, grow } : undefined),
    [motion],
  );
  const collectTravel = useMemo(
    () =>
      motion
        ? {
            slot: collectSlot,
            onPlaced: setPlaced,
          }
        : undefined,
    [motion],
  );

  const shareTravel = useMemo(
    () => (motion ? { slot: shareSlot, onDancing: setDancing } : undefined),
    [motion],
  );

  // A card just landed: a little hop as its item goes on.
  const lastPlaced = useRef(0);
  useEffect(() => {
    if (placed > lastPlaced.current && pop.current) {
      gsap.fromTo(
        pop.current,
        { scale: 1.12 },
        { scale: 1, duration: 0.4, ease: "back.out(3)" },
      );
    }
    lastPlaced.current = placed;
  }, [placed]);

  useGSAP(
    () => {
      if (!motion) return;
      // The stops, in order: where the herzie stands in each section, and
      // which way it faces there.
      const stops = [
        { slot: listenSlot, angle: 0 },
        { slot: collectSlot, angle: 0 },
        { slot: huntSlot, angle: FACE_RIGHT },
        { slot: bossSlot, angle: FACE_LEFT },
        { slot: shareSlot, angle: 0 },
      ];
      // One leg per stop after the first, 0 to 1 while the section it ends
      // in scrolls from low on the screen up to the top.
      const legs = [collectTop, huntTop, bossTop, shareTop].map((section) => {
        const leg = { progress: 0 };
        gsap.to(leg, {
          progress: 1,
          ease: "power1.inOut",
          scrollTrigger: {
            trigger: section.current,
            start: "top 80%",
            end: "top top",
            scrub: 0.6,
          },
        });
        return leg;
      });

      let shown = false;
      let turned = 0;
      const follow = () => {
        const el = layer.current;
        const els = stops.map((stop) => stop.slot.current);
        if (!el || els.some((slot) => !slot)) return;
        // Start at the first stop, and walk each leg as far as it's got.
        let at = { ...footing(els[0] as HTMLElement, height), angle: 0 };
        legs.forEach((leg, i) => {
          const next = {
            ...footing(els[i + 1] as HTMLElement, height),
            angle: stops[i + 1].angle,
          };
          const t = leg.progress;
          at = {
            x: at.x + (next.x - at.x) * t,
            y: at.y + (next.y - at.y) * t,
            scale: at.scale + (next.scale - at.scale) * t,
            angle: at.angle + (next.angle - at.angle) * t,
          };
        });
        el.style.transform = `translate(${at.x - width / 2}px, ${at.y - height}px) scale(${at.scale})`;
        const turn = Math.round(at.angle / TURN_STEP) * TURN_STEP;
        if (turn !== turned) {
          turned = turn;
          setAngle(turn);
        }
        const visible =
          at.y > 0 && at.y - height * at.scale < window.innerHeight;
        if (visible !== shown) {
          shown = visible;
          setOnScreen(visible);
        }
      };
      follow();
      gsap.ticker.add(follow);
      // Listen and Collect have just grown several screens tall, so every
      // scroll trigger further down the page (reveals, the visitors'
      // speech) was measured against the old layout.
      ScrollTrigger.refresh();
      return () => gsap.ticker.remove(follow);
    },
    { dependencies: [motion, width, height], revertOnUpdate: true },
  );

  return (
    <>
      {/* First, though it's fixed and could sit anywhere: React attaches
          refs in order, so this way `grow` is already set when
          ListenSection builds the animation that grows it. */}
      {motion && (
        <div
          ref={layer}
          aria-hidden="true"
          className="pointer-events-none fixed top-0 left-0 z-20 origin-bottom"
          style={{ width, height }}
        >
          <div ref={grow}>
            <div ref={pop} className="origin-bottom">
              <Herzie3D
                userId={OUR_SEED}
                stage={3}
                size={size}
                cols={OUR_COLS}
                groundInset={8}
                equipped={outfitFor(placed)}
                defaultAngle={angle}
                // Dancing is the app's own: it needs the turntable spin on.
                animate={dancing}
                isPlaying={dancing}
                draggable={false}
                paused={!onScreen}
              />
            </div>
          </div>
        </div>
      )}
      <ListenSection travel={listenTravel} />
      <div ref={collectTop}>
        <CollectSection travel={collectTravel} />
      </div>
      <div ref={huntTop}>
        <SongHuntSection slot={motion ? huntSlot : undefined} />
      </div>
      <div ref={bossTop}>
        <BossFightSection slot={motion ? bossSlot : undefined} />
      </div>
      <div ref={shareTop}>
        <ShareSection travel={shareTravel} />
      </div>
    </>
  );
}
