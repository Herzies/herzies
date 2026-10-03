import {
  type BoomboxConfig,
  type CreatureParams,
  type DangleConfig,
  type Equipped,
  equippedItemIds,
  ITEM_SETS,
  SH,
  Herzie3D as SharedHerzie3D,
  Sky,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { useWindowVisible } from "../tauri-bridge";

// Each set's effect is its own overlay below, so they're looked up by id.
const PRISMATIC_SET = ITEM_SETS.find((set) => set.id === "prismatic");
const HAUNTED_SET = ITEM_SETS.find((set) => set.id === "haunted");

/** The height of the herzie's stage on Home and on the Herzie view — the same
 * in both, so the creature sits in the same place when switching between
 * them. At most 262px, what Home has left once its header, XP bar,
 * now-playing slot and collapsed chat (all fixed-height, the chat's input row
 * included) have taken theirs; Home's spacer takes up the rest. */
export const HERZIE_STAGE_HEIGHT = 240;

/** How far above the stage's bottom edge a grounded herzie's feet sit — level
 * with dropped items, which sit at the stage's `bottom-2`. */
const STAGE_FLOOR_INSET = 6;

interface Props {
  userId: string;
  stage?: number;
  size?: number;
  animate?: boolean;
  isPlaying?: boolean;
  equipped?: Equipped;
  /** @deprecated Prefer `equipped`. */
  wearables?: string[];
  creatureParams?: CreatureParams;
  boomboxConfig?: BoomboxConfig;
  dangleConfig?: DangleConfig;
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
}

/**
 * Desktop-tuned composition of the shared Sky + Herzie3D primitives.
 *
 * The Tauri window is fixed-size (380×520, borderless), so the sky is anchored
 * to the window's top edge and the drag area spans the full window width.
 */
export function Herzie3D({
  userId,
  stage = 1,
  size = 5,
  animate,
  isPlaying = false,
  equipped,
  wearables,
  creatureParams,
  boomboxConfig,
  dangleConfig,
  showSky = true,
  draggable,
  paused: pausedProp = false,
  grounded = false,
  zoom,
  offsetY,
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

  const visible = useWindowVisible();
  const paused = !visible || pausedProp;

  const ids = equipped ? equippedItemIds(equipped) : (wearables ?? []);
  const scenery = ids.includes("blood-moon")
    ? "blood-moon"
    : ids.includes("stars")
      ? "stars"
      : ids.includes("clouds")
        ? "clouds"
        : null;
  const prismaticActive =
    !!PRISMATIC_SET && PRISMATIC_SET.itemIds.every((id) => ids.includes(id));
  const hauntedActive =
    !!HAUNTED_SET && HAUNTED_SET.itemIds.every((id) => ids.includes(id));

  // Fades the bottom of the prismatic layer into transparency (revealing
  // the app's own background underneath, whatever that is, rather than
  // painting a specific colour over it) instead of cutting off hard.
  const prismaticMask =
    "linear-gradient(to bottom, black 0%, black 40%, transparent 85%)";

  return (
    <>
      {showSky && prismaticActive && (
        <div
          aria-hidden="true"
          className="animate-prismatic pointer-events-none fixed"
          style={{
            top: 0,
            left: 0,
            width: "100vw",
            height: "45vh",
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
      {showSky && hauntedActive && (
        // Fog from the bottom of the window, the opposite end from the
        // prismatic glow: purple haze over a low orange glow.
        <div
          aria-hidden="true"
          className="animate-haunted-fog pointer-events-none fixed"
          style={{
            bottom: 0,
            left: 0,
            width: "100vw",
            height: "40vh",
            background:
              "radial-gradient(ellipse at 30% 100%, #8E6FB0 0%, transparent 60%), radial-gradient(ellipse at 75% 100%, #F27B13 0%, transparent 55%)",
            backgroundSize: "160% 100%",
            mixBlendMode: "screen",
            zIndex: 0,
          }}
        />
      )}
      {showSky && (
        <Sky
          userId={userId}
          isPlaying={isPlaying}
          cols={windowCols}
          variant={scenery}
          size={size}
          paused={paused || animate === false}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            zIndex: 0,
          }}
        />
      )}
      <SharedHerzie3D
        userId={userId}
        stage={stage}
        size={size}
        cols={showSky ? windowCols : undefined}
        animate={animate}
        isPlaying={isPlaying}
        equipped={equipped}
        wearables={wearables}
        creatureParams={creatureParams}
        boomboxConfig={boomboxConfig}
        dangleConfig={dangleConfig}
        draggable={draggable}
        paused={paused}
        groundInset={grounded ? groundInsetFor(size) : undefined}
        zoom={zoom}
        offsetY={offsetY}
        wrapperStyle={
          showSky
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
 * the floor inset above the canvas bottom. Must match the shared Herzie3D's
 * canvas sizing (SH rows of size * 1.35 px). */
function groundInsetFor(size: number): number {
  const canvasH = Math.ceil(SH * size * 1.35);
  return (canvasH - HERZIE_STAGE_HEIGHT) / 2 + STAGE_FLOOR_INSET;
}
