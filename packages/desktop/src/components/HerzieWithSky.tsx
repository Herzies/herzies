import {
  type CreatureParams,
  type DangleConfig,
  type Equipped,
  equippedItemIds,
  ITEM_SETS,
  SH,
  Sky,
  type ThreadConfig,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useHerzieStage } from "../lib/overlayStage";
import { useWindowFocused } from "../tauri-bridge";

// Each set's effect is its own overlay below, so they're looked up by id.
const PRISMATIC_SET = ITEM_SETS.find((set) => set.id === "prismatic");

/** The height of the herzie's stage on Home and on the Herzie view — the same
 * in both, so the creature sits in the same place when switching between
 * them. At most 262px, what Home has left once its header, XP bar,
 * now-playing slot and collapsed chat (all fixed-height, the chat's input row
 * included) have taken theirs; Home's spacer takes up the rest. */
export const HERZIE_STAGE_HEIGHT = 240;

/** How far above the stage's bottom edge a grounded herzie's feet sit — a
 * little above dropped items, which sit at the stage's `bottom-2`. */
const STAGE_FLOOR_INSET = 24;

/** The app window's width when not expanded (tauri.conf.json). */
const SMALL_WINDOW_WIDTH = 380;

interface Props {
  userId: string;
  stage?: number;
  size?: number;
  animate?: boolean;
  isPlaying?: boolean;
  equipped?: Equipped;
  creatureParams?: CreatureParams;
  dangleConfig?: DangleConfig;
  threadConfig?: ThreadConfig;
  showSky?: boolean;
  draggable?: boolean;
  /** Pause animation regardless of window visibility (e.g. tab hidden). */
  paused?: boolean;
  /** Stand the herzie on the bottom of a HERZIE_STAGE_HEIGHT stage (it must
   * be centred in one) instead of centring it. */
  grounded?: boolean;
  /** Camera zoom about the herzie's centre; eases to a new value. Default: 1. */
  zoom?: number;
  /** Camera pan in px (negative: up); eases along with `zoom`. Default: 0. */
  offsetY?: number;
  /** How quickly the camera eases to a new `zoom`/`offsetY` (HerzieView). */
  zoomEase?: number;
  /** Class gear drawn into its hands instead of slung on its back. */
  armed?: boolean;
}

/**
 * Desktop-tuned composition of the shared Sky + HerzieView.
 *
 * The Tauri window is fixed-size (380×520, borderless), so the sky is anchored
 * to the window's top edge and the drag area spans the full window width.
 */
export function HerzieWithSky({
  userId,
  stage = 1,
  size = 5,
  animate,
  isPlaying = false,
  equipped,
  creatureParams,
  dangleConfig,
  threadConfig,
  showSky: showSkyProp = true,
  draggable,
  paused: pausedProp = false,
  grounded = false,
  zoom,
  offsetY,
  zoomEase,
  armed,
}: Props) {
  // Full-window-width column count, shared by the sky and the creature
  // viewport so both span the window without stretching their contents.
  const [windowCols, setWindowCols] = useState(() =>
    Math.floor(window.innerWidth / (size * 0.6)),
  );

  useEffect(() => {
    const onResize = () => {
      setWindowCols(Math.floor(window.innerWidth / (size * 0.6)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  // Inside an overlay window the herzie draws on the window's stage, and
  // its sky goes into the window's panel (portalled into its sky slot,
  // spanning the panel) instead of fixed across the whole app window.
  const { stage: onStage, inOverlay, skySlot } = useHerzieStage();
  const showSky = showSkyProp && (!inOverlay || !!skySlot);
  const panelWidth = skySlot?.clientWidth ?? 0;
  const skyCols =
    inOverlay && panelWidth > 0
      ? Math.floor(panelWidth / (size * 0.6))
      : windowCols;
  const skyBox: React.CSSProperties = inOverlay
    ? { position: "absolute", top: 0, left: 0, width: "100%" }
    : { position: "fixed", top: 0, left: 0, width: "100vw" };

  const focused = useWindowFocused();
  const paused = !focused || pausedProp;

  const ids = equipped ? equippedItemIds(equipped) : [];
  const scenery = ids.includes("blood-moon")
    ? "blood-moon"
    : ids.includes("stars")
      ? "stars"
      : ids.includes("clouds")
        ? "clouds"
        : null;
  const prismaticActive =
    !!PRISMATIC_SET && PRISMATIC_SET.itemIds.every((id) => ids.includes(id));

  // Fades the bottom of the prismatic layer into transparency (revealing
  // the app's own background underneath, whatever that is, rather than
  // painting a specific colour over it) instead of cutting off hard.
  const prismaticMask =
    "linear-gradient(to bottom, black 0%, black 40%, transparent 85%)";

  const sky = (
    <>
      {showSky && prismaticActive && (
        <div
          aria-hidden="true"
          className="animate-prismatic pointer-events-none"
          style={{
            ...skyBox,
            height: inOverlay ? "45%" : "45vh",
            background:
              "linear-gradient(120deg, #ff5f6d, #ffc371, #f9f871, #6dffb0, #6dc9ff, #a06dff, #ff6df3)",
            backgroundSize: "220% 220%",
            opacity: 0.1,
            mixBlendMode: "screen",
            WebkitMaskImage: prismaticMask,
            maskImage: prismaticMask,
            zIndex: 0,
          }}
        />
      )}
      {showSky && (
        <Sky
          userId={userId}
          isPlaying={isPlaying}
          cols={skyCols}
          variant={scenery}
          size={size}
          paused={paused || animate === false}
          style={{ ...skyBox, zIndex: 0 }}
        />
      )}
    </>
  );

  return (
    <>
      {inOverlay && skySlot ? createPortal(sky, skySlot) : sky}
      <HerzieView
        userId={userId}
        stage={stage}
        size={size}
        // Spanning the app window, matching the sky's columns. The columns
        // also set how big the herzie is drawn, so inside an overlay window
        // it's laid out for the app's small window (as Home is), whatever
        // the window's size; the panel clips the overflow.
        cols={
          inOverlay
            ? Math.floor(SMALL_WINDOW_WIDTH / (size * 0.6))
            : showSky
              ? windowCols
              : undefined
        }
        animate={animate}
        isPlaying={isPlaying}
        equipped={equipped}
        creatureParams={creatureParams}
        dangleConfig={dangleConfig}
        threadConfig={threadConfig}
        draggable={draggable}
        paused={paused}
        groundInset={grounded ? groundInsetFor(size) : undefined}
        zoom={zoom}
        offsetY={offsetY}
        zoomEase={zoomEase}
        armed={armed}
        onStage={onStage}
        wrapperStyle={
          showSky && !inOverlay
            ? {
                position: "relative",
                width: "100vw",
                marginLeft: "calc(-50vw + 50%)",
              }
            : undefined
        }
      />
    </>
  );
}

/** The canvas is taller than the stage and centred on it, so its bottom edge
 * hangs (canvasH - stage) / 2 below the stage's. The feet go that far plus
 * the floor inset above the canvas bottom. Must match HerzieView's
 * box sizing (SH rows of size * 1.35 px). */
function groundInsetFor(size: number): number {
  const canvasH = Math.ceil(SH * size * 1.35);
  return (canvasH - HERZIE_STAGE_HEIGHT) / 2 + STAGE_FLOOR_INSET;
}
