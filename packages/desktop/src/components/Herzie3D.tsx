import {
  type BoomboxConfig,
  type CreatureParams,
  type Equipped,
  equippedItemIds,
  ITEM_SETS,
  Herzie3D as SharedHerzie3D,
  Sky,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { useWindowVisible } from "../tauri-bridge";

// Only one set has a visual effect today; look it up by id rather than
// generalizing to "any fully-equipped set" until a second one exists.
const PRISMATIC_SET = ITEM_SETS.find((set) => set.id === "prismatic");

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
  showSky?: boolean;
  draggable?: boolean;
  /** Pause animation regardless of window visibility (e.g. tab hidden). */
  paused?: boolean;
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
  showSky = true,
  draggable,
  paused: pausedProp = false,
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
  const scenery = ids.includes("stars")
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
        draggable={draggable}
        paused={paused}
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
